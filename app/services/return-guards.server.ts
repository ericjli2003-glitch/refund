import { createHmac } from "node:crypto";

export type RequestedItem = {
  lineItemId: string;
  quantity: number;
};

// Shopify turned a return request down before creating a return, so nothing
// was submitted and the customer can try again.
export class ReturnNotCreatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReturnNotCreatedError";
  }
}

function normalizedItems(items: RequestedItem[]) {
  // JSONB does not preserve object-key order. Canonicalize fields as well as
  // array order before comparing a stored request with its signed quote.
  return items.map(({ lineItemId, quantity }) => ({ lineItemId, quantity })).sort((a, b) =>
    a.lineItemId === b.lineItemId
      ? a.quantity - b.quantity
      : a.lineItemId.localeCompare(b.lineItemId),
  );
}

export function sameReturnItems(left: unknown, right: RequestedItem[]) {
  if (!Array.isArray(left) || left.some(item =>
    !item || typeof item !== "object" || typeof item.lineItemId !== "string" ||
    !Number.isInteger(item.quantity) || item.quantity < 1,
  )) return false;
  return (
    JSON.stringify(normalizedItems(left as RequestedItem[])) ===
    JSON.stringify(normalizedItems(right))
  );
}

export function hasDuplicateLineItems(items: RequestedItem[]) {
  return new Set(items.map((item) => item.lineItemId)).size !== items.length;
}

export function moneyIsAbove(amount: string, maximum: string) {
  const value = Number(amount);
  const limit = Number(maximum);
  return !Number.isFinite(value) || !Number.isFinite(limit) || value > limit;
}

export function moneyAmountsMatch(left: string, right: string) {
  const leftAmount = Number(left);
  const rightAmount = Number(right);
  return (
    Number.isFinite(leftAmount) &&
    Number.isFinite(rightAmount) &&
    leftAmount === rightAmount
  );
}

// Customer Account returnCalculate expresses customer credits as negative totals.
// Never use Math.abs: a positive total means the customer owes money, not a refund.
export function refundFromReturnTotal(total: {
  amount: string;
  currencyCode: string;
}) {
  if (
    !/^-?\d+(\.\d+)?$/.test(total.amount) ||
    !Number.isFinite(Number(total.amount))
  ) {
    throw new Error(
      "Shopify did not return a valid refund amount. Nothing was submitted.",
    );
  }
  if (Number(total.amount) >= 0) {
    throw new Error(
      `Shopify calculated a return balance of ${total.amount} ${total.currencyCode}, with no money owed back to you. Nothing was submitted.`,
    );
  }
  return { ...total, amount: total.amount.slice(1) };
}

export function hashCustomerId(customerId: string, secret: string) {
  if (!secret) {
    throw new Error("A secret is required for customer identity hashing.");
  }
  return createHmac("sha256", secret).update(customerId).digest("hex");
}
