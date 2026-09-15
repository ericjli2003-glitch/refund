import prisma from "../db.server";
import type {
  ReturnCalculation,
  ReturnableOrder,
} from "./automatic-return.server";
import { ReturnNotCreatedError, type RequestedItem } from "./return-guards.server";
import {
  adminData,
  adminFor,
  hasScope,
  type AdminGraphql,
} from "./shopify-admin.server";

type Money = { amount: string; currencyCode: string };
type MoneyBag = { presentmentMoney: Money; shopMoney: Money };
type UserError = { field?: string[]; message: string };

// A customer who proved who they are with the store's own Shopify sign-in when
// linking the store. After that sign-in ends, Refund acts for them through the
// store's Admin API. The Admin API doesn't apply the store's Shopify return
// rules, so Refund applies the fees and final-sale collections the merchant
// confirmed in Refund instead.
export type VerifiedCustomer = { customerId: string };
// The email on the customer's orders, confirmed from their inbox. Covers
// guest checkouts as well as account holders.
export type VerifiedEmail = { email: string };
// A string is a live Shopify customer access token.
export type CustomerAccess = string | VerifiedCustomer | VerifiedEmail;

// Identity for a confirmed order email, hashed like Shopify customer IDs but in
// its own namespace.
export const emailSubject = (email: string) => `email:${email}`;

export const FINAL_SALE_COLLECTION_LIMIT = 25;
export const RETURN_RULES_SCOPE = "read_products";

type ReturnRules = {
  verifiedStoreLinks: boolean;
  returnRulesConfirmedAt: Date | null;
  restockingFeePercent: string;
  returnShippingFee: string;
  finalSaleCollectionIds: string[];
  currencyCode: string;
};

export function verifiedLinksAllowed(
  policy: Pick<
    ReturnRules,
    "verifiedStoreLinks" | "returnRulesConfirmedAt" | "finalSaleCollectionIds"
  > | null | undefined,
  grantedScopes: string | null | undefined,
) {
  return Boolean(
    policy?.verifiedStoreLinks &&
      policy.returnRulesConfirmedAt &&
      (!policy.finalSaleCollectionIds.length ||
        hasScope(grantedScopes, RETURN_RULES_SCOPE)),
  );
}

async function confirmedRules(shop: string) {
  const [policy, installed] = await Promise.all([
    prisma.storePolicy.findUnique({ where: { shop } }),
    prisma.session.findFirst({
      where: { shop, isOnline: false },
      select: { scope: true },
    }),
  ]);
  if (!policy || !verifiedLinksAllowed(policy, installed?.scope))
    throw new Error(
      "This store hasn't set up returns through assistants, so this one can't be done in chat. The customer can use the store's own returns page. Nothing was submitted.",
    );
  return policy;
}

const ORDERS_QUERY = `#graphql
  query VerifiedCustomerOrders(
    $first: Int!
    $query: String!
    $withProducts: Boolean!
    $withEmail: Boolean!
  ) {
    orders(first: $first, sortKey: PROCESSED_AT, reverse: true, query: $query) {
      nodes {
        id
        name
        processedAt
        customer { id }
        email @include(if: $withEmail)
        lineItems(first: 50) {
          nodes {
            id
            title
            product @include(if: $withProducts) { id }
            discountedTotalSet { presentmentMoney { amount currencyCode } }
          }
        }
      }
    }
  }
`;

type AdminOrder = {
  id: string;
  name: string;
  processedAt: string;
  customer: { id: string } | null;
  email?: string | null;
  lineItems: {
    nodes: Array<{
      id: string;
      title: string;
      product?: { id: string } | null;
      discountedTotalSet: { presentmentMoney: Money };
    }>;
  };
};

type FulfillmentLine = { id: string; quantity: number };

// One aliased query for every order: returnable fulfillment line items,
// grouped by the order line item they fulfill.
async function returnableFulfillmentLines(
  admin: AdminGraphql,
  orderIds: string[],
) {
  const lines = new Map<string, Map<string, FulfillmentLine[]>>();
  if (!orderIds.length) return lines;
  const variables = Object.fromEntries(
    orderIds.map((id, index) => [`o${index}`, id]),
  );
  const declarations = orderIds.map((_, index) => `$o${index}: ID!`).join(", ");
  const fields = orderIds
    .map(
      (_, index) =>
        `o${index}: returnableFulfillments(orderId: $o${index}, first: 10) {
          nodes {
            returnableFulfillmentLineItems(first: 50) {
              nodes { quantity fulfillmentLineItem { id lineItem { id } } }
            }
          }
        }`,
    )
    .join("\n");
  const data = await adminData<
    Record<
      string,
      {
        nodes: Array<{
          returnableFulfillmentLineItems: {
            nodes: Array<{
              quantity: number;
              fulfillmentLineItem: { id: string; lineItem: { id: string } };
            }>;
          };
        }>;
      }
    >
  >(
    admin,
    `#graphql
      query VerifiedReturnableFulfillments(${declarations}) {
        ${fields}
      }
    `,
    variables,
    "Shopify could not list returnable items.",
  );
  orderIds.forEach((orderId, index) => {
    const byLine = new Map<string, FulfillmentLine[]>();
    for (const fulfillment of data[`o${index}`]?.nodes ?? [])
      for (const entry of fulfillment.returnableFulfillmentLineItems.nodes) {
        if (entry.quantity < 1) continue;
        const lineItemId = entry.fulfillmentLineItem.lineItem.id;
        byLine.set(lineItemId, [
          ...(byLine.get(lineItemId) ?? []),
          { id: entry.fulfillmentLineItem.id, quantity: entry.quantity },
        ]);
      }
    lines.set(orderId, byLine);
  });
  return lines;
}

async function finalSaleProducts(
  admin: AdminGraphql,
  productIds: string[],
  collectionIds: string[],
) {
  const found = new Set<string>();
  if (!productIds.length || !collectionIds.length) return found;
  const declarations = [
    "$ids: [ID!]!",
    ...collectionIds.map((_, index) => `$c${index}: ID!`),
  ].join(", ");
  const fields = collectionIds
    .map((_, index) => `c${index}: inCollection(id: $c${index})`)
    .join(" ");
  const collections = Object.fromEntries(
    collectionIds.map((id, index) => [`c${index}`, id]),
  );
  for (let start = 0; start < productIds.length; start += 250) {
    const { nodes } = await adminData<{
      nodes: Array<(Record<string, boolean> & { id?: string }) | null>;
    }>(
      admin,
      `#graphql
        query FinalSaleProducts(${declarations}) {
          nodes(ids: $ids) { ... on Product { id ${fields} } }
        }
      `,
      { ids: productIds.slice(start, start + 250), ...collections },
      "Shopify could not check final-sale products.",
    );
    for (const node of nodes)
      if (
        node?.id &&
        collectionIds.some((_, index) => node[`c${index}`] === true)
      )
        found.add(node.id);
  }
  return found;
}

export async function verifiedCustomerOrders(
  shop: string,
  access: VerifiedCustomer | VerifiedEmail,
  admin?: AdminGraphql,
): Promise<{ customerId: string; orders: ReturnableOrder[] }> {
  let query: string;
  let subject: string;
  let owns: (order: AdminOrder) => boolean;
  if ("email" in access) {
    const email = access.email;
    if (!/^[^"\\\s@]+@[^"\\\s@]+$/.test(email))
      throw new Error("This store link has an invalid email.");
    query = `email:"${email}"`;
    subject = emailSubject(email);
    owns = (order) => order.email?.toLowerCase() === email;
  } else {
    const numericId = access.customerId.match(
      /^gid:\/\/shopify\/Customer\/(\d+)$/,
    )?.[1];
    if (!numericId) throw new Error("This store link has an invalid customer.");
    query = `customer_id:${numericId}`;
    subject = access.customerId;
    owns = (order) => order.customer?.id === access.customerId;
  }
  const rules = await confirmedRules(shop);
  const client = admin ?? (await adminFor(shop));
  const finalSale = rules.finalSaleCollectionIds.slice(
    0,
    FINAL_SALE_COLLECTION_LIMIT,
  );
  const { orders } = await adminData<{ orders: { nodes: AdminOrder[] } }>(
    client,
    ORDERS_QUERY,
    {
      first: 20,
      query,
      withProducts: finalSale.length > 0,
      withEmail: "email" in access,
    },
    "Shopify could not list this customer's orders.",
  );
  // The search narrows the list; ownership is still checked on every order.
  const owned = orders.nodes.filter(owns);
  const [returnable, excluded] = await Promise.all([
    returnableFulfillmentLines(
      client,
      owned.map((order) => order.id),
    ),
    finalSaleProducts(
      client,
      [
        ...new Set(
          owned.flatMap((order) =>
            order.lineItems.nodes.flatMap((line) =>
              line.product ? [line.product.id] : [],
            ),
          ),
        ),
      ],
      finalSale,
    ),
  ]);
  return {
    customerId: subject,
    orders: owned.map((order) => {
      const byLine = returnable.get(order.id) ?? new Map();
      let finalSaleExcluded = false;
      const nodes = order.lineItems.nodes.flatMap((line) => {
        const quantity = (byLine.get(line.id) ?? []).reduce(
          (sum: number, entry: FulfillmentLine) => sum + entry.quantity,
          0,
        );
        if (quantity < 1) return [];
        if (line.product && excluded.has(line.product.id)) {
          finalSaleExcluded = true;
          return [];
        }
        return [
          {
            quantity,
            lineItem: {
              id: line.id,
              presentmentTitle: line.title,
              currentTotalPrice: line.discountedTotalSet.presentmentMoney,
            },
          },
        ];
      });
      return {
        id: order.id,
        name: order.name,
        processedAt: order.processedAt,
        returnInformation: {
          nonReturnableSummary: finalSaleExcluded
            ? { nonReturnableReasons: ["FINAL_SALE"] }
            : null,
          returnableLineItems: { nodes },
        },
      };
    }),
  };
}

// Exact decimal arithmetic in millionths, so fees never drift by a cent.
const SCALE = 1_000_000n;
function units(amount: string) {
  const match = amount.match(/^(-?)(\d+)(?:\.(\d{1,6}))?$/);
  if (!match)
    throw new Error("Shopify returned an invalid amount. Nothing was submitted.");
  const value = BigInt(match[2]) * SCALE + BigInt((match[3] ?? "").padEnd(6, "0"));
  return match[1] ? -value : value;
}
function decimal(value: bigint) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${absolute / SCALE}.${fraction.padEnd(2, "0")}`;
}

// The returned quantities, allocated across the fulfillments that shipped
// them, with the merchant's confirmed fees.
async function verifiedReturnInput(
  shop: string,
  order: ReturnableOrder,
  items: RequestedItem[],
  admin?: AdminGraphql,
) {
  const rules = await confirmedRules(shop);
  const client = admin ?? (await adminFor(shop));
  const byLine =
    (await returnableFulfillmentLines(client, [order.id])).get(order.id) ??
    new Map<string, FulfillmentLine[]>();
  const restockingFee = Number(rules.restockingFeePercent);
  const lines = items.flatMap((item) => {
    if (
      !order.returnInformation.returnableLineItems.nodes.some(
        (entry) => entry.lineItem.id === item.lineItemId,
      )
    )
      throw new Error("The selected item or quantity is not currently returnable.");
    let remaining = item.quantity;
    const allocated: Array<{ fulfillmentLineItemId: string; quantity: number }> = [];
    for (const line of byLine.get(item.lineItemId) ?? []) {
      if (remaining < 1) break;
      const quantity = Math.min(remaining, line.quantity);
      allocated.push({ fulfillmentLineItemId: line.id, quantity });
      remaining -= quantity;
    }
    if (remaining > 0)
      throw new Error("The selected item or quantity is not currently returnable.");
    return allocated.map((line) => ({
      ...line,
      ...(restockingFee > 0 ? { restockingFee: { percentage: restockingFee } } : {}),
    }));
  });
  const shippingFee = units(rules.returnShippingFee);
  const orderCurrency =
    order.returnInformation.returnableLineItems.nodes[0]?.lineItem
      .currentTotalPrice.currencyCode;
  // Shopify takes the fee in the order's currency, and Refund stores it in
  // the shop's; it never converts between them.
  if (shippingFee > 0n && orderCurrency !== rules.currencyCode)
    throw new Error(
      `This order was paid in ${orderCurrency ?? "another currency"}, but the store's return shipping fee is set in ${rules.currencyCode}. Refund can't quote this return in chat, so the customer can use the store's own returns page or contact the store. Nothing was submitted.`,
    );
  return {
    client,
    lines,
    returnShippingFee:
      shippingFee > 0n
        ? { amount: { amount: rules.returnShippingFee, currencyCode: rules.currencyCode } }
        : undefined,
  };
}

const CALCULATE_QUERY = `#graphql
  query VerifiedReturnCalculation($input: CalculateReturnInput!) {
    returnCalculate(input: $input) {
      returnLineItems {
        quantity
        fulfillmentLineItem { lineItem { id } }
        subtotalSet {
          presentmentMoney { amount currencyCode }
          shopMoney { amount currencyCode }
        }
        totalTaxSet {
          presentmentMoney { amount currencyCode }
          shopMoney { amount currencyCode }
        }
        restockingFee {
          amountSet {
            presentmentMoney { amount currencyCode }
            shopMoney { amount currencyCode }
          }
        }
      }
      returnShippingFee {
        amountSet {
          presentmentMoney { amount currencyCode }
          shopMoney { amount currencyCode }
        }
      }
    }
  }
`;

// Shaped like the Customer Account API's calculation: a negative return total
// is money owed back to the customer.
export async function calculateVerifiedReturn(
  shop: string,
  order: ReturnableOrder,
  items: RequestedItem[],
  admin?: AdminGraphql,
): Promise<ReturnCalculation> {
  const input = await verifiedReturnInput(shop, order, items, admin);
  const { returnCalculate } = await adminData<{
    returnCalculate: {
      returnLineItems: Array<{
        quantity: number;
        fulfillmentLineItem: { lineItem: { id: string } };
        subtotalSet: MoneyBag;
        totalTaxSet: MoneyBag;
        restockingFee: { amountSet: MoneyBag } | null;
      }>;
      returnShippingFee: { amountSet: MoneyBag } | null;
    } | null;
  }>(
    input.client,
    CALCULATE_QUERY,
    {
      input: {
        orderId: order.id,
        returnLineItems: input.lines,
        ...(input.returnShippingFee
          ? { returnShippingFee: input.returnShippingFee }
          : {}),
      },
    },
    "Shopify could not calculate this return.",
  );
  if (!returnCalculate?.returnLineItems.length)
    throw new Error("Shopify could not calculate this return. Nothing was submitted.");
  const total = (key: "presentmentMoney" | "shopMoney") => {
    const currencyCode = returnCalculate.returnLineItems[0].subtotalSet[key].currencyCode;
    const fee = (bag: MoneyBag | undefined) => {
      if (!bag) return 0n;
      const value = units(bag[key].amount);
      return value < 0n ? -value : value;
    };
    let credit = 0n;
    let restocking = 0n;
    for (const line of returnCalculate.returnLineItems) {
      credit += units(line.subtotalSet[key].amount) + units(line.totalTaxSet[key].amount);
      restocking += fee(line.restockingFee?.amountSet);
    }
    const shipping = fee(returnCalculate.returnShippingFee?.amountSet);
    return {
      returnTotal: { amount: decimal(-(credit - restocking - shipping)), currencyCode },
      restocking: { amount: decimal(restocking), currencyCode },
      shipping: { amount: decimal(shipping), currencyCode },
      hasRestocking: restocking > 0n,
      hasShipping: shipping > 0n,
    };
  };
  const presentment = total("presentmentMoney");
  const shopTotal = total("shopMoney");
  const quantities = new Map<string, number>();
  for (const line of returnCalculate.returnLineItems) {
    const id = line.fulfillmentLineItem.lineItem.id;
    quantities.set(id, (quantities.get(id) ?? 0) + line.quantity);
  }
  return {
    financialSummary: {
      returnTotalSet: {
        presentmentMoney: presentment.returnTotal,
        shopMoney: shopTotal.returnTotal,
      },
      ...(presentment.hasRestocking
        ? { restockingFeeSubtotalSet: { presentmentMoney: presentment.restocking } }
        : {}),
      ...(presentment.hasShipping
        ? { returnShippingFeeSubtotalSet: { presentmentMoney: presentment.shipping } }
        : {}),
    },
    returnLineItems: {
      nodes: [...quantities].map(([id, quantity]) => ({
        lineItem: { id },
        quantity,
      })),
    },
  };
}

const REQUEST_MUTATION = `#graphql
  mutation RequestVerifiedCustomerReturn($input: ReturnRequestInput!) {
    returnRequest(input: $input) {
      return { id status }
      userErrors { field message }
    }
  }
`;

export async function requestVerifiedReturn(
  shop: string,
  order: ReturnableOrder,
  items: RequestedItem[],
  customerNote?: string,
  admin?: AdminGraphql,
) {
  // Refund's own checks run before Shopify is asked, so a failure here means
  // no return exists.
  const input = await verifiedReturnInput(shop, order, items, admin).catch(
    (error: unknown) => {
      throw new ReturnNotCreatedError(
        error instanceof Error ? error.message : "Refund couldn't prepare the return.",
      );
    },
  );
  const note = customerNote?.slice(0, 300);
  const { returnRequest } = await adminData<{
    returnRequest: {
      return: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(
    input.client,
    REQUEST_MUTATION,
    {
      input: {
        orderId: order.id,
        returnLineItems: input.lines.map((line) => ({
          ...line,
          ...(note ? { customerNote: note } : {}),
        })),
        ...(input.returnShippingFee
          ? { returnShippingFee: input.returnShippingFee }
          : {}),
      },
    },
    "Shopify could not request the return.",
  );
  if (returnRequest.userErrors.length)
    throw new ReturnNotCreatedError(
      `Shopify could not request the return: ${returnRequest.userErrors
        .map((error) => error.message)
        .join("; ")}`,
    );
  if (!returnRequest.return?.id)
    throw new ReturnNotCreatedError("Shopify did not create a return.");
  return returnRequest.return.id;
}

// A signed-in quote shows what Shopify's own return rules charge. When Shopify
// applies a fee or final-sale rule the merchant's saved Refund rules would
// miss, verified links pause until the merchant reviews and saves them again.
// Rules that only charge more than Shopify don't pause anything.
export async function noteReturnRulesDrift(
  shop: string,
  policy: ReturnRules,
  order: ReturnableOrder,
  calculation: ReturnCalculation,
) {
  if (!policy.verifiedStoreLinks || !policy.returnRulesConfirmedAt) return;
  const problems: string[] = [];
  const amount = (money?: Money) =>
    money && /^-?\d+(\.\d+)?$/.test(money.amount)
      ? Math.abs(Number(money.amount))
      : 0;
  const restocking = amount(
    calculation.financialSummary.restockingFeeSubtotalSet?.presentmentMoney,
  );
  if (restocking > 0 && !(Number(policy.restockingFeePercent) > 0))
    problems.push(
      "Shopify charged a customer a restocking fee, but your restocking fee in Refund is 0%.",
    );
  const shipping =
    calculation.financialSummary.returnShippingFeeSubtotalSet?.presentmentMoney;
  if (
    shipping &&
    shipping.currencyCode === policy.currencyCode &&
    amount(shipping) > Number(policy.returnShippingFee)
  )
    problems.push(
      `Shopify charged a customer a ${amount(shipping).toFixed(2)} ${shipping.currencyCode} return shipping fee, more than the ${policy.returnShippingFee} set in Refund.`,
    );
  if (
    order.returnInformation.nonReturnableSummary?.nonReturnableReasons.includes(
      "FINAL_SALE",
    ) &&
    !policy.finalSaleCollectionIds.length
  )
    problems.push(
      "Shopify marks some of your items final sale, but no final-sale collections are set in Refund.",
    );
  if (!problems.length) return;
  await prisma.storePolicy
    .updateMany({
      where: { shop, returnRulesConfirmedAt: { not: null } },
      data: {
        returnRulesConfirmedAt: null,
        returnRulesMismatch: problems.join(" ").slice(0, 500),
      },
    })
    .catch(() => {});
}
