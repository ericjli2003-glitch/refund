import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  applySandboxCommand,
  createSandboxState,
  parseSandboxMoney,
  sandboxActionOperation,
  sandboxBalances,
  sandboxNextPayment,
  sandboxOperationReference,
  sandboxStateSchema,
  type SandboxAction,
  type SandboxState,
} from "./funded-return-sandbox";
import { fundedSandboxEnabled } from "./services/funded-return-sandbox.server";

function step(
  state: SandboxState,
  action: SandboxAction,
  acceptedMinor?: number,
) {
  return applySandboxCommand(state, {
    id: randomUUID(),
    action,
    ...(acceptedMinor === undefined ? {} : { acceptedMinor }),
    ...bind(state, action),
  });
}
// The binding a correctly matched provider outcome or new request would carry.
function bind(state: SandboxState, action: SandboxAction) {
  const operation = sandboxActionOperation(action);
  if (!operation) return {};
  const next = sandboxNextPayment(state, operation);
  if (action.startsWith("REQUEST_"))
    return { payment: { ...next, intentId: randomUUID() } };
  return {
    payment: {
      ...next,
      attempt: Math.max(1, next.attempt - 1),
      intentId: sandboxOperationReference(state, operation) ?? randomUUID(),
    },
  };
}
function paid() {
  let state = createSandboxState(randomUUID(), "CAD");
  for (const action of [
    "APPROVE_RISK",
    "REQUEST_PAYOUT",
    "PAYOUT_SUCCEEDED",
  ] as const)
    state = step(state, action);
  return state;
}

test("funded sandbox: payout first, explicit receipt and approval, repayment last", () => {
  let state = paid();
  assert.deepEqual(sandboxBalances(state), {
    GOOPER_CASH: -5000,
    FUNDED_EXPOSURE: 5000,
    MERCHANT_RECEIVABLE: 0,
  });
  assert.equal(state.collection, "NOT_DUE");
  state = step(state, "RECEIVE_ITEM");
  assert.equal(state.collection, "NOT_DUE", "Delivery never creates debt");
  state = step(state, "INSPECT_ITEM", 5000);
  assert.deepEqual(sandboxBalances(state), {
    GOOPER_CASH: -5000,
    FUNDED_EXPOSURE: 0,
    MERCHANT_RECEIVABLE: 5000,
  });
  state = step(state, "REQUEST_COLLECTION");
  assert.equal(
    sandboxBalances(state).MERCHANT_RECEIVABLE,
    5000,
    "Sending a request is not settlement",
  );
  state = step(state, "COLLECTION_SUCCEEDED");
  assert.deepEqual(sandboxBalances(state), {
    GOOPER_CASH: 0,
    FUNDED_EXPOSURE: 0,
    MERCHANT_RECEIVABLE: 0,
  });
  assert.equal(state.collection, "SETTLED");
  for (const event of state.events)
    assert.equal(
      event.postings.reduce((sum, posting) => sum + posting.deltaMinor, 0),
      0,
    );
});

test("funded sandbox: blocks premature funding, inspection and collection", () => {
  const initial = createSandboxState(randomUUID(), "USD");
  for (const action of [
    "REQUEST_PAYOUT",
    "PAYOUT_SUCCEEDED",
    "RECEIVE_ITEM",
    "REQUEST_COLLECTION",
    "COLLECTION_SUCCEEDED",
  ] as const) {
    assert.throws(() => step(initial, action));
  }
  assert.throws(() => step(paid(), "INSPECT_ITEM", 5000));
  assert.throws(() => step(step(paid(), "RECEIVE_ITEM"), "REQUEST_COLLECTION"));
});

test("funded sandbox: timeout keeps payout reference and blocks a new payment", () => {
  let state = step(
    step(createSandboxState(randomUUID(), "USD"), "APPROVE_RISK"),
    "REQUEST_PAYOUT",
  );
  const reference = sandboxOperationReference(state, "payout");
  state = step(state, "PAYOUT_UNKNOWN");
  assert.throws(() => step(state, "REQUEST_PAYOUT"));
  assert.throws(() => step(state, "RECEIVE_ITEM"));
  assert.equal(sandboxBalances(state).GOOPER_CASH, 0);
  assert.equal(sandboxOperationReference(state, "payout"), reference);
  state = step(state, "PAYOUT_SUCCEEDED");
  assert.equal(state.payoutAttempt, 1);
  assert.throws(() => step(state, "REQUEST_PAYOUT"));
  assert.throws(
    () => step(state, "PAYOUT_FAILED"),
    "A delayed failure must not overwrite confirmed success",
  );
});

test("funded sandbox: only confirmed failures permit a new attempt", () => {
  let state = step(
    step(createSandboxState(randomUUID(), "CAD"), "APPROVE_RISK"),
    "REQUEST_PAYOUT",
  );
  const first = sandboxOperationReference(state, "payout");
  state = step(state, "PAYOUT_FAILED");
  assert.equal(sandboxBalances(state).FUNDED_EXPOSURE, 0);
  state = step(state, "REQUEST_PAYOUT");
  assert.equal(state.payoutAttempt, 2);
  assert.notEqual(sandboxOperationReference(state, "payout"), first);
});

test("funded sandbox: partial approval collects only accepted principal", () => {
  let state = step(step(paid(), "RECEIVE_ITEM"), "INSPECT_ITEM", 2500);
  assert.equal(state.returnStatus, "PARTIALLY_APPROVED");
  state = step(step(state, "REQUEST_COLLECTION"), "COLLECTION_SUCCEEDED");
  assert.deepEqual(sandboxBalances(state), {
    GOOPER_CASH: -2500,
    FUNDED_EXPOSURE: 2500,
    MERCHANT_RECEIVABLE: 0,
  });
  assert.throws(() => step(state, "INSPECT_ITEM", 5000));
});

test("funded sandbox: rejection keeps exposure, without inventing customer recovery", () => {
  const state = step(step(paid(), "RECEIVE_ITEM"), "INSPECT_ITEM", 0);
  assert.equal(state.returnStatus, "REJECTED");
  assert.equal(state.collection, "NOT_DUE");
  assert.equal(sandboxBalances(state).FUNDED_EXPOSURE, 5000);
  assert.throws(() => step(state, "REQUEST_COLLECTION"));
});

test("funded sandbox: unknown collection blocks duplicate debit and resolves once", () => {
  let state = step(
    step(step(paid(), "RECEIVE_ITEM"), "INSPECT_ITEM", 5000),
    "REQUEST_COLLECTION",
  );
  const reference = sandboxOperationReference(state, "collection");
  state = step(state, "COLLECTION_UNKNOWN");
  assert.throws(() => step(state, "REQUEST_COLLECTION"));
  assert.equal(sandboxOperationReference(state, "collection"), reference);
  state = step(state, "COLLECTION_FAILED");
  assert.equal(sandboxBalances(state).MERCHANT_RECEIVABLE, 5000);
  state = step(state, "REQUEST_COLLECTION");
  assert.notEqual(sandboxOperationReference(state, "collection"), reference);
  state = step(state, "COLLECTION_SUCCEEDED");
  assert.throws(() => step(state, "COLLECTION_SUCCEEDED"));
  assert.throws(() => step(state, "REQUEST_COLLECTION"));
});

test("funded sandbox: idempotent replay leaves journal and balances unchanged", () => {
  const state = step(
    step(createSandboxState(randomUUID(), "CAD"), "APPROVE_RISK"),
    "REQUEST_PAYOUT",
  );
  const command = {
    id: randomUUID(),
    action: "PAYOUT_SUCCEEDED" as const,
    ...bind(state, "PAYOUT_SUCCEEDED"),
  };
  const next = applySandboxCommand(state, command);
  assert.equal(applySandboxCommand(next, command), next);
  assert.throws(() =>
    applySandboxCommand(next, { ...command, action: "PAYOUT_FAILED" }),
  );
  assert.equal(
    state.payout,
    "PENDING",
    "Transitions do not mutate earlier snapshots",
  );
});

test("funded sandbox: integer money, valid currency and no over-approval", () => {
  assert.equal(parseSandboxMoney("12.34"), 1234);
  assert.equal(parseSandboxMoney("0.1"), 10);
  for (const value of [
    "-1",
    "NaN",
    "Infinity",
    "1e2",
    "1.001",
    "",
    "1,000",
    "1001",
  ])
    assert.throws(() => parseSandboxMoney(value));
  const state = step(paid(), "RECEIVE_ITEM");
  for (const value of [-1, 1.5, 5001, NaN, Infinity])
    assert.throws(() => step(state, "INSPECT_ITEM", value));
  assert.throws(() => step(state, "INSPECT_ITEM"));
  assert.throws(() => step(state, "REQUEST_COLLECTION", 50));
  assert.throws(() => sandboxStateSchema.parse({ ...state, mode: "LIVE" }));
});

test("funded sandbox: production and unspecified environments fail closed", () => {
  assert.equal(
    fundedSandboxEnabled({
      NODE_ENV: "production",
      GOOPER_FUNDED_RETURNS_SANDBOX: "1",
    }),
    false,
  );
  assert.equal(
    fundedSandboxEnabled({ GOOPER_FUNDED_RETURNS_SANDBOX: "1" }),
    false,
  );
  assert.equal(fundedSandboxEnabled({ NODE_ENV: "development" }), false);
  assert.equal(
    fundedSandboxEnabled({
      NODE_ENV: "development",
      GOOPER_FUNDED_RETURNS_SANDBOX: "0",
    }),
    false,
  );
  assert.equal(
    fundedSandboxEnabled({
      NODE_ENV: "development",
      GOOPER_FUNDED_RETURNS_SANDBOX: "1",
    }),
    true,
  );
  assert.equal(
    fundedSandboxEnabled({
      NODE_ENV: "test",
      GOOPER_FUNDED_RETURNS_SANDBOX: "1",
    }),
    true,
  );
});

test("funded sandbox: outcomes must match the current intent, attempt, amount and currency", () => {
  let state = step(
    step(createSandboxState(randomUUID(), "CAD"), "APPROVE_RISK"),
    "REQUEST_PAYOUT",
  );
  const firstIntent = state.payoutIntentId!;
  const valid = bind(state, "PAYOUT_SUCCEEDED").payment!;
  const outcome = (payment: typeof valid) =>
    applySandboxCommand(state, {
      id: randomUUID(),
      action: "PAYOUT_SUCCEEDED",
      payment,
    });
  assert.throws(() => outcome({ ...valid, intentId: randomUUID() }));
  assert.throws(() => outcome({ ...valid, attempt: 2 }));
  assert.throws(() => outcome({ ...valid, amountMinor: 4999 }));
  assert.throws(() => outcome({ ...valid, currency: "USD" }));
  assert.throws(() =>
    applySandboxCommand(state, { id: randomUUID(), action: "PAYOUT_FAILED" }),
  );
  state = step(step(state, "PAYOUT_FAILED"), "REQUEST_PAYOUT");
  assert.equal(state.payoutAttempt, 2);
  assert.throws(
    () =>
      applySandboxCommand(state, {
        id: randomUUID(),
        action: "PAYOUT_SUCCEEDED",
        payment: { ...valid, intentId: firstIntent },
      }),
    "A delayed success for the failed first attempt must not settle attempt two",
  );
  assert.throws(() =>
    applySandboxCommand(state, {
      id: randomUUID(),
      action: "REQUEST_PAYOUT",
      payment: { ...valid, attempt: 3, intentId: randomUUID() },
    }),
  );
});

test("funded sandbox: collection request is bound to approved principal only", () => {
  const state = step(step(paid(), "RECEIVE_ITEM"), "INSPECT_ITEM", 2500);
  const request = bind(state, "REQUEST_COLLECTION").payment!;
  assert.equal(request.amountMinor, 2500);
  assert.throws(() =>
    applySandboxCommand(state, {
      id: randomUUID(),
      action: "REQUEST_COLLECTION",
      payment: { ...request, amountMinor: 5000 },
    }),
  );
});

test("funded sandbox: snapshots saved before intents still parse", () => {
  const legacy: Record<string, unknown> = {
    ...createSandboxState(randomUUID(), "USD"),
  };
  delete legacy.payoutIntentId;
  delete legacy.collectionIntentId;
  const parsed = sandboxStateSchema.parse(legacy);
  assert.equal(parsed.payoutIntentId, null);
  assert.equal(parsed.collectionIntentId, null);
});
