import { createHmac } from "node:crypto";

export type RequestedItem = {
  lineItemId: string;
  quantity: number;
};

function normalizedItems(items: RequestedItem[]) {
  return [...items].sort((a, b) =>
    a.lineItemId === b.lineItemId
      ? a.quantity - b.quantity
      : a.lineItemId.localeCompare(b.lineItemId),
  );
}

export function sameReturnItems(left: unknown, right: RequestedItem[]) {
  if (!Array.isArray(left)) return false;
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

export function hashCustomerId(customerId: string, secret: string) {
  if (!secret) {
    throw new Error("A secret is required for customer identity hashing.");
  }
  return createHmac("sha256", secret).update(customerId).digest("hex");
}
