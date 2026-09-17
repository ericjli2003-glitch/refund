import { z } from "zod";
import type { SandboxAction } from "./funded-return-sandbox";

// Provider-neutral payment outcome matching. No provider SDK, credentials or
// network access belongs here; adapters translate their data into observations.

export const paymentOperationSchema = z.enum(["PAYOUT", "COLLECTION"]);
export type PaymentOperation = z.infer<typeof paymentOperationSchema>;

export const intentStatusSchema = z.enum([
  "QUEUED",
  "SUBMITTING",
  "PENDING",
  "UNKNOWN",
  "SUCCEEDED",
  "FAILED",
  "REVIEW",
]);
export type IntentStatus = z.infer<typeof intentStatusSchema>;

// What a provider says about one payment, from a webhook, submit response or
// lookup. REVERSED means money that had succeeded later came back.
export const paymentObservationSchema = z
  .object({
    intentId: z.string().uuid(),
    providerReference: z.string().min(1).max(200),
    operation: paymentOperationSchema,
    status: z.enum(["PENDING", "SUCCEEDED", "FAILED", "REVERSED"]),
    amountMinor: z.number().int().positive().max(100_000),
    currency: z.enum(["CAD", "USD"]),
  })
  .strict();
export type PaymentObservation = z.infer<typeof paymentObservationSchema>;

export type MatchableIntent = {
  id: string;
  operation: PaymentOperation;
  amountMinor: number;
  currency: string;
  status: IntentStatus;
  providerReference: string | null;
};

export type ObservationDisposition =
  | "APPLIED"
  | "RECORDED"
  | "ALREADY_APPLIED"
  | "MISMATCH"
  | "CONTRADICTION"
  | "REVERSAL"
  | "HELD_FOR_REVIEW";

export type ObservationMatch = {
  disposition: ObservationDisposition;
  nextStatus: IntentStatus;
  providerReference: string | null;
  // The confirmed case outcome to apply, only for a first terminal result.
  outcome: "SUCCEEDED" | "FAILED" | null;
  reviewReason: string | null;
};

const terminal = new Set<IntentStatus>(["SUCCEEDED", "FAILED"]);

export function matchPaymentObservation(
  intent: MatchableIntent,
  observation: PaymentObservation,
): ObservationMatch {
  const hold = (
    disposition: ObservationDisposition,
    reviewReason: string,
  ): ObservationMatch => ({
    disposition,
    nextStatus: "REVIEW",
    providerReference: intent.providerReference,
    outcome: null,
    reviewReason,
  });

  if (intent.status === "REVIEW")
    return {
      disposition: "HELD_FOR_REVIEW",
      nextStatus: "REVIEW",
      providerReference: intent.providerReference,
      outcome: null,
      reviewReason: null,
    };
  const mismatches = [
    observation.intentId !== intent.id && "intent",
    observation.operation !== intent.operation && "operation",
    observation.amountMinor !== intent.amountMinor && "amount",
    observation.currency !== intent.currency && "currency",
    intent.providerReference !== null &&
      observation.providerReference !== intent.providerReference &&
      "provider reference",
  ].filter(Boolean);
  if (mismatches.length)
    return hold(
      "MISMATCH",
      `Provider reported a different ${mismatches.join(", ")} for this payment.`,
    );
  if (intent.status === "QUEUED")
    return hold(
      "CONTRADICTION",
      "Provider reported a payment that was never submitted.",
    );

  if (observation.status === "REVERSED")
    return intent.status === "SUCCEEDED"
      ? hold(
          "REVERSAL",
          "A confirmed payment was reversed. Balances were not changed automatically.",
        )
      : hold(
          "CONTRADICTION",
          "Provider reported a reversal for a payment that had not succeeded.",
        );

  if (terminal.has(intent.status)) {
    if (observation.status === intent.status || observation.status === "PENDING")
      return {
        disposition: "ALREADY_APPLIED",
        nextStatus: intent.status,
        providerReference: intent.providerReference,
        outcome: null,
        reviewReason: null,
      };
    return hold(
      "CONTRADICTION",
      `Provider reported ${observation.status} after ${intent.status} was confirmed.`,
    );
  }

  if (observation.status === "PENDING")
    return {
      disposition: "RECORDED",
      nextStatus: "PENDING",
      providerReference: observation.providerReference,
      outcome: null,
      reviewReason: null,
    };
  return {
    disposition: "APPLIED",
    nextStatus: observation.status,
    providerReference: observation.providerReference,
    outcome: observation.status,
    reviewReason: null,
  };
}

export function caseActionFor(
  operation: PaymentOperation,
  outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN",
): SandboxAction {
  return `${operation}_${outcome}` as SandboxAction;
}
