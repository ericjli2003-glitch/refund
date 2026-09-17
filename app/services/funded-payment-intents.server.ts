import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import {
  caseActionFor,
  intentStatusSchema,
  matchPaymentObservation,
  paymentOperationSchema,
  type ObservationDisposition,
  type PaymentObservation,
  type PaymentOperation,
} from "../funded-payment-matching";
import {
  SandboxError,
  sandboxNextPayment,
  sandboxOperationReference,
  sandboxStateSchema,
  type SandboxOperation,
} from "../funded-return-sandbox";
import {
  applyCaseCommand,
  CaseVersionConflict,
  requireFundedSandbox,
} from "./funded-return-sandbox.server";
import {
  derivedId,
  type FundedPaymentProvider,
  type PaymentInstruction,
  type SubmitResult,
} from "./funded-payment-provider.server";
import { sandboxPaymentProvider } from "./funded-sandbox-provider.server";

type Transaction = Prisma.TransactionClient;
type Intent = Awaited<
  ReturnType<typeof prisma.fundedPaymentIntent.findUniqueOrThrow>
>;

export const SUBMISSION_LEASE_MS = 60_000;
export const MAX_SUBMISSIONS = 5;
const RETRYABLE_ATTEMPTS = 4;

// The only provider resolution. There is no live branch, credential lookup or
// environment switch; a live adapter requires a reviewed code change.
export function fundedPaymentProvider(): FundedPaymentProvider {
  requireFundedSandbox();
  const provider = sandboxPaymentProvider;
  if (provider.environment !== "SANDBOX" || provider.idempotentSubmit !== true)
    throw new Error("Funded payments require an idempotent sandbox provider.");
  return provider;
}

function checkDelayMs(count: number) {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, count - 1));
}

const operationName = (operation: SandboxOperation): PaymentOperation =>
  operation === "payout" ? "PAYOUT" : "COLLECTION";

class IntentChanged extends Error {}

async function withRetry<T>(work: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      const retryable =
        error instanceof IntentChanged ||
        error instanceof CaseVersionConflict ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034");
      if (!retryable || attempt >= RETRYABLE_ATTEMPTS) throw error;
    }
  }
}

function instructionFor(intent: Intent): PaymentInstruction {
  return {
    idempotencyKey: intent.id,
    shop: intent.shop,
    caseId: intent.caseId,
    operation: paymentOperationSchema.parse(intent.operation),
    attempt: intent.attempt,
    amountMinor: intent.amountMinor,
    currency: z.enum(["CAD", "USD"]).parse(intent.currency),
  };
}

function bindingFor(intent: Intent) {
  return {
    intentId: intent.id,
    attempt: intent.attempt,
    amountMinor: intent.amountMinor,
    currency: z.enum(["CAD", "USD"]).parse(intent.currency),
  };
}

// Creates the payment request and its durable intent atomically. Nothing is
// sent to a provider here; dispatch happens only after this commits.
export async function requestSandboxPayment(input: {
  shop: string;
  caseId: string;
  version: number;
  commandId: string;
  operation: SandboxOperation;
}) {
  const provider = fundedPaymentProvider();
  const { shop, caseId, version, commandId, operation } = z
    .object({
      shop: z.string().min(1),
      caseId: z.string().uuid(),
      version: z.number().int().nonnegative(),
      commandId: z.string().uuid(),
      operation: z.enum(["payout", "collection"]),
    })
    .parse(input);
  const intentId = derivedId("funded-intent", shop, caseId, commandId);
  await prisma.$transaction(async (transaction) => {
    const row = await transaction.fundedReturnSandbox.findUnique({
      where: { shop_id: { shop, id: caseId } },
    });
    if (!row) throw new SandboxError("Sample return not found for this store.");
    const state = sandboxStateSchema.parse(row.snapshot);
    if (state.events.some((event) => event.command.id === commandId)) return;
    // A held payout says nothing about whether approved principal is owed,
    // so a hold only blocks further requests of the same kind.
    const held = await transaction.fundedPaymentIntent.count({
      where: { shop, caseId, operation: operationName(operation), status: "REVIEW" },
    });
    if (held)
      throw new SandboxError(
        `A ${operation} for this sample needs review before another request.`,
      );
    const payment = { ...sandboxNextPayment(state, operation), intentId };
    await applyCaseCommand(transaction, shop, caseId, version, {
      id: commandId,
      action: operation === "payout" ? "REQUEST_PAYOUT" : "REQUEST_COLLECTION",
      payment,
    });
    await transaction.fundedPaymentIntent.create({
      data: {
        id: intentId,
        shop,
        caseId,
        operation: operationName(operation),
        attempt: payment.attempt,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        provider: provider.name,
      },
    });
  });
  return prisma.fundedPaymentIntent.findUniqueOrThrow({
    where: { id: intentId },
  });
}

async function writeEvent(
  transaction: Transaction,
  provider: FundedPaymentProvider,
  data: {
    providerEventId: string;
    source: "WEBHOOK" | "SUBMIT" | "LOOKUP";
    intent: Intent | null;
    status: string;
    disposition: string;
    detail?: string | null;
    payload: Prisma.InputJsonValue;
  },
) {
  await transaction.fundedPaymentEvent.create({
    data: {
      provider: provider.name,
      providerEventId: data.providerEventId,
      source: data.source,
      shop: data.intent?.shop ?? null,
      intentId: data.intent?.id ?? null,
      status: data.status,
      disposition: data.disposition,
      detail: data.detail ?? null,
      payload: data.payload,
    },
  });
}

async function updateIntent(
  transaction: Transaction,
  intent: Intent,
  data: Prisma.FundedPaymentIntentUpdateManyMutationInput,
) {
  const changed = await transaction.fundedPaymentIntent.updateMany({
    where: { id: intent.id, version: intent.version },
    data: { ...data, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new IntentChanged();
}

const heldDispositions = new Set<string>([
  "MISMATCH",
  "CONTRADICTION",
  "REVERSAL",
  "HELD_FOR_REVIEW",
  "CASE_REJECTED",
  "UNMATCHED",
]);

export type RecordedDisposition =
  | ObservationDisposition
  | "DUPLICATE"
  | "UNMATCHED"
  | "CASE_REJECTED";

// Records one provider observation exactly once and applies it only when it
// matches the intent and the case's current attempt. Everything else is kept
// for review without moving balances.
export async function recordObservation(
  provider: FundedPaymentProvider,
  source: "WEBHOOK" | "SUBMIT" | "LOOKUP",
  providerEventId: string,
  observation: PaymentObservation,
): Promise<RecordedDisposition> {
  try {
    return await withRetry(() =>
      prisma.$transaction(async (transaction) => {
        const intent = await transaction.fundedPaymentIntent.findUnique({
          where: { id: observation.intentId },
        });
        const event = {
          providerEventId,
          source,
          status: observation.status,
          payload: observation,
        };
        if (!intent || intent.provider !== provider.name) {
          await writeEvent(transaction, provider, {
            ...event,
            intent: null,
            disposition: "UNMATCHED",
            detail: "No payment intent from this provider has that ID.",
          });
          return "UNMATCHED" as const;
        }
        const match = matchPaymentObservation(
          {
            ...intent,
            operation: paymentOperationSchema.parse(intent.operation),
            status: intentStatusSchema.parse(intent.status),
          },
          observation,
        );
        let disposition: RecordedDisposition = match.disposition;
        let nextStatus = match.nextStatus;
        let reviewReason = match.reviewReason;
        if (match.outcome) {
          try {
            await applyCaseCommand(transaction, intent.shop, intent.caseId, null, {
              id: derivedId("funded-outcome", intent.id, match.outcome),
              action: caseActionFor(
                paymentOperationSchema.parse(intent.operation),
                match.outcome,
              ),
              payment: bindingFor(intent),
            });
          } catch (error) {
            if (!(error instanceof SandboxError)) throw error;
            disposition = "CASE_REJECTED";
            nextStatus = "REVIEW";
            reviewReason = `The sample did not accept this outcome: ${error.message}`;
          }
        }
        if (
          nextStatus !== intent.status ||
          match.providerReference !== intent.providerReference ||
          reviewReason
        ) {
          const resolved = nextStatus === "SUCCEEDED" || nextStatus === "FAILED";
          await updateIntent(transaction, intent, {
            status: nextStatus,
            providerReference: match.providerReference,
            ...(reviewReason ? { reviewReason } : {}),
            ...(resolved || nextStatus === "REVIEW"
              ? { resolvedAt: new Date(), leaseUntil: null }
              : {}),
          });
        }
        await writeEvent(transaction, provider, {
          ...event,
          intent,
          disposition,
          detail: reviewReason,
        });
        return disposition;
      }),
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      (await prisma.fundedPaymentEvent.findUnique({
        where: {
          provider_providerEventId: { provider: provider.name, providerEventId },
        },
      }))
    )
      return "DUPLICATE";
    throw error;
  }
}

// Marks an in-flight submission as unknown and mirrors it on the case, unless
// another observation already resolved the intent.
async function markUnknown(
  provider: FundedPaymentProvider,
  intentId: string,
  from: "SUBMITTING",
  reason: string,
  providerEventId: string,
  nextCheckAt: (intent: Intent) => Date,
) {
  await withRetry(() =>
    prisma.$transaction(async (transaction) => {
      const intent = await transaction.fundedPaymentIntent.findUniqueOrThrow({
        where: { id: intentId },
      });
      if (intent.status !== from) return;
      await updateIntent(transaction, intent, {
        status: "UNKNOWN",
        lastError: reason,
        leaseUntil: null,
        nextCheckAt: nextCheckAt(intent),
      });
      const row = await transaction.fundedReturnSandbox.findUnique({
        where: { shop_id: { shop: intent.shop, id: intent.caseId } },
      });
      const state = row && sandboxStateSchema.parse(row.snapshot);
      const operation = intent.operation === "PAYOUT" ? "payout" : "collection";
      if (
        state &&
        sandboxOperationReference(state, operation) === intent.id &&
        state[operation] === "PENDING"
      )
        await applyCaseCommand(transaction, intent.shop, intent.caseId, null, {
          id: derivedId("funded-unknown", intent.id),
          action: caseActionFor(
            paymentOperationSchema.parse(intent.operation),
            "UNKNOWN",
          ),
          payment: bindingFor(intent),
        });
      await writeEvent(transaction, provider, {
        providerEventId,
        source: providerEventId.startsWith("lease:") ? "LOOKUP" : "SUBMIT",
        intent,
        status: "UNKNOWN",
        disposition: "RECORDED",
        detail: reason,
        payload: { intentId: intent.id, reason },
      });
    }),
  );
}

async function submitClaimed(
  provider: FundedPaymentProvider,
  intent: Intent,
  now: Date,
) {
  const eventId = `submit:${intent.id}:${intent.submissions}`;
  let result: SubmitResult;
  try {
    result = await provider.submit(instructionFor(intent));
  } catch {
    result = { kind: "UNKNOWN", reason: "Provider request failed." };
  }
  if (result.kind === "ACCEPTED")
    return recordObservation(provider, "SUBMIT", eventId, result.observation);
  if (result.kind === "UNKNOWN")
    return markUnknown(
      provider,
      intent.id,
      "SUBMITTING",
      result.reason,
      eventId,
      (current) =>
        new Date(now.getTime() + checkDelayMs(current.submissions)),
    );
  // Confirmed that no payment exists, so this attempt failed definitively.
  return withRetry(() =>
    prisma.$transaction(async (transaction) => {
      const current = await transaction.fundedPaymentIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      if (current.status !== "SUBMITTING") return;
      await updateIntent(transaction, current, {
        status: "FAILED",
        lastError: result.reason,
        leaseUntil: null,
        resolvedAt: new Date(),
      });
      await applyCaseCommand(transaction, current.shop, current.caseId, null, {
        id: derivedId("funded-outcome", current.id, "FAILED"),
        action: caseActionFor(
          paymentOperationSchema.parse(current.operation),
          "FAILED",
        ),
        payment: bindingFor(current),
      });
      await writeEvent(transaction, provider, {
        providerEventId: eventId,
        source: "SUBMIT",
        intent: current,
        status: "FAILED",
        disposition: "APPLIED",
        detail: result.reason,
        payload: { intentId: current.id, rejected: result.reason },
      });
    }),
  );
}

// Claims an intent for one submission. The lease makes concurrent dispatchers
// and reconcilers submit at most once per claim.
async function claim(
  intent: Intent,
  from: "QUEUED" | "UNKNOWN",
  now: Date,
) {
  const claimed = await prisma.fundedPaymentIntent.updateMany({
    where: { id: intent.id, status: from, version: intent.version },
    data: {
      version: { increment: 1 },
      status: "SUBMITTING",
      submissions: { increment: 1 },
      leaseUntil: new Date(now.getTime() + SUBMISSION_LEASE_MS),
    },
  });
  if (claimed.count !== 1) return null;
  return prisma.fundedPaymentIntent.findUniqueOrThrow({
    where: { id: intent.id },
  });
}

export async function dispatchPaymentIntents(
  provider: FundedPaymentProvider,
  { shop, now = new Date(), limit = 20 }: { shop?: string; now?: Date; limit?: number } = {},
) {
  requireFundedSandbox();
  const queued = await prisma.fundedPaymentIntent.findMany({
    where: { status: "QUEUED", provider: provider.name, ...(shop ? { shop } : {}) },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let submitted = 0;
  for (const intent of queued) {
    const claimed = await claim(intent, "QUEUED", now);
    if (!claimed) continue;
    submitted++;
    await submitClaimed(provider, claimed, now);
  }
  return { submitted };
}

// Resolves pending and unknown payments by asking the provider. It never
// creates a new attempt: a resubmission reuses the intent's idempotency key and
// only happens when the provider confirms it has no record of that key.
export async function reconcilePaymentIntents(
  provider: FundedPaymentProvider,
  {
    shop,
    now = new Date(),
    limit = 20,
    ignoreSchedule = false,
  }: {
    shop?: string;
    now?: Date;
    limit?: number;
    // Sandbox "check now": skips lookup backoff. Never shortens leases.
    ignoreSchedule?: boolean;
  } = {},
) {
  requireFundedSandbox();
  const scope = { provider: provider.name, ...(shop ? { shop } : {}) };
  const summary = { recovered: 0, checked: 0, resubmitted: 0, review: 0 };

  // A process that died mid-submit leaves SUBMITTING behind an expired lease.
  const abandoned = await prisma.fundedPaymentIntent.findMany({
    where: { ...scope, status: "SUBMITTING", leaseUntil: { lt: now } },
    take: limit,
  });
  for (const intent of abandoned) {
    await markUnknown(
      provider,
      intent.id,
      "SUBMITTING",
      "Submission lease expired before an outcome was recorded.",
      `lease:${intent.id}:${intent.submissions}`,
      () => now, // Look it up in this same pass.
    );
    summary.recovered++;
  }

  const due = await prisma.fundedPaymentIntent.findMany({
    where: {
      ...scope,
      status: { in: ["PENDING", "UNKNOWN"] },
      ...(ignoreSchedule ? {} : { nextCheckAt: { lte: now } }),
    },
    orderBy: { nextCheckAt: "asc" },
    take: limit,
  });
  for (const candidate of due) {
    const checked = await prisma.fundedPaymentIntent.updateMany({
      where: { id: candidate.id, version: candidate.version },
      data: {
        version: { increment: 1 },
        lookups: { increment: 1 },
        nextCheckAt: new Date(
          now.getTime() + checkDelayMs(candidate.lookups + 1),
        ),
      },
    });
    if (checked.count !== 1) continue;
    const intent = await prisma.fundedPaymentIntent.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    summary.checked++;
    const eventId = `lookup:${intent.id}:${intent.lookups}`;
    let lookup;
    try {
      lookup = await provider.lookup(intent.id);
    } catch {
      lookup = { kind: "UNKNOWN" as const, reason: "Provider lookup failed." };
    }
    if (lookup.kind === "FOUND") {
      const disposition = await recordObservation(
        provider,
        "LOOKUP",
        eventId,
        lookup.observation,
      );
      if (heldDispositions.has(disposition)) summary.review++;
      continue;
    }
    if (lookup.kind === "UNKNOWN") {
      await prisma.fundedPaymentIntent.updateMany({
        where: { id: intent.id, version: intent.version },
        data: { lastError: lookup.reason, version: { increment: 1 } },
      });
      continue;
    }
    // NOT_FOUND. Safe to resubmit only an unacknowledged submission, with the
    // same idempotency key, and only a bounded number of times.
    if (
      intent.status === "UNKNOWN" &&
      intent.providerReference === null &&
      intent.submissions < MAX_SUBMISSIONS
    ) {
      const claimed = await claim(intent, "UNKNOWN", now);
      if (claimed) {
        summary.resubmitted++;
        await submitClaimed(provider, claimed, now);
      }
      continue;
    }
    await withRetry(() =>
      prisma.$transaction(async (transaction) => {
        const current = await transaction.fundedPaymentIntent.findUniqueOrThrow({
          where: { id: intent.id },
        });
        if (current.status !== intent.status) return;
        const reason =
          current.providerReference === null
            ? `Provider has no record after ${current.submissions} submissions.`
            : "Provider no longer reports a payment it accepted.";
        await updateIntent(transaction, current, {
          status: "REVIEW",
          reviewReason: reason,
          resolvedAt: new Date(),
        });
        await writeEvent(transaction, provider, {
          providerEventId: eventId,
          source: "LOOKUP",
          intent: current,
          status: "NOT_FOUND",
          disposition: "HELD_FOR_REVIEW",
          detail: reason,
          payload: { intentId: current.id, lookup: "NOT_FOUND" },
        });
      }),
    );
    summary.review++;
  }
  return summary;
}

export async function ingestProviderEvent(
  provider: FundedPaymentProvider,
  rawBody: string,
  headers: Headers,
  now = new Date(),
) {
  requireFundedSandbox();
  const event = provider.verifyEvent(rawBody, headers, now);
  return recordObservation(provider, "WEBHOOK", event.eventId, event.observation);
}

export async function listSandboxPayments(shop: string, caseIds: string[]) {
  requireFundedSandbox();
  const [intents, events] = await Promise.all([
    prisma.fundedPaymentIntent.findMany({
      where: { shop, caseId: { in: caseIds } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.fundedPaymentEvent.findMany({
      where: { shop },
      orderBy: { receivedAt: "asc" },
      take: 500,
    }),
  ]);
  return intents.map((intent) => ({
    id: intent.id,
    caseId: intent.caseId,
    operation: intent.operation,
    attempt: intent.attempt,
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    status: intent.status,
    providerReference: intent.providerReference,
    submissions: intent.submissions,
    lookups: intent.lookups,
    reviewReason: intent.reviewReason,
    lastError: intent.lastError,
    events: events
      .filter((event) => event.intentId === intent.id)
      .map((event) => ({
        id: event.providerEventId,
        source: event.source,
        status: event.status,
        disposition: event.disposition,
        detail: event.detail,
        receivedAt: event.receivedAt.toISOString(),
      })),
  }));
}
