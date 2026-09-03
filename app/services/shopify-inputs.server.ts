type SuggestedRefundTransaction = {
  amountSet: { presentmentMoney: { amount: string } };
  gateway: string;
  parentTransaction: { id: string } | null;
};

export function buildReturnApprovalVariables(returnId: string) {
  return { input: { id: returnId } };
}

export function buildRefundTransactions(
  orderId: string,
  suggestedTransactions: SuggestedRefundTransaction[],
) {
  return suggestedTransactions.map((transaction) => ({
    amount: transaction.amountSet.presentmentMoney.amount,
    gateway: transaction.gateway,
    kind: "REFUND" as const,
    orderId,
    parentId: transaction.parentTransaction?.id,
  }));
}
