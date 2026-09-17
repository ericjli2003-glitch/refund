import prisma from "../db.server";
import {
  dispatchPaymentIntents,
  reconcilePaymentIntents,
  type fundedPaymentProvider,
} from "./funded-payment-intents.server";
import { requireFundedSandbox } from "./funded-return-sandbox.server";

// Background dispatch and reconciliation for funded payments. The merchant
// screen dispatches inline for immediate feedback; this is the path a real
// deployment would rely on. It is still sandbox-only and moves no real money.

type Provider = ReturnType<typeof fundedPaymentProvider>;

// How long an intent may sit unresolved before it is worth a human looking.
export const STUCK_AFTER_MS = 15 * 60_000;
export const UNDISPATCHED_AFTER_MS = 5 * 60_000;

export type FundedPaymentsHealth = {
  review: number;
  stuck: number;
  undispatched: number;
  oldestUnresolvedMinutes: number | null;
};

// What a real deployment would alert on. Counts only, no money decisions.
export async function fundedPaymentsHealth(
  provider: Provider,
  now = new Date(),
): Promise<FundedPaymentsHealth> {
  const scope = { provider: provider.name };
  const unresolved = { in: ["QUEUED", "SUBMITTING", "PENDING", "UNKNOWN"] };
  const [review, stuck, undispatched, oldest] = await Promise.all([
    prisma.fundedPaymentIntent.count({ where: { ...scope, status: "REVIEW" } }),
    prisma.fundedPaymentIntent.count({
      where: {
        ...scope,
        status: { in: ["PENDING", "UNKNOWN", "SUBMITTING"] },
        createdAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) },
      },
    }),
    prisma.fundedPaymentIntent.count({
      where: {
        ...scope,
        status: "QUEUED",
        createdAt: { lt: new Date(now.getTime() - UNDISPATCHED_AFTER_MS) },
      },
    }),
    prisma.fundedPaymentIntent.findFirst({
      where: { ...scope, status: unresolved },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  return {
    review,
    stuck,
    undispatched,
    oldestUnresolvedMinutes: oldest
      ? Math.floor((now.getTime() - oldest.createdAt.getTime()) / 60_000)
      : null,
  };
}

export type FundedPaymentsCycle = {
  submitted: number;
  checked: number;
  resubmitted: number;
  recovered: number;
  review: number;
  health: FundedPaymentsHealth;
};

// One pass over every shop's intents. Dispatch precedes reconciliation so a new
// intent is submitted before anything asks the provider about it.
export async function runFundedPaymentsCycle(
  provider: Provider,
  { now = new Date(), limit = 50 }: { now?: Date; limit?: number } = {},
): Promise<FundedPaymentsCycle> {
  requireFundedSandbox();
  const dispatched = await dispatchPaymentIntents(provider, { now, limit });
  const reconciled = await reconcilePaymentIntents(provider, { now, limit });
  return {
    submitted: dispatched.submitted,
    ...reconciled,
    health: await fundedPaymentsHealth(provider, now),
  };
}

export function describeFundedPaymentsCycle(cycle: FundedPaymentsCycle) {
  const { health } = cycle;
  const attention = [
    health.review && `${health.review} held for review`,
    health.stuck && `${health.stuck} unresolved over 15m`,
    health.undispatched && `${health.undispatched} never submitted over 5m`,
  ].filter(Boolean);
  return [
    `submitted ${cycle.submitted}`,
    `checked ${cycle.checked}`,
    `resubmitted ${cycle.resubmitted}`,
    `recovered ${cycle.recovered}`,
    attention.length ? `NEEDS ATTENTION: ${attention.join(", ")}` : "clear",
  ].join(" · ");
}
