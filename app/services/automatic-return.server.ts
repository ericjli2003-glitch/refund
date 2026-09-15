import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { refundPaymentStatus } from "../refund-status";
import {
  CustomerAccountApiError,
  customerAccountGraphql,
} from "./customer-account.server";
import { customerIdentityHashes } from "./customer-security.server";
import { adminData, adminFor, type AdminGraphql } from "./shopify-admin.server";
import {
  calculateVerifiedReturn,
  requestVerifiedReturn,
  verifiedCustomerOrders,
  type CustomerAccess,
} from "./verified-customer-returns.server";
import {
  hasDuplicateLineItems,
  moneyAmountsMatch,
  moneyIsAbove,
  refundFromReturnTotal,
  ReturnNotCreatedError,
  sameReturnItems,
  type RequestedItem,
} from "./return-guards.server";
import {
  buildReturnProcessLineItems,
  resolveRestockLocation,
  type ReturnLineItemNode,
  type ReverseFulfillmentLineItemNode,
} from "./return-processing.server";
import {
  buildReturnApprovalVariables,
  buildReturnProcessTransactions,
  type SuggestedRefundTransaction,
} from "./shopify-inputs.server";

export type { RequestedItem } from "./return-guards.server";
export { adminData, adminFor, type AdminGraphql } from "./shopify-admin.server";

export type Money = { amount: string; currencyCode: string };
type UserError = { field?: string[]; message: string };

// IMMEDIATE refunds when the customer confirms; ON_RECEIPT approves the
// return then and refunds once the merchant marks the item received.
export type RefundTiming = "IMMEDIATE" | "ON_RECEIPT";
export const refundTimingOf = (value: string | null | undefined): RefundTiming =>
  value === "ON_RECEIPT" ? "ON_RECEIPT" : "IMMEDIATE";

export type ReturnableOrder = {
  id: string;
  name: string;
  processedAt: string;
  returnInformation: {
    nonReturnableSummary: { nonReturnableReasons: string[] } | null;
    returnableLineItems: {
      nodes: Array<{
        quantity: number;
        lineItem: {
          id: string;
          presentmentTitle: string;
          currentTotalPrice: Money;
        };
      }>;
    };
  };
};

type CustomerOrdersResponse = {
  customer: { id: string; orders: { nodes: ReturnableOrder[] } };
};

export type ReturnCalculation = {
  financialSummary: {
    returnTotalSet: { presentmentMoney: Money; shopMoney: Money };
    restockingFeeSubtotalSet?: { presentmentMoney: Money };
    returnShippingFeeSubtotalSet?: { presentmentMoney: Money };
  };
  returnLineItems: {
    nodes: Array<{ lineItem: { id: string }; quantity: number }>;
  };
};

type ReturnCalculationResponse = { returnCalculate: ReturnCalculation };

type OrderRefund = {
  id: string;
  createdAt?: string | null;
  return: { id: string } | null;
  transactions: {
    nodes: Array<{ kind: string; status: string }>;
    pageInfo: { hasNextPage: boolean };
  };
};

const CUSTOMER_ORDERS_QUERY = `#graphql
  query CustomerReturnableOrders($first: Int!) {
    customer {
      id
      orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          id
          name
          processedAt
          returnInformation {
            nonReturnableSummary { nonReturnableReasons }
            returnableLineItems(first: 50) {
              nodes {
                lineItem {
                  id
                  presentmentTitle
                  currentTotalPrice { amount currencyCode }
                }
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

// Fees come from the merchant's Shopify return rules and are already netted
// into returnTotalSet; the subtotals are requested only to show the customer.
const CALCULATE_RETURN_QUERY = `#graphql
  query CalculateCustomerReturn(
    $orderId: ID!
    $returnLineItems: [CalculateReturnLineItemInput!]!
  ) {
    returnCalculate(input: {
      orderId: $orderId
      returnLineItems: $returnLineItems
    }) {
      financialSummary {
        returnTotalSet {
          presentmentMoney { amount currencyCode }
          shopMoney { amount currencyCode }
        }
        restockingFeeSubtotalSet { presentmentMoney { amount currencyCode } }
        returnShippingFeeSubtotalSet { presentmentMoney { amount currencyCode } }
      }
      returnLineItems(first: 50) {
        nodes { lineItem { id } quantity }
      }
    }
  }
`;

const REQUEST_RETURN_MUTATION = `#graphql
  mutation RequestCustomerReturn(
    $orderId: ID!
    $requestedLineItems: [RequestedLineItemInput!]!
  ) {
    orderRequestReturn(
      orderId: $orderId
      requestedLineItems: $requestedLineItems
    ) {
      return { id status }
      userErrors { field message }
    }
  }
`;

const APPROVE_RETURN_MUTATION = `#graphql
  mutation ApproveReturnRequest($input: ReturnApproveRequestInput!) {
    returnApproveRequest(input: $input) {
      return { id status order { id } }
      userErrors { field message }
    }
  }
`;

const RETURN_STATUS_QUERY = `#graphql
  query ReturnStatusForRetry($returnId: ID!) {
    return(id: $returnId) {
      status
      order { id }
    }
  }
`;

// The order's fulfillment locations (restock resolution), the approved
// return's own line items (to check Shopify approved every confirmed item and
// quantity) and its reverse fulfillment order line items (what dispositions are
// allocated against). Return line items are the ReturnLineItemType interface;
// only verified ReturnLineItem nodes carry a fulfillment.
const RETURN_DETAILS_QUERY = `#graphql
  query ReturnDetailsForProcessing($returnId: ID!) {
    return(id: $returnId) {
      order {
        fulfillments(first: 25) {
          location { id }
        }
      }
      returnLineItems(first: 50) {
        nodes {
          ... on ReturnLineItem {
            id
            quantity
            fulfillmentLineItem { lineItem { id } }
          }
        }
      }
      reverseFulfillmentOrders(first: 10) {
        nodes {
          lineItems(first: 50) {
            nodes {
              id
              totalQuantity
              fulfillmentLineItem { lineItem { id } }
            }
          }
        }
      }
    }
  }
`;

// The return-level outcome accounts for the return's fees; an order-level
// refund suggestion would not, and would disagree with the fee-inclusive
// amount the customer confirmed. An invoice outcome (the customer owes money)
// selects no refund fields and fails closed.
const SUGGESTED_OUTCOME_QUERY = `#graphql
  query SuggestedReturnOutcome(
    $returnId: ID!
    $returnLineItems: [SuggestedOutcomeReturnLineItemInput!]!
  ) {
    return(id: $returnId) {
      suggestedFinancialOutcome(
        returnLineItems: $returnLineItems
        exchangeLineItems: []
      ) {
        financialTransfer {
          ... on RefundReturnOutcome {
            amount { presentmentMoney { amount currencyCode } }
            suggestedTransactions {
              amountSet { presentmentMoney { amount currencyCode } }
              gateway
              parentTransaction { id gateway manualPaymentGateway }
            }
          }
        }
      }
    }
  }
`;

const RETURN_PROCESS_MUTATION = `#graphql
  mutation ProcessAutomaticReturn($input: ReturnProcessInput!) {
    returnProcess(input: $input) {
      return { id status }
      userErrors { field message }
    }
  }
`;

const DISPOSE_MUTATION = `#graphql
  mutation ReceiveReturnedItems(
    $dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!
  ) {
    reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
      reverseFulfillmentOrderLineItems { id }
      userErrors { field message }
    }
  }
`;

// returnProcess does not echo the refund it creates, so the refund a return
// produced is found by matching Refund.return.id.
const ORDER_REFUNDS_QUERY = `#graphql
  query OrderRefundsForReturn($orderId: ID!) {
    order(id: $orderId) {
      refunds(first: 250) {
        id
        createdAt
        return { id }
        transactions(first: 100) {
          nodes { kind status }
          pageInfo { hasNextPage }
        }
      }
    }
  }
`;

function throwOnUserErrors(errors: UserError[], action: string) {
  if (!errors.length) return;
  throw new Error(
    `${action}: ${errors.map((error) => error.message).join("; ")}`,
  );
}

const errorText = (error: unknown, fallback: string) =>
  (error instanceof Error ? error.message : fallback).slice(0, 1_000);

async function approveReturn(
  admin: AdminGraphql,
  returnId: string,
  orderId: string,
) {
  const { returnApproveRequest } = await adminData<{
    returnApproveRequest: {
      return: { id: string; status: string; order: { id: string } } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    APPROVE_RETURN_MUTATION,
    buildReturnApprovalVariables(returnId),
    "Shopify could not approve the return.",
  );
  throwOnUserErrors(
    returnApproveRequest.userErrors,
    "Shopify could not approve the return",
  );
  const approved = returnApproveRequest.return;
  if (
    approved?.id !== returnId ||
    approved.order.id !== orderId ||
    approved.status !== "OPEN"
  )
    throw new Error(
      "Shopify did not confirm that this order's return is open. No refund was submitted.",
    );
}

async function orderRefunds(admin: AdminGraphql, orderId: string) {
  const { order } = await adminData<{ order: { refunds: OrderRefund[] } | null }>(
    admin,
    ORDER_REFUNDS_QUERY,
    { orderId },
    "Shopify could not list this order's refunds.",
  );
  if (!order) throw new Error("Shopify could not find this order.");
  return order.refunds;
}

function recordRefund(recordId: string, refund: OrderRefund) {
  const paymentStatus = refundPaymentStatus(
    refund.transactions.nodes,
    refund.transactions.pageInfo.hasNextPage,
  );
  return prisma.agentReturn.update({
    where: { id: recordId },
    data: {
      refundId: refund.id,
      returnStatus: "PROCESSED",
      status: paymentStatus === "FAILED" ? "NEEDS_ATTENTION" : "REFUND_SUBMITTED",
      refundStatus: paymentStatus,
      failureReason:
        paymentStatus === "FAILED"
          ? "Shopify reported a failed refund transaction. Check all payments before retrying; part of the refund may have succeeded."
          : null,
    },
  });
}

// Maps the confirmed items onto the approved return. With `dispose`, each
// item is also disposed: restocked at the resolved location, or recorded as
// not restocked when no single location resolves.
async function returnLineItemsFor({
  admin,
  shop,
  returnId,
  items,
  dispose,
}: {
  admin: AdminGraphql;
  shop: string;
  returnId: string;
  items: RequestedItem[];
  dispose: boolean;
}) {
  const noDetails =
    "Shopify did not return the approved return's line items. No refund was submitted.";
  const details = (
    await adminData<{
      return: {
        order: { fulfillments: Array<{ location: { id: string } | null }> };
        returnLineItems: { nodes: Array<Partial<ReturnLineItemNode>> };
        reverseFulfillmentOrders: {
          nodes: Array<{ lineItems: { nodes: ReverseFulfillmentLineItemNode[] } }>;
        };
      } | null;
    }>(admin, RETURN_DETAILS_QUERY, { returnId }, noDetails)
  ).return;
  if (!details) throw new Error(noDetails);
  return buildReturnProcessLineItems({
    items,
    returnLineItems: details.returnLineItems.nodes.filter(
      (node): node is ReturnLineItemNode => typeof node.id === "string",
    ),
    reverseFulfillmentLineItems: details.reverseFulfillmentOrders.nodes.flatMap(
      (node) => node.lineItems.nodes,
    ),
    locationId: dispose
      ? await resolveRestockLocation(
          shop,
          details.order.fulfillments.map((fulfillment) => fulfillment.location?.id),
        )
      : null,
    unlocatedDisposition: dispose ? "NOT_RESTOCKED" : undefined,
  });
}

// Everything after Shopify has an OPEN return: the fee-aware refund
// allocation, one returnProcess call, then the refund record. Items are
// disposed in the same call only when they are already back with the store.
export async function processApprovedReturn({
  admin,
  shop,
  recordId,
  orderId,
  returnId,
  items,
  confirmed,
  dispose,
}: {
  admin: AdminGraphql;
  shop: string;
  recordId: string;
  orderId: string;
  returnId: string;
  items: RequestedItem[];
  confirmed: Money;
  dispose: boolean;
}) {
  const returnProcessLineItems = await returnLineItemsFor({
    admin,
    shop,
    returnId,
    items,
    dispose,
  });

  const noRefund =
    "Shopify could not calculate a refund to the original payment method for this return. No refund was issued.";
  const transfer = (
    await adminData<{
      return: {
        suggestedFinancialOutcome: {
          financialTransfer: {
            amount?: { presentmentMoney: Money };
            suggestedTransactions?: SuggestedRefundTransaction[];
          } | null;
        };
      } | null;
    }>(
      admin,
      SUGGESTED_OUTCOME_QUERY,
      {
        returnId,
        returnLineItems: returnProcessLineItems.map(({ id, quantity }) => ({
          id,
          quantity,
        })),
      },
      noRefund,
    )
  ).return?.suggestedFinancialOutcome.financialTransfer;
  if (!transfer?.amount || !transfer.suggestedTransactions)
    throw new Error(noRefund);
  if (
    !moneyAmountsMatch(transfer.amount.presentmentMoney.amount, confirmed.amount) ||
    transfer.amount.presentmentMoney.currencyCode !== confirmed.currencyCode
  )
    throw new Error(
      "The refund amount changed after confirmation. The return is open, but no refund was issued.",
    );
  const orderTransactions = buildReturnProcessTransactions(
    transfer.suggestedTransactions,
    confirmed,
  );

  const { returnProcess } = await adminData<{
    returnProcess: {
      return: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    RETURN_PROCESS_MUTATION,
    {
      input: {
        returnId,
        note: "Customer-confirmed automatic return",
        notifyCustomer: true,
        returnLineItems: returnProcessLineItems,
        financialTransfer: { issueRefund: { orderTransactions } },
      },
    },
    "Shopify could not process the return.",
  );
  throwOnUserErrors(returnProcess.userErrors, "Shopify could not process the return");
  if (
    returnProcess.return?.id !== returnId ||
    returnProcess.return.status !== "CLOSED"
  )
    throw new Error(
      "Shopify did not confirm that this return was processed. No refund was confirmed submitted.",
    );

  let refund: OrderRefund | undefined;
  try {
    refund = (await orderRefunds(admin, orderId)).find(
      (candidate) => candidate.return?.id === returnId,
    );
  } catch {
    // The refund transferred; only locating its record failed.
  }
  if (!refund)
    return prisma.agentReturn.update({
      where: { id: recordId },
      data: {
        status: "NEEDS_ATTENTION",
        returnStatus: "PROCESSED",
        failureReason:
          "The return was processed, but its refund record could not be located to confirm payment status.",
      },
    });
  return recordRefund(recordId, refund);
}

// Shopify is rechecked before any money moves. Returns the recorded row when
// a refund is already linked to the return; throws when the order was
// refunded outside the return since the request, or the return is not open;
// returns null when refunding now is safe.
async function settledOrBlocked(
  admin: AdminGraphql,
  record: { id: string; orderId: string; returnId: string; createdAt: Date },
  approveRequested: boolean,
) {
  const refunds = await orderRefunds(admin, record.orderId);
  const linked = refunds.find((refund) => refund.return?.id === record.returnId);
  if (linked) return recordRefund(record.id, linked);
  if (
    refunds.some(
      (refund) =>
        !refund.return &&
        refund.createdAt &&
        Date.parse(refund.createdAt) >= record.createdAt.getTime(),
    )
  )
    throw new Error(
      "This order was refunded in Shopify after the customer's request. Gooper.io issued no further refund; resolve the return in Shopify.",
    );
  const current = (
    await adminData<{
      return: { status: string; order: { id: string } } | null;
    }>(admin, RETURN_STATUS_QUERY, { returnId: record.returnId }, "Shopify could not read this return.")
  ).return;
  if (!current || current.order.id !== record.orderId)
    throw new Error(
      "Shopify no longer shows this return on the original order. No refund was issued.",
    );
  if (current.status === "REQUESTED" && approveRequested)
    await approveReturn(admin, record.returnId, record.orderId);
  else if (current.status !== "OPEN")
    throw new Error(
      `Shopify shows this return as ${current.status.toLowerCase()}. Gooper.io issued no further refund; check the order in Shopify.`,
    );
  return null;
}

export function canRetryReturn(record: {
  status: string;
  returnId: string | null;
  refundId: string | null;
  amount: string | null;
  currencyCode: string | null;
}) {
  return (
    record.status === "NEEDS_ATTENTION" &&
    Boolean(record.returnId && !record.refundId && record.amount && record.currencyCode)
  );
}

export function canReceiveReturn(record: {
  status: string;
  returnId: string | null;
  refundTiming: string | null;
  itemReceivedAt: Date | null;
}) {
  // Returns submitted before refund timing existed were restocked at refund.
  if (!record.returnId || record.itemReceivedAt || !record.refundTiming)
    return false;
  return record.refundTiming === "ON_RECEIPT"
    ? record.status === "AWAITING_ITEM"
    : ["REFUND_SUBMITTED", "REFUND_RECORDED"].includes(record.status);
}

// A request Shopify never created a return for: turned down (NOT_SUBMITTED),
// or stopped before Shopify answered. Removing it changes nothing in Shopify.
export function canRemoveReturn(record: {
  status: string;
  returnId: string | null;
  refundId: string | null;
}) {
  return (
    ["NOT_SUBMITTED", "NEEDS_ATTENTION"].includes(record.status) &&
    !record.returnId &&
    !record.refundId
  );
}

export async function removeUnsubmittedReturn(shop: string, agentReturnId: string) {
  const removed = await prisma.agentReturn.deleteMany({
    where: {
      id: agentReturnId,
      shop,
      status: { in: ["NOT_SUBMITTED", "NEEDS_ATTENTION"] },
      returnId: null,
      refundId: null,
    },
  });
  if (removed.count !== 1)
    throw new Error("Only a request Shopify never created a return for can be removed.");
}

function storedItems(value: Prisma.JsonValue): RequestedItem[] {
  const invalid = new Error("This return's stored items are unreadable. Resolve it in Shopify.");
  if (!Array.isArray(value) || !value.length) throw invalid;
  return value.map((entry) => {
    const item = entry as Record<string, unknown> | null;
    if (
      !item ||
      typeof item.lineItemId !== "string" ||
      !Number.isInteger(item.quantity) ||
      (item.quantity as number) < 1
    )
      throw invalid;
    return { lineItemId: item.lineItemId, quantity: item.quantity as number };
  });
}

// Merchant-initiated recovery for a return Shopify requested or approved but
// Gooper.io never refunded. Nothing is refunded twice (see settledOrBlocked), the
// amount must still equal what the customer confirmed, and an on-receipt
// return goes back to waiting for its item rather than refunding early.
export async function retryApprovedReturn(
  shop: string,
  agentReturnId: string,
  admin?: AdminGraphql,
) {
  const record = await prisma.agentReturn.findFirst({
    where: { id: agentReturnId, shop },
  });
  if (!record || !canRetryReturn(record))
    throw new Error(
      "Only a return that needs attention and has no recorded refund can be retried.",
    );
  const items = storedItems(record.requestedLineItems);
  const claimed = await prisma.agentReturn.updateMany({
    where: { id: record.id, shop, status: "NEEDS_ATTENTION", refundId: null },
    data: { status: "RETRYING" },
  });
  if (claimed.count !== 1)
    throw new Error("This return is already being retried.");
  const returnId = record.returnId!;
  try {
    const client = admin ?? (await adminFor(shop));
    const settled = await settledOrBlocked(client, { ...record, returnId }, true);
    if (settled) return settled;
    if (record.refundTiming === "ON_RECEIPT" && !record.itemReceivedAt)
      return await prisma.agentReturn.update({
        where: { id: record.id },
        data: { status: "AWAITING_ITEM", returnStatus: "OPEN", failureReason: null },
      });
    await prisma.agentReturn.update({
      where: { id: record.id },
      data: { returnStatus: "OPEN" },
    });
    return await processApprovedReturn({
      admin: client,
      shop,
      recordId: record.id,
      orderId: record.orderId,
      returnId,
      items,
      confirmed: { amount: record.amount!, currencyCode: record.currencyCode! },
      // Returns from before refund timing existed restocked at refund time.
      dispose: record.refundTiming !== "IMMEDIATE",
    });
  } catch (error) {
    await prisma.agentReturn.update({
      where: { id: record.id },
      data: {
        status: "NEEDS_ATTENTION",
        failureReason: errorText(error, "The retry failed."),
      },
    });
    throw error;
  }
}

// The merchant confirms the item is back. An immediately refunded return is
// restocked; an on-receipt return is refunded and restocked in one
// returnProcess call, after the same Shopify rechecks as a retry.
export async function receiveReturnedItems(
  shop: string,
  agentReturnId: string,
  admin?: AdminGraphql,
) {
  const record = await prisma.agentReturn.findFirst({
    where: { id: agentReturnId, shop },
  });
  if (!record || !canReceiveReturn(record))
    throw new Error(
      "Only an approved return that hasn't been marked received can be marked received.",
    );
  const items = storedItems(record.requestedLineItems);
  const onReceipt = record.refundTiming === "ON_RECEIPT";
  // RECEIVING also keeps a returns/process webhook for this very call from
  // flagging the return as processed outside Gooper.io.
  const claimed = await prisma.agentReturn.updateMany({
    where: { id: record.id, shop, status: record.status, itemReceivedAt: null },
    data: { itemReceivedAt: new Date(), ...(onReceipt ? { status: "RECEIVING" } : {}) },
  });
  if (claimed.count !== 1)
    throw new Error("This return is already being marked received.");
  const returnId = record.returnId!;
  try {
    const client = admin ?? (await adminFor(shop));
    if (!onReceipt) {
      const dispositionInputs = (
        await returnLineItemsFor({ admin: client, shop, returnId, items, dispose: true })
      ).flatMap((line) => line.dispositions);
      if (dispositionInputs.length) {
        const { reverseFulfillmentOrderDispose } = await adminData<{
          reverseFulfillmentOrderDispose: { userErrors: UserError[] };
        }>(
          client,
          DISPOSE_MUTATION,
          { dispositionInputs },
          "Shopify could not record the returned items.",
        );
        throwOnUserErrors(
          reverseFulfillmentOrderDispose.userErrors,
          "Shopify could not record the returned items",
        );
      }
      return await prisma.agentReturn.update({
        where: { id: record.id },
        data: { failureReason: null },
      });
    }
    const settled = await settledOrBlocked(client, { ...record, returnId }, false);
    if (settled) return settled;
    return await processApprovedReturn({
      admin: client,
      shop,
      recordId: record.id,
      orderId: record.orderId,
      returnId,
      items,
      confirmed: { amount: record.amount!, currencyCode: record.currencyCode! },
      dispose: true,
    });
  } catch (error) {
    await prisma.agentReturn.update({
      where: { id: record.id },
      data: {
        itemReceivedAt: null,
        ...(onReceipt ? { status: "AWAITING_ITEM" } : {}),
        failureReason: errorText(error, "Marking the return received failed."),
      },
    });
    throw error;
  }
}

// A string is a live Shopify customer session, which applies the store's own
// return rules. Otherwise it's a store link's verified customer, reached
// through the Admin API with the return rules the merchant confirmed in Gooper.io.
export async function getReturnableOrders(
  shop: string,
  access: CustomerAccess,
): Promise<{ customerId: string; orders: ReturnableOrder[] }> {
  if (typeof access !== "string") return verifiedCustomerOrders(shop, access);
  const result = await customerAccountGraphql<CustomerOrdersResponse>(
    shop,
    access,
    CUSTOMER_ORDERS_QUERY,
    { first: 20 },
  );

  return {
    customerId: result.customer.id,
    orders: result.customer.orders.nodes,
  };
}

export async function calculateReturn(
  shop: string,
  access: CustomerAccess,
  order: ReturnableOrder,
  items: RequestedItem[],
): Promise<ReturnCalculation> {
  if (typeof access !== "string")
    return calculateVerifiedReturn(shop, order, items);
  const result = await customerAccountGraphql<ReturnCalculationResponse>(
    shop,
    access,
    CALCULATE_RETURN_QUERY,
    { orderId: order.id, returnLineItems: items },
  );

  return result.returnCalculate;
}

async function requestCustomerReturn(
  shop: string,
  customerToken: string,
  orderId: string,
  items: RequestedItem[],
  customerNote?: string,
) {
  const requestResult = await customerAccountGraphql<{
    orderRequestReturn: {
      return: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(shop, customerToken, REQUEST_RETURN_MUTATION, {
    orderId,
    requestedLineItems: items.map((item) => ({
      ...item,
      customerNote: customerNote?.slice(0, 300),
    })),
  }).catch((error: unknown) => {
    // Shopify refused without running the request, for example for a missing
    // permission or an ended session, so no return exists.
    if (error instanceof CustomerAccountApiError && error.rejected)
      throw new ReturnNotCreatedError(error.message);
    throw error;
  });
  const { userErrors } = requestResult.orderRequestReturn;
  if (userErrors.length)
    throw new ReturnNotCreatedError(
      `Shopify could not request the return: ${userErrors.map((error) => error.message).join("; ")}`,
    );
  const returnId = requestResult.orderRequestReturn.return?.id;
  if (!returnId) throw new ReturnNotCreatedError("Shopify did not create a return.");
  return returnId;
}

export async function executeAutomaticReturn({
  shop,
  customerToken,
  orderId,
  items,
  customerNote,
  idempotencyKey,
  expectedRefund,
  refundTiming,
}: {
  shop: string;
  customerToken: CustomerAccess;
  orderId: string;
  items: RequestedItem[];
  customerNote?: string;
  idempotencyKey: string;
  expectedRefund: Money;
  refundTiming: RefundTiming;
}) {
  const policy = await prisma.storePolicy.findUnique({ where: { shop } });
  if (!policy?.automaticRefundsEnabled) {
    throw new Error(
      "Automatic refunds are not enabled for this store. No return or refund was created.",
    );
  }

  const { customerId, orders } = await getReturnableOrders(shop, customerToken);
  // Earlier identity hashes still match a retry recorded before a secret rotation.
  const subjectHashes = customerIdentityHashes(customerId);
  const subjectHash = subjectHashes[0];
  const existing = await prisma.agentReturn.findUnique({
    where: { shop_idempotencyKey: { shop, idempotencyKey } },
  });
  if (existing) {
    if (
      !subjectHashes.includes(existing.customerSubjectHash) ||
      existing.orderId !== orderId ||
      !sameReturnItems(existing.requestedLineItems, items)
    ) {
      throw new Error(
        "This idempotency key belongs to a different customer return request.",
      );
    }
    // Shopify turned the earlier attempt down before creating a return, so
    // this confirmation can be tried again.
    if (existing.status !== "NOT_SUBMITTED") return existing;
  }

  // The customer agreed to when the refund would arrive; a store that changed
  // its timing since the quote needs a fresh confirmation.
  if (refundTimingOf(policy.refundTiming) !== refundTiming)
    throw new Error(
      "The store changed when refunds are issued after this quote. Nothing was submitted. Request a new quote and confirm it again.",
    );

  const order = orders.find((candidate) => candidate.id === orderId);
  if (!order) {
    throw new Error(
      "That order is not available in the authenticated customer's account.",
    );
  }

  const ageInDays =
    (Date.now() - new Date(order.processedAt).getTime()) / 86_400_000;
  if (!Number.isFinite(ageInDays) || ageInDays > policy.returnWindowDays) {
    throw new Error(
      `This order is outside the store's ${policy.returnWindowDays}-day return window.`,
    );
  }

  const returnable = new Map(
    order.returnInformation.returnableLineItems.nodes.map((entry) => [
      entry.lineItem.id,
      entry.quantity,
    ]),
  );
  if (!items.length || items.length > 50 || hasDuplicateLineItems(items)) {
    throw new Error("Each line item can appear only once in a return request.");
  }
  for (const item of items) {
    const available = returnable.get(item.lineItemId) ?? 0;
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > available) {
      throw new Error(
        "One or more requested quantities are not currently returnable.",
      );
    }
  }

  const calculation = await calculateReturn(
    shop,
    customerToken,
    order,
    items,
  );
  const quote = refundFromReturnTotal(calculation.financialSummary.returnTotalSet.presentmentMoney);
  assertConfirmedAmount(quote, expectedRefund);
  const policyAmount = refundFromReturnTotal(calculation.financialSummary.returnTotalSet.shopMoney);
  if (policyAmount.currencyCode !== policy.currencyCode) {
    throw new Error(
      `The store's automatic-refund policy currency (${policy.currencyCode}) does not match its Shopify currency (${policyAmount.currencyCode}). Nothing was submitted.`,
    );
  }
  if (moneyIsAbove(policyAmount.amount, policy.maxAutoRefundAmount)) {
    throw new Error(
      `The ${quote.amount} ${quote.currencyCode} refund exceeds this store's automatic refund limit.`,
    );
  }

  let record;
  if (existing) {
    const claimed = await prisma.agentReturn.updateMany({
      where: { id: existing.id, shop, status: "NOT_SUBMITTED" },
      data: {
        status: "IN_PROGRESS",
        failureReason: null,
        orderName: order.name,
        customerSubjectHash: subjectHash,
        amount: quote.amount,
        currencyCode: quote.currencyCode,
        refundTiming,
      },
    });
    // Another request is already trying it again.
    if (claimed.count !== 1)
      return prisma.agentReturn.findUniqueOrThrow({ where: { id: existing.id } });
    record = existing;
  } else {
    try {
      record = await prisma.agentReturn.create({
        data: {
          shop,
          orderId,
          orderName: order.name,
          idempotencyKey,
          requestedLineItems: items,
          customerSubjectHash: subjectHash,
          amount: quote.amount,
          currencyCode: quote.currencyCode,
          refundTiming,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const concurrent = await prisma.agentReturn.findUnique({
          where: { shop_idempotencyKey: { shop, idempotencyKey } },
        });
        if (
          concurrent &&
          subjectHashes.includes(concurrent.customerSubjectHash) &&
          concurrent.orderId === orderId &&
          sameReturnItems(concurrent.requestedLineItems, items)
        ) {
          return concurrent;
        }
      }
      throw error;
    }
  }

  let returnId: string;
  try {
    returnId =
      typeof customerToken === "string"
        ? await requestCustomerReturn(shop, customerToken, orderId, items, customerNote)
        : await requestVerifiedReturn(shop, order, items, customerNote);
  } catch (error) {
    // Only a clear refusal from Shopify is safe to try again. Anything else
    // may have created a return, so the merchant checks first.
    const refused = error instanceof ReturnNotCreatedError;
    await prisma.agentReturn.update({
      where: { id: record.id },
      data: {
        status: refused ? "NOT_SUBMITTED" : "NEEDS_ATTENTION",
        failureReason: errorText(error, "Unknown automatic return error."),
      },
    });
    if (refused)
      throw new Error(
        `Nothing was submitted and no refund was issued: Shopify didn't accept the return request (${errorText(error, "no reason given")}). It's safe to confirm again once that's sorted out, or the customer can contact the store.`,
      );
    throw error;
  }

  try {
    await prisma.agentReturn.update({
      where: { id: record.id },
      data: {
        returnId,
        status: "RETURN_REQUESTED",
        returnStatus: "REQUESTED",
      },
    });

    const admin = await adminFor(shop);
    await approveReturn(admin, returnId, orderId);
    if (refundTiming === "ON_RECEIPT")
      return await prisma.agentReturn.update({
        where: { id: record.id },
        data: { status: "AWAITING_ITEM", returnStatus: "OPEN" },
      });
    await prisma.agentReturn.update({
      where: { id: record.id },
      data: { status: "RETURN_OPEN", returnStatus: "OPEN" },
    });

    // Refunded before the item ships back, so nothing is restocked yet; the
    // merchant restocks by marking the item received.
    return await processApprovedReturn({
      admin,
      shop,
      recordId: record.id,
      orderId,
      returnId,
      items,
      confirmed: quote,
      dispose: false,
    });
  } catch (error) {
    await prisma.agentReturn.update({
      where: { id: record.id },
      data: {
        status: "NEEDS_ATTENTION",
        failureReason: errorText(error, "Unknown automatic return error."),
      },
    });
    throw error;
  }
}

export function assertConfirmedAmount(actual: Money, expected: Money) {
  if (!expected || actual.currencyCode !== expected.currencyCode ||
      !moneyAmountsMatch(actual.amount, expected.amount) || Number(actual.amount) <= 0) {
    throw new Error("The refund amount changed or is invalid. Nothing was submitted. Request a new quote and confirm it again.");
  }
}
