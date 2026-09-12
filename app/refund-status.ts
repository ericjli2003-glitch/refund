// A Shopify refund record is not proof that money reached the customer's bank.
export function refundPaymentStatus(
  transactions: Array<{ kind: string; status: string }>,
  hasMore = false,
) {
  const refunds = transactions.filter((transaction) => transaction.kind.toUpperCase() === "REFUND");
  const statuses = refunds.map((transaction) => transaction.status.toUpperCase());
  if (statuses.some((status) => status === "FAILURE" || status === "ERROR")) return "FAILED";
  if (hasMore || !statuses.length) return "UNKNOWN";
  if (statuses.every((status) => status === "SUCCESS")) return "SUCCESS";
  if (statuses.every((status) => ["SUCCESS", "PENDING", "AWAITING_RESPONSE"].includes(status))) return "PENDING";
  return "UNKNOWN";
}

export function describeRefundProgress(record: { status: string; refundStatus?: string | null }) {
  if (record.status === "NEEDS_ATTENTION" || record.refundStatus === "FAILED") {
    return {
      title: "Merchant review needed",
      message: "This return needs the merchant's attention. A refund may be incomplete. Contact the merchant and do not submit another refund for these items.",
    };
  }
  if (["REFUND_SUBMITTED", "REFUND_RECORDED"].includes(record.status)) {
    return {
      title: record.refundStatus === "SUCCESS" ? "Refund processed by Shopify" : "Refund submitted",
      message: record.refundStatus === "SUCCESS"
        ? "Shopify reports successful refund processing through the original payment processor. Your bank may still take time to post the credit. Follow the store's instructions for sending the item back."
        : "Shopify has recorded your refund request to the original payment method. Payment completion is not yet confirmed here. Bank posting time may vary. Follow the store's instructions for sending the item back.",
    };
  }
  return {
    title: "Return submission in progress",
    message: "A return submission has started. No completed payment is confirmed here. Check its status before attempting anything else; contact the merchant if it remains unchanged.",
  };
}
