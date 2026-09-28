import { createHash } from "node:crypto";
import prisma from "../../db.server";
import type {
  Money,
  ReturnCalculation,
  ReturnableOrder,
} from "../automatic-return.server";
import { ReturnNotCreatedError, type RequestedItem } from "../return-guards.server";
import { isWixStore, storeInstallation } from "../store-platform.server";
import {
  FINAL_SALE_COLLECTION_LIMIT,
  emailSubject,
  verifiedLinksAllowed,
} from "../verified-customer-returns.server";
import { WixApiError, type WixApi } from "./wix-api.server";
import {
  WIX_STORES_APP_ID,
  finalSaleProductIds,
  wixCatalogVersion,
} from "./wix-catalog.server";

// Wix stores join the same email path as Shopify's verified customers: the
// customer confirmed their order email from their inbox, and Gooper.io acts for
// them through the site's eCommerce APIs. Wix has no return object, so a Wix
// return is a refund (and, when the item is back, a restock) that Gooper.io
// records itself. Wix doesn't apply any return rules either, so Gooper.io
// applies the fees and final-sale collections the merchant confirmed.
//
// Every function here takes the WixApi for the site, so tests pass a fake.

type WixPrice = { amount?: string | null };

type WixLineItem = {
  id: string;
  productName?: { original?: string | null; translated?: string | null };
  catalogReference?: {
    catalogItemId?: string | null;
    appId?: string | null;
    options?: Record<string, unknown> | null;
  };
  quantity?: number | null;
  itemType?: { preset?: string | null; custom?: string | null };
  physicalProperties?: { shippable?: boolean | null };
  totalPriceAfterTax?: WixPrice;
  refundQuantity?: number | null;
  locations?: Array<{ id?: string | null; quantity?: number | null }>;
};

type WixOrder = {
  id: string;
  number?: string | number | null;
  createdDate?: string | null;
  currency?: string | null;
  status?: string | null;
  paymentStatus?: string | null;
  fulfillmentStatus?: string | null;
  archived?: boolean | null;
  buyerInfo?: { email?: string | null };
  lineItems?: WixLineItem[];
};

type MonetarySummary = { maxRefund?: WixPrice };

type Refundability = {
  payments?: Array<{
    refundable?: boolean;
    payment?: {
      paymentId?: string;
      paymentMethod?: string | null;
      monetary?: MonetarySummary;
      membership?: unknown;
    };
  }>;
  lineItems?: Array<{
    lineItemId?: string;
    originalQuantity?: number;
    refundedQuantity?: number;
    availableRefundQuantity?: number;
  }>;
};

type RefundedLine = { lineItemId?: string | null; quantity?: number | null };
type WixRefund = {
  id?: string;
  createdDate?: string | null;
  details?: {
    reason?: string | null;
    items?: RefundedLine[];
    lineItems?: RefundedLine[];
  };
  transactions?: Array<{ refundStatus?: string | null }>;
};

export type WixRefundStatus = "SUCCESS" | "PENDING" | "FAILED" | "UNKNOWN";

const NOTHING_SUBMITTED = "Nothing was submitted.";

async function confirmedRules(shop: string) {
  if (!isWixStore(shop)) throw new Error("This store isn't a Wix store.");
  const [policy, installed] = await Promise.all([
    prisma.storePolicy.findUnique({ where: { shop } }),
    storeInstallation(shop),
  ]);
  if (!policy || !installed || !verifiedLinksAllowed(policy, installed.scope))
    throw new Error(
      "This store hasn't set up returns through assistants, so this one can't be done in chat. The customer can use the store's own returns page. Nothing was submitted.",
    );
  return policy;
}

type Rules = Awaited<ReturnType<typeof confirmedRules>>;

// ---------------------------------------------------------------------------
// Exact decimal arithmetic in millionths, so fees never drift by a cent.

const SCALE = 1_000_000n;

function units(amount: string | null | undefined) {
  const match = (amount ?? "").trim().match(/^(-?)(\d+)(?:\.(\d{1,6}))?$/);
  if (!match)
    throw new Error(`Wix returned an invalid amount. ${NOTHING_SUBMITTED}`);
  const value = BigInt(match[2]) * SCALE + BigInt((match[3] ?? "").padEnd(6, "0"));
  return match[1] ? -value : value;
}

// Minor-unit digits of a currency: 0 for JPY, 2 for USD, 3 for KWD.
export function currencyDigits(currencyCode: string) {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency: currencyCode })
        .resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

// Written with the currency's own digits ("1500" yen, "1.250" dinars), never
// dropping a digit Wix sent.
function decimal(value: bigint, digits: number) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "")
    .padEnd(digits, "0");
  return `${sign}${absolute / SCALE}${fraction ? `.${fraction}` : ""}`;
}

// percent% of amount, rounded half up to the currency's minor unit.
function percentOf(amount: bigint, percent: bigint, digits: number) {
  if (amount <= 0n || percent <= 0n) return 0n;
  const step = 10n ** BigInt(6 - Math.min(digits, 6));
  const denominator = 100n * SCALE * step;
  const steps = (amount * percent * 2n + denominator) / (2n * denominator);
  return steps * step;
}

// ---------------------------------------------------------------------------
// Orders

const EMAIL = /^[^"\\\s@]+@[^"\\\s@]+$/;

const ownedBy = (order: WixOrder, email: string) =>
  order.buyerInfo?.email?.trim().toLowerCase() === email.toLowerCase();

function searchByEmail(api: WixApi, email: string, limit: number) {
  // UNVERIFIED: whether Wix matches buyerInfo.email case-insensitively. Gooper.io
  // confirms emails in lowercase, so an order placed with capitals may not match.
  return api<{ orders?: WixOrder[] }>("POST", "/ecom/v1/orders/search", {
    search: {
      filter: { "buyerInfo.email": { $eq: email } },
      sort: [{ fieldName: "createdDate", order: "DESC" }],
      cursorPaging: { limit },
    },
  });
}

// Approved, paid (or already partly refunded) and still active. Search Orders
// never returns INITIALIZED orders and skips PENDING and REJECTED by default.
const PAID = new Set(["PAID", "PARTIALLY_REFUNDED"]);
function orderIsRefundable(order: WixOrder) {
  return (
    order.status === "APPROVED" &&
    PAID.has(order.paymentStatus ?? "") &&
    !order.archived
  );
}

// Only goods that ship can come back. Digital files, gift cards and services
// can't be returned, so their lines never show as returnable.
function isPhysical(line: WixLineItem) {
  const preset = line.itemType?.preset;
  if (preset) return preset === "PHYSICAL";
  // A custom item type counts only when the line itself says it ships.
  return line.physicalProperties?.shippable === true;
}

const isGiftCardPayment = (method: string | null | undefined) =>
  /gift/i.test(method ?? "");

// Payments Gooper.io can refund automatically, with the most each can take.
// Offline payments (manuallyRefundable) and memberships need the merchant.
// UNVERIFIED: gift card payments report a paymentMethod naming a gift card;
// Wix refunds a gift card's full credit whatever the amount, so they're skipped.
function refundablePayments(refundability: Refundability) {
  return (refundability.payments ?? []).flatMap((entry) => {
    const payment = entry.payment;
    if (
      entry.refundable !== true ||
      !payment?.paymentId ||
      payment.membership ||
      isGiftCardPayment(payment.paymentMethod) ||
      !payment.monetary?.maxRefund?.amount
    )
      return [];
    const maxRefund = units(payment.monetary.maxRefund.amount);
    return maxRefund > 0n ? [{ paymentId: payment.paymentId, maxRefund }] : [];
  });
}

function getRefundability(api: WixApi, orderId: string) {
  return api<Refundability>("POST", "/ecom/v1/order-billing/get-order-refundability", {
    orderId,
  });
}

// Shipped quantity per line for each order. A fully fulfilled order shipped
// everything; a partly fulfilled one is looked up in Order Fulfillments.
async function shippedQuantities(api: WixApi, orders: WixOrder[]) {
  const shipped = new Map<string, Map<string, number> | "ALL">();
  const partial: string[] = [];
  for (const order of orders) {
    if (order.fulfillmentStatus === "FULFILLED") shipped.set(order.id, "ALL");
    else if (order.fulfillmentStatus === "PARTIALLY_FULFILLED") partial.push(order.id);
  }
  if (!partial.length) return shipped;
  const { ordersWithFulfillments } = await api<{
    ordersWithFulfillments?: Array<{
      orderId?: string;
      fulfillments?: Array<{ lineItems?: Array<{ id?: string; quantity?: number | null }> }>;
    }>;
  }>("POST", "/ecom/v1/fulfillments/list-by-ids", { orderIds: partial });
  const lineQuantity = new Map(
    orders.flatMap((order) =>
      (order.lineItems ?? []).map((line) => [line.id, line.quantity ?? 0] as const),
    ),
  );
  for (const entry of ordersWithFulfillments ?? []) {
    if (!entry.orderId) continue;
    const byLine = new Map<string, number>();
    for (const fulfillment of entry.fulfillments ?? [])
      for (const line of fulfillment.lineItems ?? []) {
        if (!line.id) continue;
        // UNVERIFIED: a fulfillment line without a quantity covers the whole line.
        const quantity = line.quantity ?? lineQuantity.get(line.id) ?? 0;
        byLine.set(line.id, (byLine.get(line.id) ?? 0) + quantity);
      }
    shipped.set(entry.orderId, byLine);
  }
  return shipped;
}

const productIdOf = (line: WixLineItem) =>
  line.catalogReference?.appId === WIX_STORES_APP_ID
    ? line.catalogReference.catalogItemId ?? undefined
    : undefined;

// Statuses of a Gooper.io return whose units Wix hasn't refunded yet, or may
// have without Gooper.io knowing (NEEDS_ATTENTION). Wix has no return object
// to hold them, so these rows are what keeps two returns from claiming the
// same unit.
const IN_FLIGHT = [
  "IN_PROGRESS",
  "RETURN_REQUESTED",
  "RETURN_OPEN",
  "AWAITING_ITEM",
  "RECEIVING",
  "RETRYING",
  "NEEDS_ATTENTION",
];

// Units each order line has in Gooper.io returns that aren't refunded yet,
// leaving out the return with `exceptKey` (the one being refunded).
async function reservedUnits(shop: string, orderIds: string[], exceptKey?: string) {
  const reserved = new Map<string, number>();
  if (!orderIds.length) return reserved;
  const rows = await prisma.agentReturn.findMany({
    where: {
      shop,
      orderId: { in: orderIds },
      refundId: null,
      status: { in: IN_FLIGHT },
      ...(exceptKey ? { NOT: { idempotencyKey: exceptKey } } : {}),
    },
    select: { orderId: true, requestedLineItems: true },
  });
  for (const row of rows) {
    const items = Array.isArray(row.requestedLineItems) ? row.requestedLineItems : [];
    for (const entry of items) {
      const item = entry as { lineItemId?: unknown; quantity?: unknown } | null;
      if (typeof item?.lineItemId !== "string" || !Number.isInteger(item.quantity)) continue;
      const key = `${row.orderId}:${item.lineItemId}`;
      reserved.set(key, (reserved.get(key) ?? 0) + (item.quantity as number));
    }
  }
  return reserved;
}

// Builds the shared ReturnableOrder shape for Wix orders, with what each line
// can still be returned and refunded for.
async function returnableOrders(
  api: WixApi,
  rules: Rules,
  orders: WixOrder[],
  reserved: Map<string, number> = new Map(),
) {
  const eligible = orders.filter(orderIsRefundable);
  const finalSale = rules.finalSaleCollectionIds.slice(0, FINAL_SALE_COLLECTION_LIMIT);
  const [refundabilities, shipped, excluded] = await Promise.all([
    Promise.all(eligible.map((order) => getRefundability(api, order.id))),
    shippedQuantities(api, eligible),
    finalSaleProductIds(
      api,
      eligible.flatMap((order) =>
        (order.lineItems ?? []).flatMap((line) => {
          const productId = productIdOf(line);
          return productId && isPhysical(line) ? [productId] : [];
        }),
      ),
      finalSale,
    ),
  ]);
  const refundability = new Map(
    eligible.map((order, index) => [order.id, refundabilities[index]]),
  );
  return {
    refundability,
    orders: orders.map((order): ReturnableOrder => {
      const currencyCode = order.currency ?? "";
      const orderRefundability = refundability.get(order.id);
      const canRefund = Boolean(
        orderRefundability && refundablePayments(orderRefundability).length,
      );
      const lineRefunds = new Map(
        (orderRefundability?.lineItems ?? []).flatMap((entry) =>
          entry.lineItemId ? [[entry.lineItemId, entry] as const] : [],
        ),
      );
      const orderShipped = shipped.get(order.id);
      let finalSaleExcluded = false;
      const nodes = canRefund
        ? (order.lineItems ?? []).flatMap((line) => {
            if (!isPhysical(line)) return [];
            const ordered = line.quantity ?? 0;
            const refund = lineRefunds.get(line.id);
            const refunded = refund?.refundedQuantity ?? line.refundQuantity ?? 0;
            const available = refund?.availableRefundQuantity ?? ordered - refunded;
            const sent =
              orderShipped === "ALL" ? ordered : orderShipped?.get(line.id) ?? 0;
            // Refunded units may be ones that never shipped, so this errs on
            // the side of returning fewer.
            const quantity = Math.max(
              0,
              Math.min(available, ordered - refunded, sent - refunded) -
                (reserved.get(`${order.id}:${line.id}`) ?? 0),
            );
            if (quantity < 1) return [];
            const productId = productIdOf(line);
            if (productId && excluded.has(productId)) {
              finalSaleExcluded = true;
              return [];
            }
            return [
              {
                quantity,
                lineItem: {
                  id: line.id,
                  presentmentTitle:
                    line.productName?.translated?.trim() ||
                    line.productName?.original?.trim() ||
                    "Item",
                  currentTotalPrice: {
                    amount: line.totalPriceAfterTax?.amount ?? "0",
                    currencyCode,
                  },
                },
              },
            ];
          })
        : [];
      return {
        id: order.id,
        name: `#${order.number ?? ""}`,
        processedAt: order.createdDate ?? "",
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

function checkedEmail(email: string) {
  if (!EMAIL.test(email)) throw new Error("This store link has an invalid email.");
  return email;
}

export async function wixCustomerOrders(
  shop: string,
  access: { email: string },
  api: WixApi,
): Promise<{ customerId: string; orders: ReturnableOrder[] }> {
  const email = checkedEmail(access.email);
  const rules = await confirmedRules(shop);
  const { orders } = await searchByEmail(api, email, 20);
  // The search narrows the list; ownership is still checked on every order.
  const owned = (orders ?? []).filter((order) => order.id && ownedBy(order, email));
  const reserved = await reservedUnits(
    shop,
    owned.map((order) => order.id),
  );
  return {
    customerId: emailSubject(email),
    orders: (await returnableOrders(api, rules, owned, reserved)).orders,
  };
}

// Whether any order at the site was placed with this email, like
// hasOrdersForEmail for Shopify stores.
export async function hasWixOrdersForEmail(shop: string, email: string, api: WixApi) {
  if (!isWixStore(shop) || !EMAIL.test(email)) return false;
  const { orders } = await searchByEmail(api, email, 10);
  return (orders ?? []).some((order) => ownedBy(order, email));
}

// ---------------------------------------------------------------------------
// Calculation

function checkItems(order: ReturnableOrder, items: RequestedItem[]) {
  const seen = new Set<string>();
  if (!items.length)
    throw new Error("The selected item or quantity is not currently returnable.");
  for (const item of items) {
    const node = order.returnInformation.returnableLineItems.nodes.find(
      (entry) => entry.lineItem.id === item.lineItemId,
    );
    if (
      !node ||
      seen.has(item.lineItemId) ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > node.quantity
    )
      throw new Error("The selected item or quantity is not currently returnable.");
    seen.add(item.lineItemId);
  }
}

type CalculatedLine = {
  item?: { lineItemId?: string; quantity?: number };
  summary?: { total?: WixPrice; subtotal?: WixPrice; discount?: WixPrice };
};

// Wix works out what the items are worth back (after discounts, with tax, and
// without shipping); Gooper.io then takes off the merchant's confirmed fees.
//
// Restocking fee, matching Shopify's percentage restocking fee: the percent of
// each returned line's price after discounts and before tax (Wix's line
// subtotal minus its discount), rounded half up to the currency's minor unit
// per line. The flat return shipping fee is charged once per return, in the
// store's currency, and only when the order was paid in that currency.
async function quote(
  api: WixApi,
  rules: Rules,
  order: ReturnableOrder,
  items: RequestedItem[],
): Promise<ReturnCalculation> {
  checkItems(order, items);
  const currencyCode =
    order.returnInformation.returnableLineItems.nodes[0]?.lineItem.currentTotalPrice
      .currencyCode;
  if (!currencyCode) throw new Error(`Wix did not say which currency this order used. ${NOTHING_SUBMITTED}`);
  const digits = currencyDigits(currencyCode);
  const shipping = units(rules.returnShippingFee);
  if (shipping > 0n && currencyCode !== rules.currencyCode)
    throw new Error(
      `This order was paid in ${currencyCode}, but the store's return shipping fee is set in ${rules.currencyCode}. Gooper.io can't quote this return in chat, so the customer can use the store's own returns page or contact the store. ${NOTHING_SUBMITTED}`,
    );
  const percent = units(rules.restockingFeePercent);
  if (percent < 0n || percent > 100n * SCALE)
    throw new Error(`The store's restocking fee isn't set up correctly. ${NOTHING_SUBMITTED}`);

  const result = await api<{
    available?: boolean;
    notAvailable?: unknown;
    summary?: { total?: WixPrice };
    calculatedRefundItems?: { lineItems?: CalculatedLine[] };
  }>("POST", "/ecom/v1/order-billing/calculate-refund", {
    orderId: order.id,
    // No shipping entry: the original shipping charge isn't refunded.
    refundItems: {
      lineItems: items.map(({ lineItemId, quantity }) => ({ lineItemId, quantity })),
    },
  });
  const lines = result.calculatedRefundItems?.lineItems ?? [];
  if (result.available !== true || !lines.length)
    throw new Error(
      `The store can't refund these items right now, so this return can't be done in chat. The customer can contact the store. ${NOTHING_SUBMITTED}`,
    );
  const quantities = new Map<string, number>();
  let restocking = 0n;
  let lineTotal = 0n;
  for (const line of lines) {
    const id = line.item?.lineItemId;
    if (!id) throw new Error(`Wix could not calculate this return. ${NOTHING_SUBMITTED}`);
    quantities.set(id, (quantities.get(id) ?? 0) + (line.item?.quantity ?? 0));
    const discounted =
      units(line.summary?.subtotal?.amount ?? "0") -
      units(line.summary?.discount?.amount ?? "0");
    restocking += percentOf(discounted, percent, digits);
    lineTotal += units(line.summary?.total?.amount ?? "0");
  }
  // Wix must price exactly what was asked, nothing more or less.
  if (
    quantities.size !== items.length ||
    items.some((item) => quantities.get(item.lineItemId) !== item.quantity)
  )
    throw new Error(`Wix could not calculate this return. ${NOTHING_SUBMITTED}`);
  const credit = result.summary?.total?.amount
    ? units(result.summary.total.amount)
    : lineTotal;
  const refund = credit - restocking - shipping;
  if (credit <= 0n || refund <= 0n)
    throw new Error(
      `After the store's return fees, this return wouldn't give any money back, so it can't be done in chat. The customer can contact the store. ${NOTHING_SUBMITTED}`,
    );
  const money = (value: bigint) => ({ amount: decimal(value, digits), currencyCode });
  // A negative return total is money owed back to the customer, as in
  // Shopify's calculation. The order currency is the only currency, so it
  // fills both sides of the set.
  return {
    financialSummary: {
      returnTotalSet: { presentmentMoney: money(-refund), shopMoney: money(-refund) },
      ...(restocking > 0n
        ? { restockingFeeSubtotalSet: { presentmentMoney: money(restocking) } }
        : {}),
      ...(shipping > 0n
        ? { returnShippingFeeSubtotalSet: { presentmentMoney: money(shipping) } }
        : {}),
    },
    returnLineItems: {
      nodes: items.map((item) => ({
        lineItem: { id: item.lineItemId },
        quantity: item.quantity,
      })),
    },
  };
}

export async function calculateWixReturn(
  shop: string,
  order: ReturnableOrder,
  items: RequestedItem[],
  api: WixApi,
): Promise<ReturnCalculation> {
  const rules = await confirmedRules(shop);
  return quote(api, rules, order, items);
}

// ---------------------------------------------------------------------------
// Refunds

// Wix's Refund Payments takes no idempotency key, so the key's fingerprint is
// written into the refund's reason, which Wix keeps on the refund record. A
// retry looks for it first and returns the refund already made.
export function wixRefundReference(idempotencyKey: string) {
  const hash = createHash("sha256")
    .update(`wix-refund:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 16);
  return `Gooper.io ref ${hash}`;
}

function refundReason(reference: string, reason?: string) {
  const text = reason?.replace(/\s+/g, " ").trim();
  if (!text) return `Returned with ${reference}`;
  // Wix allows 200 characters; the reference always fits.
  const room = 200 - reference.length - 3;
  return `${text.slice(0, room)} (${reference})`;
}

export function wixRefundStatus(
  transactions: WixRefund["transactions"],
): WixRefundStatus {
  const statuses = (transactions ?? []).map((entry) => entry.refundStatus ?? "");
  if (!statuses.length) return "UNKNOWN";
  if (statuses.every((status) => status === "SUCCEEDED")) return "SUCCESS";
  if (statuses.every((status) => status === "FAILED")) return "FAILED";
  // Some money moved and some didn't: the merchant has to look.
  if (statuses.includes("FAILED")) return "UNKNOWN";
  if (
    statuses.every((status) =>
      ["SUCCEEDED", "PENDING", "SCHEDULED", "STARTED"].includes(status),
    )
  )
    return "PENDING";
  return "UNKNOWN";
}

// This return's own earlier refund, found by its reference; or, when the order
// was refunded some other way since the customer's request for any of these
// line items, a refusal to refund again (as Shopify's settledOrBlocked does).
type OrderTransactions = {
  refunds?: WixRefund[];
  payments?: Array<{
    giftcardPaymentDetails?: { voided?: boolean | null } | null;
    membershipPaymentDetails?: { voided?: boolean | null } | null;
  }>;
};

async function orderTransactionsOf(api: WixApi, orderId: string) {
  const { orderTransactions } = await api<{ orderTransactions?: OrderTransactions }>(
    "GET",
    `/ecom/v1/payments/orders/${encodeURIComponent(orderId)}`,
  );
  return orderTransactions ?? {};
}

// Wix refunds a gift card's or membership's whole credit rather than an
// amount, so an order paid partly that way can't be refunded exactly: the
// store handles it. Checked on Wix's own payment records, not payment names.
function assertNoStoredValuePayments(transactions: OrderTransactions) {
  if (
    (transactions.payments ?? []).some(
      (payment) =>
        (payment.giftcardPaymentDetails && !payment.giftcardPaymentDetails.voided) ||
        (payment.membershipPaymentDetails && !payment.membershipPaymentDetails.voided),
    )
  )
    throw new ReturnNotCreatedError(
      `This order was paid partly with a gift card or membership, so the store needs to handle this refund itself. The customer can contact the store. ${NOTHING_SUBMITTED}`,
    );
}

function findEarlierRefund(
  orderTransactions: OrderTransactions,
  reference: string,
  items: RequestedItem[],
  notBefore?: Date,
) {
  // A refund that failed outright moved no money, so it doesn't count.
  const refunds = (orderTransactions?.refunds ?? []).filter(
    (refund) => refund.id && wixRefundStatus(refund.transactions) !== "FAILED",
  );
  const earlier = refunds.find((refund) =>
    refund.details?.reason?.includes(reference),
  );
  if (earlier?.id)
    return { refundId: earlier.id, status: wixRefundStatus(earlier.transactions) };
  if (notBefore) {
    const lines = new Set(items.map((item) => item.lineItemId));
    const since = refunds.filter((refund) => {
      const created = Date.parse(refund.createdDate ?? "");
      // An undated refund can't be ruled out, so it counts as recent.
      return !Number.isFinite(created) || created >= notBefore.getTime() - 60_000;
    });
    if (
      since.some((refund) =>
        [...(refund.details?.items ?? []), ...(refund.details?.lineItems ?? [])].some(
          (line) => line.lineItemId && lines.has(line.lineItemId),
        ),
      )
    )
      throw new Error(
        "This order was refunded in Wix after the customer's request. Gooper.io issued no further refund; check the order in Wix.",
      );
  }
  return null;
}

async function getOrder(api: WixApi, orderId: string) {
  const { order } = await api<{ order?: WixOrder }>(
    "GET",
    `/ecom/v1/orders/${encodeURIComponent(orderId)}`,
  );
  if (!order?.id) throw new Error(`Wix could not find this order. ${NOTHING_SUBMITTED}`);
  return order;
}

// Splits the refund across the payments Wix can refund automatically, in the
// order Wix lists them.
function splitAcross(
  payments: Array<{ paymentId: string; maxRefund: bigint }>,
  amount: bigint,
  digits: number,
) {
  let remaining = amount;
  const parts: Array<{ paymentId: string; amount: { amount: string }; externalRefund: false }> = [];
  for (const payment of payments) {
    if (remaining <= 0n) break;
    const part = payment.maxRefund < remaining ? payment.maxRefund : remaining;
    parts.push({
      paymentId: payment.paymentId,
      amount: { amount: decimal(part, digits) },
      externalRefund: false,
    });
    remaining -= part;
  }
  if (remaining > 0n)
    throw new ReturnNotCreatedError(
      `The store's payment provider can't refund this amount to the original payment right now. The customer can contact the store. ${NOTHING_SUBMITTED}`,
    );
  return parts;
}

// Everything checked before Wix is asked to move money. Nothing here changes
// anything, so any failure means no refund was made.
async function prepareRefund(
  input: {
    shop: string;
    orderId: string;
    items: RequestedItem[];
    amount: Money;
    idempotencyKey: string;
  },
  api: WixApi,
) {
  const rules = await confirmedRules(input.shop);
  const wixOrder = await getOrder(api, input.orderId);
  if (!orderIsRefundable(wixOrder))
    throw new Error(`This order can't be refunded right now. ${NOTHING_SUBMITTED}`);
  const built = await returnableOrders(
    api,
    rules,
    [wixOrder],
    await reservedUnits(input.shop, [wixOrder.id], input.idempotencyKey),
  );
  const calculation = await quote(api, rules, built.orders[0], input.items);
  const total = calculation.financialSummary.returnTotalSet.presentmentMoney;
  const owed = -units(total.amount);
  if (
    total.currencyCode !== input.amount.currencyCode ||
    owed !== units(input.amount.amount)
  )
    throw new Error(
      `The refund for this return has changed since it was confirmed (it's now ${decimal(owed, currencyDigits(total.currencyCode))} ${total.currencyCode}). ${NOTHING_SUBMITTED}`,
    );
  const refundability = built.refundability.get(wixOrder.id);
  const payments = refundability ? refundablePayments(refundability) : [];
  if (!payments.length)
    throw new Error(
      `The store's payment provider can't refund this order automatically. The customer can contact the store. ${NOTHING_SUBMITTED}`,
    );
  return splitAcross(payments, owed, currencyDigits(total.currencyCode));
}

// Whether these units are still free for the return with this key, counting
// every other Gooper.io return on the order that Wix hasn't refunded yet.
// Called once that return's record exists, so two confirmations racing for the
// same unit can't both go ahead. Throws ReturnNotCreatedError: nothing moved.
export async function assertWixUnitsFree(
  input: { shop: string; orderId: string; items: RequestedItem[]; idempotencyKey: string },
  api: WixApi,
) {
  // Only reads, so any failure here means nothing moved.
  return checkUnitsFree(input, api).catch((error: unknown) => {
    if (error instanceof ReturnNotCreatedError) throw error;
    throw new ReturnNotCreatedError(
      error instanceof Error && error.message
        ? `${error.message} ${NOTHING_SUBMITTED}`
        : `Gooper.io couldn't check this order with Wix. ${NOTHING_SUBMITTED}`,
    );
  });
}

async function checkUnitsFree(
  input: { shop: string; orderId: string; items: RequestedItem[]; idempotencyKey: string },
  api: WixApi,
) {
  const rules = await confirmedRules(input.shop);
  const [wixOrder, transactions] = await Promise.all([
    getOrder(api, input.orderId),
    orderTransactionsOf(api, input.orderId),
  ]);
  assertNoStoredValuePayments(transactions);
  const built = await returnableOrders(
    api,
    rules,
    [wixOrder],
    await reservedUnits(input.shop, [wixOrder.id], input.idempotencyKey),
  );
  const free = new Map(
    built.orders[0].returnInformation.returnableLineItems.nodes.map((node) => [
      node.lineItem.id,
      node.quantity,
    ]),
  );
  if (input.items.some((item) => item.quantity > (free.get(item.lineItemId) ?? 0)))
    throw new ReturnNotCreatedError(
      `Some of these items are already part of another return. ${NOTHING_SUBMITTED}`,
    );
}

// Refunds the returned items to the original payment. `amount` is the refund
// the customer confirmed; Gooper.io recalculates it (fees included) and refuses
// if it no longer matches exactly.
//
// Retries are safe: Wix's Refund Payments has no idempotency key, so the
// refund's reason carries a fingerprint of `idempotencyKey`, and an earlier
// refund with that fingerprint is returned instead of refunding again. Two
// calls with the same key at the same moment could still both refund; the
// caller runs one attempt per return at a time.
//
// Throws ReturnNotCreatedError only when no money moved: a check before the
// refund failed, or Wix turned the request down without running it.
export async function refundWixReturn(
  input: {
    shop: string;
    orderId: string;
    items: RequestedItem[];
    amount: Money;
    restock: boolean;
    idempotencyKey: string;
    reason?: string;
    // When the customer asked for this return. A refund of these items made
    // since then outside this return stops this one.
    notBefore?: Date;
  },
  api: WixApi,
): Promise<{ refundId: string; status: WixRefundStatus }> {
  if (!input.idempotencyKey) throw new Error("A refund needs an idempotency key.");
  const reference = wixRefundReference(input.idempotencyKey);
  // A failure here leaves open whether an earlier attempt refunded, so it is
  // not reported as "nothing submitted".
  const transactions = await orderTransactionsOf(api, input.orderId);
  const earlier = findEarlierRefund(transactions, reference, input.items, input.notBefore);
  if (earlier) return earlier;
  assertNoStoredValuePayments(transactions);

  const paymentRefunds = await prepareRefund(input, api).catch((error: unknown) => {
    if (error instanceof ReturnNotCreatedError) throw error;
    throw new ReturnNotCreatedError(
      error instanceof Error && error.message
        ? error.message
        : `Gooper.io couldn't prepare the refund. ${NOTHING_SUBMITTED}`,
    );
  });
  const lineItems = input.items.map(({ lineItemId, quantity }) => ({
    lineItemId,
    quantity,
  }));
  let response: { refund?: WixRefund };
  try {
    response = await api<{ refund?: WixRefund }>(
      "POST",
      "/ecom/v1/order-billing/refund-payments",
      {
        orderId: input.orderId,
        paymentRefunds,
        refundItems: { lineItems },
        sideEffects: {
          ...(input.restock ? { restock: { lineItems } } : {}),
          notifications: { sendCustomerEmail: true },
        },
        customerReason: refundReason(reference, input.reason),
      },
      { idempotencyKey: input.idempotencyKey },
    );
  } catch (error) {
    if (error instanceof WixApiError && error.rejected)
      throw new ReturnNotCreatedError(
        `Wix didn't accept the refund: ${error.message}`,
      );
    throw error;
  }
  const refund = response.refund;
  if (!refund?.id)
    throw new Error(
      "Wix didn't confirm the refund. Check the order in Wix before trying again.",
    );
  return { refundId: refund.id, status: wixRefundStatus(refund.transactions) };
}

// ---------------------------------------------------------------------------
// Restocking after the refund

const V1_DEFAULT_VARIANT = "00000000-0000-0000-0000-000000000000";

// Wix restocks through a refund's side effects, and has no order endpoint to
// restock later. When the refund went out before the item came back, the
// returned units are added straight to Wix Stores inventory instead.
//
// This is not idempotent (a second call adds the units again), and the order
// itself won't show the units as restocked.
export async function restockWixItems(
  input: { shop: string; orderId: string; items: RequestedItem[] },
  api: WixApi,
) {
  if (!isWixStore(input.shop)) throw new Error("This store isn't a Wix store.");
  if (!input.items.length) return;
  const order = await getOrder(api, input.orderId);
  const lines = input.items.map((item) => {
    const line = order.lineItems?.find((entry) => entry.id === item.lineItemId);
    const productId = line ? productIdOf(line) : undefined;
    if (
      !line ||
      !productId ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > (line.quantity ?? 0)
    )
      throw new Error(
        "Gooper.io can only restock Wix Stores products from this order. Restock this item in Wix.",
      );
    const options = line.catalogReference?.options ?? {};
    // UNVERIFIED: Wix Stores lines carry the variant as options.variantId in
    // both catalogs; a V1 product without variants uses the all-zero variant.
    const variantId =
      typeof options.variantId === "string"
        ? options.variantId
        : options.options
          ? undefined
          : V1_DEFAULT_VARIANT;
    if (!variantId)
      throw new Error(
        "Gooper.io couldn't tell which variant to restock. Restock this item in Wix.",
      );
    return { productId, variantId, line, quantity: item.quantity };
  });
  const version = await wixCatalogVersion(api);
  if (version === "V1_CATALOG") {
    await api("POST", "/stores/v2/inventoryItems/increment", {
      incrementData: lines.map((entry) => ({
        productId: entry.productId,
        variantId: entry.variantId,
        incrementBy: entry.quantity,
      })),
    });
    return;
  }
  if (version !== "V3_CATALOG")
    throw new Error("Wix Stores isn't installed on this site, so there's nothing to restock.");
  const { results } = await api<{
    results?: Array<{
      itemMetadata?: { success?: boolean; error?: { description?: string } };
    }>;
  }>("POST", "/stores/v3/bulk/inventory-items/increment-by-variant-and-location", {
    incrementData: lines.map((entry) => {
      // Back to the location the order was fulfilled from, when Wix says.
      const locationId = entry.line.locations?.find((location) => location.id)?.id;
      return {
        variantId: entry.variantId,
        ...(locationId ? { locationId } : {}),
        incrementBy: entry.quantity,
      };
    }),
  });
  const failed = (results ?? []).filter((result) => result.itemMetadata?.success === false);
  if (failed.length)
    throw new Error(
      `Wix couldn't restock ${failed.length === 1 ? "one item" : `${failed.length} items`}. Restock ${failed.length === 1 ? "it" : "them"} in Wix.`,
    );
}

export { listWixCollections } from "./wix-catalog.server";
