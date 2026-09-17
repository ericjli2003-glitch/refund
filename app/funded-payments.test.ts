import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  matchPaymentObservation,
  type MatchableIntent,
  type PaymentObservation,
} from "./funded-payment-matching";
import {
  derivedId,
  parseProviderEventBody,
  ProviderEventRejected,
  signEventBody,
  verifyEventSignature,
} from "./services/funded-payment-provider.server";
import { fundedPaymentProvider } from "./services/funded-payment-intents.server";
import { action as providerWebhook } from "./routes/webhooks.funded-sandbox-provider";

function fixture(status: MatchableIntent["status"] = "PENDING") {
  const intent: MatchableIntent = {
    id: randomUUID(),
    operation: "PAYOUT",
    amountMinor: 5000,
    currency: "CAD",
    status,
    providerReference: status === "SUBMITTING" ? null : "sbx_1",
  };
  const observation: PaymentObservation = {
    intentId: intent.id,
    providerReference: "sbx_1",
    operation: "PAYOUT",
    status: "SUCCEEDED",
    amountMinor: 5000,
    currency: "CAD",
  };
  return { intent, observation };
}

test("funded payments: a first matching terminal result applies once", () => {
  for (const status of ["SUBMITTING", "PENDING", "UNKNOWN"] as const) {
    const { intent, observation } = fixture(status);
    const match = matchPaymentObservation(intent, observation);
    assert.equal(match.disposition, "APPLIED");
    assert.equal(match.outcome, "SUCCEEDED");
    assert.equal(match.providerReference, "sbx_1");
    const failed = matchPaymentObservation(intent, {
      ...observation,
      status: "FAILED",
    });
    assert.equal(failed.outcome, "FAILED");
  }
  const { intent, observation } = fixture("SUCCEEDED");
  for (const status of ["SUCCEEDED", "PENDING"] as const) {
    const repeat = matchPaymentObservation(intent, { ...observation, status });
    assert.equal(repeat.disposition, "ALREADY_APPLIED");
    assert.equal(repeat.outcome, null);
  }
});

test("funded payments: pending is recorded without moving the case", () => {
  const { intent, observation } = fixture("UNKNOWN");
  const match = matchPaymentObservation(intent, {
    ...observation,
    status: "PENDING",
  });
  assert.equal(match.disposition, "RECORDED");
  assert.equal(match.nextStatus, "PENDING");
  assert.equal(match.outcome, null);
});

test("funded payments: any mismatched field holds the payment for review", () => {
  const { intent, observation } = fixture();
  for (const change of [
    { intentId: randomUUID() },
    { operation: "COLLECTION" as const },
    { amountMinor: 4999 },
    { currency: "USD" as const },
    { providerReference: "sbx_other" },
  ]) {
    const match = matchPaymentObservation(intent, { ...observation, ...change });
    assert.equal(match.disposition, "MISMATCH");
    assert.equal(match.nextStatus, "REVIEW");
    assert.equal(match.outcome, null);
  }
});

test("funded payments: contradictions, reversals and unsent intents never apply", () => {
  const cases: Array<[MatchableIntent["status"], PaymentObservation["status"], string]> = [
    ["SUCCEEDED", "FAILED", "CONTRADICTION"],
    ["FAILED", "SUCCEEDED", "CONTRADICTION"],
    ["SUCCEEDED", "REVERSED", "REVERSAL"],
    ["PENDING", "REVERSED", "CONTRADICTION"],
    ["QUEUED", "SUCCEEDED", "CONTRADICTION"],
    ["REVIEW", "SUCCEEDED", "HELD_FOR_REVIEW"],
  ];
  for (const [status, observed, disposition] of cases) {
    const { intent, observation } = fixture(status);
    const match = matchPaymentObservation(intent, {
      ...observation,
      status: observed,
    });
    assert.equal(match.disposition, disposition, `${status} + ${observed}`);
    assert.equal(match.nextStatus, "REVIEW");
    assert.equal(match.outcome, null);
  }
});

test("funded payments: event signatures cover exact bytes and expire", () => {
  const secret = "a".repeat(64);
  const body = JSON.stringify({ id: "evt_1", data: fixture().observation });
  const now = new Date("2026-09-17T12:00:00Z");
  const header = signEventBody(secret, body, now);
  verifyEventSignature(secret, body, header, now);
  verifyEventSignature(secret, body, header, new Date(now.getTime() + 299_000));
  const rejects = (fn: () => void) =>
    assert.throws(fn, (error) => error instanceof ProviderEventRejected);
  rejects(() => verifyEventSignature(secret, `${body} `, header, now));
  rejects(() => verifyEventSignature("b".repeat(64), body, header, now));
  rejects(() => verifyEventSignature(secret, body, null, now));
  rejects(() => verifyEventSignature(secret, body, "t=1,v1=zz", now));
  rejects(() =>
    verifyEventSignature(secret, body, header, new Date(now.getTime() + 301_000)),
  );
  assert.equal(parseProviderEventBody(body).eventId, "evt_1");
  rejects(() => parseProviderEventBody("{"));
  rejects(() => parseProviderEventBody(JSON.stringify({ id: "evt_1" })));
  rejects(() =>
    parseProviderEventBody(
      JSON.stringify({
        id: "evt_1",
        data: { ...fixture().observation, amountMinor: 1.5 },
      }),
    ),
  );
});

test("funded payments: derived IDs are stable UUIDs that separate their parts", () => {
  const id = derivedId("funded-outcome", "intent", "SUCCEEDED");
  assert.equal(id, derivedId("funded-outcome", "intent", "SUCCEEDED"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, derivedId("funded-outcome", "intent", "FAILED"));
  assert.notEqual(derivedId("ab", "c"), derivedId("a", "bc"));
});

test("funded payments: provider and callback route fail closed outside the sandbox", async () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.GOOPER_FUNDED_RETURNS_SANDBOX = "1";
    assert.throws(
      () => fundedPaymentProvider(),
      (error) => error instanceof Response && error.status === 404,
    );
    const request = new Request("http://localhost/webhooks/funded-sandbox-provider", {
      method: "POST",
      body: "{}",
    });
    await assert.rejects(
      Promise.resolve().then(() =>
        providerWebhook({ request, params: {}, context: {} } as never),
      ),
      (error) => error instanceof Response && error.status === 404,
    );
    process.env.NODE_ENV = "test";
    const provider = fundedPaymentProvider();
    assert.equal(provider.environment, "SANDBOX");
    assert.equal(provider.idempotentSubmit, true);
    const unsigned = await providerWebhook({
      request: new Request("http://localhost/webhooks/funded-sandbox-provider", {
        method: "POST",
        body: JSON.stringify({ id: "evt_1", data: fixture().observation }),
      }),
      params: {},
      context: {},
    } as never);
    assert.equal(unsigned.status, 400);
  } finally {
    process.env = saved;
  }
});
