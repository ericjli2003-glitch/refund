export type SuggestedRefundTransaction = {
  amountSet: { presentmentMoney: { amount: string; currencyCode: string } };
  gateway: string | null;
  parentTransaction: {
    id: string;
    gateway: string | null;
    manualPaymentGateway: boolean;
  } | null;
};

export function buildReturnApprovalVariables(returnId: string) {
  return { input: { id: returnId } };
}

function validateSuggestedTransactions(
  suggestedTransactions: SuggestedRefundTransaction[],
  expectedRefund: { amount: string; currencyCode: string },
) {
  const invalid = () => new Error(
    "Shopify could not verify the full refund through the original payment processor. No payment was submitted; contact the merchant about this return.",
  );
  const amounts = [expectedRefund.amount, ...suggestedTransactions.map(
    (transaction) => transaction.amountSet.presentmentMoney.amount,
  )];
  if (!suggestedTransactions.length || amounts.some(
    (amount) => !/^\d+(\.\d+)?$/.test(amount) || amount.length > 40,
  )) throw invalid();
  // Compare split payments exactly, including currencies with zero or three
  // decimal places, without introducing floating-point rounding errors.
  const precision = Math.max(...amounts.map((amount) => amount.split(".")[1]?.length || 0));
  const units = (amount: string) => {
    const [whole, fractional = ""] = amount.split(".");
    return BigInt(whole + fractional.padEnd(precision, "0"));
  };
  const parents = new Set<string>();
  let total = 0n;
  for (const transaction of suggestedTransactions) {
    const parent = transaction.parentTransaction;
    if (!parent || !/^gid:\/\/shopify\/OrderTransaction\/\d+$/.test(parent.id) ||
        parent.manualPaymentGateway !== false || !transaction.gateway ||
        transaction.gateway !== parent.gateway || parents.has(parent.id) ||
        transaction.amountSet.presentmentMoney.currencyCode !== expectedRefund.currencyCode ||
        units(transaction.amountSet.presentmentMoney.amount) <= 0n) throw invalid();
    parents.add(parent.id);
    total += units(transaction.amountSet.presentmentMoney.amount);
  }
  if (total !== units(expectedRefund.amount)) throw invalid();
  return suggestedTransactions;
}

// returnProcess carries the refund inline as part of ReturnProcessRefundInput.
export function buildReturnProcessTransactions(
  suggestedTransactions: SuggestedRefundTransaction[],
  expectedRefund: { amount: string; currencyCode: string },
) {
  return validateSuggestedTransactions(suggestedTransactions, expectedRefund).map(
    (transaction) => ({
      parentId: transaction.parentTransaction!.id,
      transactionAmount: {
        amount: transaction.amountSet.presentmentMoney.amount,
        currencyCode: transaction.amountSet.presentmentMoney.currencyCode,
      },
    }),
  );
}
