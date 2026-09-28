import prisma from "../../db.server";
import type { Money } from "../automatic-return.server";
import { ReturnNotCreatedError, type RequestedItem } from "../return-guards.server";
import type { WixApi } from "./wix-api.server";
import { wixApiFor } from "./wix-client.server";
import { refundWixReturn, restockWixItems } from "./wix-returns.server";

// Wix has no return object of its own, so a Wix return is Gooper.io's record:
// its returnId is minted here, and the only thing Gooper.io asks of Wix is the
// refund (and, when the item comes back, the restock).
export const wixReturnId = (recordId: string) => `gooper-return:${recordId}`;

type ReturnRecord = {
  id: string;
  shop: string;
  orderId: string;
  idempotencyKey: string;
  refundTiming: string | null;
};

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

async function refund(
  api: WixApi,
  record: ReturnRecord,
  items: RequestedItem[],
  amount: Money,
  restock: boolean,
) {
  const result = await refundWixReturn(
    {
      shop: record.shop,
      orderId: record.orderId,
      items,
      amount,
      restock,
      idempotencyKey: record.idempotencyKey,
    },
    api,
  );
  return prisma.agentReturn.update({
    where: { id: record.id },
    data: {
      status: "REFUND_SUBMITTED",
      returnStatus: "CLOSED",
      refundId: result.refundId,
      refundStatus: result.status,
      failureReason: result.status === "FAILED" ? "Wix reported the refund as failed." : null,
      ...(result.status === "FAILED" ? { status: "NEEDS_ATTENTION" } : {}),
    },
  });
}

// Called once the AgentReturn row exists and every shared check has passed.
// Immediate refunds go out now, without restocking: the item hasn't shipped
// back yet. On-receipt returns wait for the merchant to mark the item received.
export async function submitWixReturn({
  record,
  items,
  confirmed,
  api,
}: {
  record: ReturnRecord;
  items: RequestedItem[];
  confirmed: Money;
  api?: WixApi;
}) {
  const returnId = wixReturnId(record.id);
  await prisma.agentReturn.update({
    where: { id: record.id },
    data: { returnId, status: "RETURN_OPEN", returnStatus: "OPEN" },
  });
  if (record.refundTiming === "ON_RECEIPT")
    return prisma.agentReturn.update({
      where: { id: record.id },
      data: { status: "AWAITING_ITEM" },
    });
  const client = api ?? (await wixApiFor(record.shop));
  try {
    return await refund(client, record, items, confirmed, false);
  } catch (error) {
    // A clear refusal from Wix moved no money, so the customer can confirm
    // again. Anything else may have refunded, so the merchant checks first.
    const refused = error instanceof ReturnNotCreatedError;
    await prisma.agentReturn.update({
      where: { id: record.id },
      data: refused
        ? {
            status: "NOT_SUBMITTED",
            returnId: null,
            returnStatus: null,
            failureReason: errorText(error, "Wix refused the refund."),
          }
        : {
            status: "NEEDS_ATTENTION",
            failureReason: errorText(error, "Unknown Wix refund error."),
          },
    });
    if (refused)
      throw new Error(
        `Nothing was submitted and no refund was issued: Wix didn't accept the refund (${errorText(error, "no reason given")}). It's safe to confirm again once that's sorted out, or the customer can contact the store.`,
      );
    throw error;
  }
}

// Merchant recovery for a Wix return that needs attention. refundWixReturn
// finds a refund an earlier attempt already made instead of refunding twice.
export async function retryWixReturn(
  record: ReturnRecord & { amount: string; currencyCode: string; itemReceivedAt: Date | null },
  items: RequestedItem[],
  api?: WixApi,
) {
  if (record.refundTiming === "ON_RECEIPT" && !record.itemReceivedAt)
    return prisma.agentReturn.update({
      where: { id: record.id },
      data: { status: "AWAITING_ITEM", returnStatus: "OPEN", failureReason: null },
    });
  const client = api ?? (await wixApiFor(record.shop));
  return refund(
    client,
    record,
    items,
    { amount: record.amount, currencyCode: record.currencyCode },
    // An on-receipt return's item is back, so its refund restocks it.
    record.refundTiming === "ON_RECEIPT",
  );
}

// The merchant confirms the item is back. An on-receipt return is refunded and
// restocked together; an already refunded return is only restocked.
export async function receiveWixReturn(
  record: ReturnRecord & { amount: string; currencyCode: string },
  items: RequestedItem[],
  restock: boolean,
  api?: WixApi,
) {
  const client = api ?? (await wixApiFor(record.shop));
  if (record.refundTiming === "ON_RECEIPT")
    return refund(
      client,
      record,
      items,
      { amount: record.amount, currencyCode: record.currencyCode },
      restock,
    );
  if (restock)
    await restockWixItems(
      { shop: record.shop, orderId: record.orderId, items },
      client,
    );
  return prisma.agentReturn.update({
    where: { id: record.id },
    data: { failureReason: null },
  });
}
