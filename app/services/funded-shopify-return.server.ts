import { randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "../db.server";
import { createFundedSandbox, requireFundedSandbox } from "./funded-return-sandbox.server";
import {
  FundedConflictError,
  reserveFundedUnits,
  reservedFundedUnits,
} from "./funded-entitlements.server";
import { otherReturnReasonId } from "./return-reasons.server";
import { adminData, type AdminGraphql } from "./shopify-admin.server";

// Stage 2 of double-payment protection, as Reshop does it: the funded units get
// a real Shopify return, so Shopify itself stops treating them as returnable,
// and the order is tagged so staff and other apps can see Gooper funded it.
// Sandbox and development stores only; nothing here moves money.

export const FUNDED_TAG = "gooper-funded";
export const FUNDED_OPEN_TAG = "gooper-funded-open";
const MAX_SANDBOX_MINOR = 100_000;

// The case ID is written into the Shopify return's note, so a retry after an
// ambiguous failure finds the return it already created instead of a second one.
const caseMarker = (caseId: string) => `Gooper funded case ${caseId}`;

function toMinor(amount: string) {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) throw new FundedConflictError(`Unsupported amount: ${amount}`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

type Money = { amount: string; currencyCode: string };
type OrderLine = {
  id: string;
  title: string;
  quantity: number;
  discountedUnitPriceAfterAllDiscountsSet: { presentmentMoney: Money };
};
type FundedOrder = {
  id: string;
  name: string;
  presentmentCurrencyCode: string;
  tags: string[];
  lineItems: { nodes: OrderLine[] };
  returns: {
    nodes: Array<{
      id: string;
      status: string;
      returnLineItems: { nodes: Array<{ returnReasonNote: string | null }> };
    }>;
  };
};

const ORDER_QUERY = `#graphql
  query FundedOrder($id: ID!) {
    order(id: $id) {
      id
      name
      presentmentCurrencyCode
      tags
      lineItems(first: 50) {
        nodes {
          id
          title
          quantity
          discountedUnitPriceAfterAllDiscountsSet { presentmentMoney { amount currencyCode } }
        }
      }
      returns(first: 20) {
        nodes {
          id
          status
          returnLineItems(first: 50) {
            nodes { ... on ReturnLineItem { returnReasonNote } }
          }
        }
      }
    }
    returnableFulfillments(orderId: $id, first: 10) {
      nodes {
        returnableFulfillmentLineItems(first: 50) {
          nodes { quantity fulfillmentLineItem { id lineItem { id } } }
        }
      }
    }
  }
`;

const RECENT_ORDERS_QUERY = `#graphql
  query FundedOrderCandidates {
    orders(first: 10, sortKey: PROCESSED_AT, reverse: true) {
      nodes {
        id
        name
        presentmentCurrencyCode
        lineItems(first: 20) { nodes { id title quantity } }
      }
    }
  }
`;

const RETURN_CREATE = `#graphql
  mutation CreateFundedReturn($returnInput: ReturnInput!) {
    returnCreate(returnInput: $returnInput) {
      return { id status }
      userErrors { field message }
    }
  }
`;

const TAGS_ADD = `#graphql
  mutation TagFundedOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

type Returnable = Map<string, Array<{ id: string; quantity: number }>>;

async function readOrder(admin: AdminGraphql, orderId: string) {
  const data = await adminData<{
    order: FundedOrder | null;
    returnableFulfillments: {
      nodes: Array<{
        returnableFulfillmentLineItems: {
          nodes: Array<{
            quantity: number;
            fulfillmentLineItem: { id: string; lineItem: { id: string } };
          }>;
        };
      }>;
    };
  }>(admin, ORDER_QUERY, { id: orderId }, "Shopify could not read this order.");
  if (!data.order) throw new FundedConflictError("That order isn't in this store.");
  const returnable: Returnable = new Map();
  for (const fulfillment of data.returnableFulfillments.nodes)
    for (const entry of fulfillment.returnableFulfillmentLineItems.nodes) {
      if (entry.quantity < 1) continue;
      const key = entry.fulfillmentLineItem.lineItem.id;
      returnable.set(key, [
        ...(returnable.get(key) ?? []),
        { id: entry.fulfillmentLineItem.id, quantity: entry.quantity },
      ]);
    }
  return { order: data.order, returnable };
}

// Orders a merchant can start a sandbox case from, for the sandbox screen.
export async function fundedOrderCandidates(admin: AdminGraphql) {
  requireFundedSandbox();
  const data = await adminData<{
    orders: {
      nodes: Array<{
        id: string;
        name: string;
        presentmentCurrencyCode: string;
        lineItems: { nodes: Array<{ id: string; title: string; quantity: number }> };
      }>;
    };
  }>(admin, RECENT_ORDERS_QUERY, {}, "Shopify could not list recent orders.");
  return data.orders.nodes
    .filter((order) => ["CAD", "USD"].includes(order.presentmentCurrencyCode))
    .map((order) => ({
      id: order.id,
      name: order.name,
      currency: order.presentmentCurrencyCode,
      lineItems: order.lineItems.nodes,
    }));
}

function userErrorText(errors: Array<{ message: string }>) {
  return errors.map((error) => error.message).join("; ");
}

// Creates (or finds) the OPEN Shopify return holding the funded units, records
// it on the reserved units, and tags the order. Safe to call again.
export async function attachShopifyReturn({
  admin,
  shop,
  caseId,
}: {
  admin: AdminGraphql;
  shop: string;
  caseId: string;
}) {
  requireFundedSandbox();
  const units = await prisma.fundedEntitlement.findMany({
    where: { shop, caseId, status: "ACTIVE" },
  });
  if (!units.length)
    throw new FundedConflictError("This case has no reserved order items.");
  const orderId = units[0].orderId;
  const attached = units.find((unit) => unit.shopifyReturnId);
  if (attached && units.every((unit) => unit.shopifyReturnId === attached.shopifyReturnId))
    return attached.shopifyReturnId!;

  const { order, returnable } = await readOrder(admin, orderId);
  const marker = caseMarker(caseId);
  let returnId = order.returns.nodes.find(
    (existing) =>
      existing.status !== "CANCELED" &&
      existing.returnLineItems.nodes.some((line) => line.returnReasonNote === marker),
  )?.id;

  if (!returnId) {
    const returnLineItems = units.flatMap((unit) => {
      let remaining = unit.quantity;
      const allocated: Array<{ fulfillmentLineItemId: string; quantity: number }> = [];
      for (const line of returnable.get(unit.lineItemId) ?? []) {
        if (!remaining) break;
        const quantity = Math.min(remaining, line.quantity);
        allocated.push({ fulfillmentLineItemId: line.id, quantity });
        remaining -= quantity;
      }
      if (remaining)
        throw new FundedConflictError(
          "Shopify no longer shows these items as returnable, so no return was created.",
        );
      return allocated;
    });
    const returnReasonDefinitionId = await otherReturnReasonId(shop, admin);
    const { returnCreate } = await adminData<{
      returnCreate: {
        return: { id: string; status: string } | null;
        userErrors: Array<{ message: string }>;
      };
    }>(
      admin,
      RETURN_CREATE,
      {
        returnInput: {
          orderId,
          notifyCustomer: false,
          returnLineItems: returnLineItems.map((line) => ({
            ...line,
            returnReasonDefinitionId,
            returnReasonNote: marker,
          })),
        },
      },
      "Shopify could not create the return.",
    );
    if (returnCreate.userErrors.length || !returnCreate.return)
      throw new FundedConflictError(
        `Shopify didn't create the return: ${userErrorText(returnCreate.userErrors) || "no return returned"}.`,
      );
    returnId = returnCreate.return.id;
  }

  await prisma.fundedEntitlement.updateMany({
    where: { shop, caseId, status: "ACTIVE", shopifyReturnId: null },
    data: { shopifyReturnId: returnId, version: { increment: 1 } },
  });
  const { tagsAdd } = await adminData<{
    tagsAdd: { userErrors: Array<{ message: string }> };
  }>(
    admin,
    TAGS_ADD,
    { id: orderId, tags: [FUNDED_TAG, FUNDED_OPEN_TAG] },
    "Shopify could not tag the order.",
  );
  // Tags are for people and other apps; protection comes from the return and
  // the reserved units, so a tagging failure is reported but not fatal.
  if (tagsAdd.userErrors.length)
    console.warn(`Funded order tag failed: ${userErrorText(tagsAdd.userErrors)}`);
  return returnId;
}

// Starts a sandbox case from a real order line: checks Shopify's returnable
// quantity, prices the units from the order, reserves them, then creates the
// Shopify return. Reservation comes first so there is never a window in which
// Gooper has funded units that are still refundable the ordinary way.
export async function startFundedCaseFromOrder(input: {
  admin: AdminGraphql;
  shop: string;
  orderId: string;
  lineItemId: string;
  quantity: number;
}) {
  requireFundedSandbox();
  const { shop, orderId, lineItemId, quantity } = z
    .object({
      shop: z.string().min(1),
      orderId: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/),
      lineItemId: z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/),
      quantity: z.number().int().positive().max(1000),
    })
    .parse(input);
  const { order, returnable } = await readOrder(input.admin, orderId);
  const line = order.lineItems.nodes.find((candidate) => candidate.id === lineItemId);
  if (!line) throw new FundedConflictError("That item isn't on this order.");
  const currency = z
    .enum(["CAD", "USD"])
    .safeParse(line.discountedUnitPriceAfterAllDiscountsSet.presentmentMoney.currencyCode);
  if (!currency.success)
    throw new FundedConflictError("The sandbox only supports CAD and USD orders.");
  const available = (returnable.get(lineItemId) ?? []).reduce(
    (sum, entry) => sum + entry.quantity,
    0,
  );
  const alreadyFunded = (await reservedFundedUnits(shop, orderId))
    .filter((units) => units.lineItemId === lineItemId && !units.shopifyReturnId)
    .reduce((sum, units) => sum + units.quantity, 0);
  if (quantity > available - alreadyFunded)
    throw new FundedConflictError(
      "That many units aren't returnable in Shopify, or Gooper already funded them.",
    );
  const amountMinor =
    toMinor(line.discountedUnitPriceAfterAllDiscountsSet.presentmentMoney.amount) * quantity;
  if (amountMinor < 1 || amountMinor > MAX_SANDBOX_MINOR)
    throw new FundedConflictError("Sandbox cases must be between $0.01 and $1,000.");

  const caseId = randomUUID();
  await createFundedSandbox(shop, caseId, currency.data, {
    amountMinor,
    order: { orderId, orderName: order.name, lineItemId, title: line.title, quantity },
  });
  await reserveFundedUnits({ shop, caseId, orderId, items: [{ lineItemId, quantity }] });
  const returnId = await attachShopifyReturn({ admin: input.admin, shop, caseId });
  return { caseId, returnId };
}

// returns/* webhook. A funded return cancelled or declined outside Gooper makes
// its units returnable in Shopify again, so they go back to being subtracted by
// the refund guard and are flagged for review. Any close or process is also
// outside Gooper today, since Gooper never closes funded returns yet.
export async function flagFundedReturnChanges(
  transaction: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  shop: string,
  returnId: string,
  returnStatus: string,
) {
  if (!["CANCELLED", "CANCELED", "DECLINED", "CLOSED", "PROCESSED"].includes(returnStatus))
    return 0;
  const released = ["CANCELLED", "CANCELED", "DECLINED"].includes(returnStatus);
  const units = await transaction.fundedEntitlement.findMany({
    where: { shop, shopifyReturnId: returnId, status: { in: ["ACTIVE", "CONFLICT"] } },
  });
  for (const unit of units)
    await transaction.fundedEntitlement.updateMany({
      where: { id: unit.id, version: unit.version },
      data: {
        status: "CONFLICT",
        version: { increment: 1 },
        ...(released ? { shopifyReturnId: null } : {}),
        conflictReason: `Shopify marked funded return ${returnId} ${returnStatus.toLowerCase()} outside Gooper.${released ? " Its units are returnable in Shopify again and stay reserved by Gooper." : ""} Review before any recovery.`,
      },
    });
  return units.length;
}
