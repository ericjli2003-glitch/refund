import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import prisma from "../db.server";
import type {
  PaymentObservation,
  PaymentOperation,
} from "../funded-payment-matching";
import {
  parseProviderEventBody,
  signEventBody,
  verifyEventSignature,
  type FundedPaymentProvider,
  type LookupResult,
  type PaymentInstruction,
  type SubmitResult,
} from "./funded-payment-provider.server";

// A fake payment provider for the development sandbox. It moves no money and
// has no credentials. Its records stand in for the provider's side of the wire:
// Gooper workflow code must reach them only through FundedPaymentProvider.

export const sandboxScenarioSchema = z.enum([
  "SUCCEED",
  "FAIL",
  "TIMEOUT_AFTER_ACCEPT",
  "LOST_BEFORE_ACCEPT",
  "SUCCEED_THEN_REVERSE",
  "FAIL_THEN_LATE_SUCCESS",
  "WRONG_AMOUNT_EVENT",
]);
export type SandboxScenario = z.infer<typeof sandboxScenarioSchema>;

export const SANDBOX_PROVIDER_NAME = "gooper-sandbox";
export const SANDBOX_SIGNATURE_HEADER = "gooper-sandbox-signature";

const storedEventSchema = z.object({
  id: z.string(),
  status: z.enum(["SUCCEEDED", "FAILED", "REVERSED"]),
  amountMinor: z.number().int().positive(),
  delivered: z.boolean(),
});
type StoredEvent = z.infer<typeof storedEventSchema>;

declare global {
  // eslint-disable-next-line no-var
  var fundedSandboxProviderSecret: string | undefined;
}

// Sandbox-only signing secret. Deliveries are signed at send time, so a
// per-process fallback remains valid across restarts of queued events.
function signingSecret() {
  const configured = process.env.GOOPER_FUNDED_SANDBOX_PROVIDER_SECRET;
  if (configured && configured.length >= 32) return configured;
  global.fundedSandboxProviderSecret ??= randomBytes(32).toString("hex");
  return global.fundedSandboxProviderSecret;
}

function finalEvents(
  scenario: SandboxScenario,
  amountMinor: number,
): StoredEvent[] {
  const event = (
    status: StoredEvent["status"],
    amount = amountMinor,
  ): StoredEvent => ({
    id: `evt_${randomUUID()}`,
    status,
    amountMinor: amount,
    delivered: false,
  });
  switch (scenario) {
    case "FAIL":
      return [event("FAILED")];
    case "SUCCEED_THEN_REVERSE":
      return [event("SUCCEEDED"), event("REVERSED")];
    case "FAIL_THEN_LATE_SUCCESS":
      return [event("FAILED"), event("SUCCEEDED")];
    case "WRONG_AMOUNT_EVENT":
      return [event("SUCCEEDED", Math.max(1, amountMinor - 1))];
    default:
      return [event("SUCCEEDED")];
  }
}

type ProviderRow = Awaited<
  ReturnType<typeof prisma.fundedSandboxProviderPayment.findUnique>
> & {};

function observe(
  row: ProviderRow,
  status: PaymentObservation["status"],
  amountMinor = row.amountMinor,
): PaymentObservation {
  return {
    intentId: row.idempotencyKey,
    providerReference: row.reference!,
    operation: row.operation as PaymentOperation,
    status,
    amountMinor,
    currency: row.currency as "CAD" | "USD",
  };
}

// The provider's current truth: the latest settled status, else pending.
function currentStatus(row: ProviderRow): PaymentObservation["status"] {
  if (row.status === "PENDING") return "PENDING";
  return row.status as PaymentObservation["status"];
}

export async function planSandboxScenario(
  shop: string,
  instruction: Pick<
    PaymentInstruction,
    "idempotencyKey" | "operation" | "amountMinor" | "currency"
  >,
  scenario: SandboxScenario,
) {
  await prisma.fundedSandboxProviderPayment.upsert({
    where: { idempotencyKey: instruction.idempotencyKey },
    create: {
      idempotencyKey: instruction.idempotencyKey,
      shop,
      operation: instruction.operation,
      amountMinor: instruction.amountMinor,
      currency: instruction.currency,
      scenario: sandboxScenarioSchema.parse(scenario),
    },
    update: {},
  });
}

export const sandboxPaymentProvider: FundedPaymentProvider = {
  name: SANDBOX_PROVIDER_NAME,
  environment: "SANDBOX",
  idempotentSubmit: true,

  async submit(instruction): Promise<SubmitResult> {
    await prisma.fundedSandboxProviderPayment.upsert({
      where: { idempotencyKey: instruction.idempotencyKey },
      create: {
        idempotencyKey: instruction.idempotencyKey,
        shop: instruction.shop,
        operation: instruction.operation,
        amountMinor: instruction.amountMinor,
        currency: instruction.currency,
        scenario: "SUCCEED",
      },
      update: {},
    });
    let row = await prisma.fundedSandboxProviderPayment.findUniqueOrThrow({
      where: { idempotencyKey: instruction.idempotencyKey },
    });
    if (
      row.amountMinor !== instruction.amountMinor ||
      row.currency !== instruction.currency ||
      row.operation !== instruction.operation
    )
      return {
        kind: "REJECTED",
        reason: "Idempotency key reused with different payment details.",
      };
    const scenario = sandboxScenarioSchema.parse(row.scenario);

    if (row.status === "PLANNED" && scenario === "LOST_BEFORE_ACCEPT") {
      const lost = await prisma.fundedSandboxProviderPayment.updateMany({
        where: { idempotencyKey: row.idempotencyKey, status: "PLANNED" },
        data: { status: "LOST" },
      });
      if (lost.count === 1)
        return { kind: "UNKNOWN", reason: "Sandbox request timed out." };
    }
    // Accept at most once per idempotency key, whatever the concurrency.
    const accepted = await prisma.fundedSandboxProviderPayment.updateMany({
      where: {
        idempotencyKey: row.idempotencyKey,
        status: { in: ["PLANNED", "LOST"] },
      },
      data: {
        status: "PENDING",
        reference: `sbx_${randomUUID()}`,
        events: finalEvents(scenario, row.amountMinor),
      },
    });
    row = await prisma.fundedSandboxProviderPayment.findUniqueOrThrow({
      where: { idempotencyKey: row.idempotencyKey },
    });
    if (accepted.count === 1 && scenario === "TIMEOUT_AFTER_ACCEPT")
      return {
        kind: "UNKNOWN",
        reason: "Sandbox provider accepted but the response timed out.",
      };
    return { kind: "ACCEPTED", observation: observe(row, currentStatus(row)) };
  },

  async lookup(idempotencyKey): Promise<LookupResult> {
    const row = await prisma.fundedSandboxProviderPayment.findUnique({
      where: { idempotencyKey },
    });
    if (!row || !row.reference) return { kind: "NOT_FOUND" };
    return { kind: "FOUND", observation: observe(row, currentStatus(row)) };
  },

  verifyEvent(rawBody, headers, now) {
    verifyEventSignature(
      signingSecret(),
      rawBody,
      headers.get(SANDBOX_SIGNATURE_HEADER),
      now,
    );
    return parseProviderEventBody(rawBody);
  },
};

export type SandboxDelivery = { rawBody: string; headers: Headers };

function deliveryFor(row: ProviderRow, event: StoredEvent, at: Date) {
  const rawBody = JSON.stringify({
    id: event.id,
    type: "payment.updated",
    data: observe(row, event.status, event.amountMinor),
  });
  return {
    rawBody,
    headers: new Headers({
      "content-type": "application/json",
      [SANDBOX_SIGNATURE_HEADER]: signEventBody(signingSecret(), rawBody, at),
    }),
  };
}

// Releases the next undelivered provider event for each payment in a shop.
// Settling the provider's status happens when its event is emitted, so
// lookups and webhooks tell the same story in the same order.
export async function releaseSandboxEvents(shop: string, at = new Date()) {
  const rows = await prisma.fundedSandboxProviderPayment.findMany({
    where: { shop, reference: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  const deliveries: SandboxDelivery[] = [];
  for (const row of rows) {
    const events = z.array(storedEventSchema).parse(row.events);
    const next = events.find((event) => !event.delivered);
    if (!next) continue;
    next.delivered = true;
    const claimed = await prisma.fundedSandboxProviderPayment.updateMany({
      where: { idempotencyKey: row.idempotencyKey, updatedAt: row.updatedAt },
      data: { events, status: next.status },
    });
    if (claimed.count === 1) deliveries.push(deliveryFor(row, next, at));
  }
  return deliveries;
}

// Re-sends every already delivered event for a shop, to exercise replay.
export async function replaySandboxEvents(shop: string, at = new Date()) {
  const rows = await prisma.fundedSandboxProviderPayment.findMany({
    where: { shop, reference: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  return rows.flatMap((row) =>
    z
      .array(storedEventSchema)
      .parse(row.events)
      .filter((event) => event.delivered)
      .map((event) => deliveryFor(row, event, at)),
  );
}
