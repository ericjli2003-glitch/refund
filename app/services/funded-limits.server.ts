import type { Prisma } from "@prisma/client";
import { sandboxBalances, sandboxStateSchema } from "../funded-return-sandbox";
import { lockFunding } from "./funded-entitlements.server";

// Funding limits, checked when a payout is requested: the only moment Gooper's
// money leaves. Defaults are the proposed pilot numbers pending the founder's
// confirmation, and can be overridden per environment. All amounts are cents.
export type FundingLimits = {
  paused: boolean;
  perReturnMinor: number;
  perMerchantMinor: number;
  portfolioMinor: number;
};

function cents(value: string | undefined, fallback: number) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`Invalid funding limit: ${value}`);
  return parsed;
}

export function fundingLimits(environment = process.env): FundingLimits {
  return {
    paused: environment.GOOPER_FUNDED_PAUSED === "1",
    perReturnMinor: cents(environment.GOOPER_FUNDED_MAX_PER_RETURN_CENTS, 15_000),
    perMerchantMinor: cents(environment.GOOPER_FUNDED_MAX_PER_MERCHANT_CENTS, 150_000),
    portfolioMinor: cents(environment.GOOPER_FUNDED_MAX_PORTFOLIO_CENTS, 1_400_000),
  };
}

// What Gooper could still lose on a case: a payout in flight counts in full;
// after a successful payout, whatever isn't repaid yet (funded exposure,
// including rejected amounts, plus approved but unsettled repayment).
function outstandingMinor(snapshot: unknown) {
  const state = sandboxStateSchema.parse(snapshot);
  if (state.payout === "PENDING" || state.payout === "UNKNOWN")
    return { currency: state.currency, minor: state.amountMinor };
  if (state.payout !== "SUCCEEDED") return { currency: state.currency, minor: 0 };
  const balances = sandboxBalances(state);
  return {
    currency: state.currency,
    minor: balances.FUNDED_EXPOSURE + balances.MERCHANT_RECEIVABLE,
  };
}

// Returns a readable reason when a new payout would break a limit. Runs inside
// the payout request's transaction, under locks shared by every payout, so two
// concurrent payouts can't both fit under a cap that only has room for one.
export async function fundingLimitProblem(
  transaction: Prisma.TransactionClient,
  shop: string,
  amountMinor: number,
  currency: string,
  limits = fundingLimits(),
) {
  if (limits.paused) return "New funded payouts are paused.";
  if (amountMinor > limits.perReturnMinor)
    return `This return is above the ${(limits.perReturnMinor / 100).toFixed(2)} per-return limit.`;
  await lockFunding(transaction, "portfolio", "limits");
  const rows = await transaction.fundedReturnSandbox.findMany({
    select: { shop: true, snapshot: true },
  });
  let merchant = 0;
  let portfolio = 0;
  for (const row of rows) {
    const outstanding = outstandingMinor(row.snapshot);
    if (outstanding.currency !== currency) continue;
    portfolio += outstanding.minor;
    if (row.shop === shop) merchant += outstanding.minor;
  }
  if (merchant + amountMinor > limits.perMerchantMinor)
    return "This store has reached its limit of unrepaid funded returns.";
  if (portfolio + amountMinor > limits.portfolioMinor)
    return "Gooper has reached its total limit of unrepaid funded returns.";
  return null;
}
