import { z } from "zod";

// A deliberately isolated simulation. No Shopify IDs, customer details, payment
// credentials, network calls or live-provider selector belong in this module.
const minorUnits = z.number().int().min(0).max(100_000);
export const sandboxActionSchema = z.enum([
  "APPROVE_RISK",
  "REQUEST_PAYOUT",
  "PAYOUT_SUCCEEDED",
  "PAYOUT_FAILED",
  "PAYOUT_UNKNOWN",
  "RECEIVE_ITEM",
  "INSPECT_ITEM",
  "REQUEST_COLLECTION",
  "COLLECTION_SUCCEEDED",
  "COLLECTION_FAILED",
  "COLLECTION_UNKNOWN",
]);
export type SandboxAction = z.infer<typeof sandboxActionSchema>;
export type SandboxOperation = "payout" | "collection";

// Requests and outcomes are bound to one durable payment intent. An outcome
// only applies when intent, attempt, amount and currency all match the case.
export const sandboxPaymentBindingSchema = z
  .object({
    intentId: z.string().uuid(),
    attempt: z.number().int().min(1).max(20),
    amountMinor: minorUnits.refine((amount) => amount > 0),
    currency: z.enum(["CAD", "USD"]),
  })
  .strict();
export type SandboxPaymentBinding = z.infer<
  typeof sandboxPaymentBindingSchema
>;

export function sandboxActionOperation(
  action: SandboxAction,
): SandboxOperation | null {
  if (action.startsWith("PAYOUT_") || action === "REQUEST_PAYOUT")
    return "payout";
  if (action.startsWith("COLLECTION_") || action === "REQUEST_COLLECTION")
    return "collection";
  return null;
}

export const sandboxCommandSchema = z
  .object({
    id: z.string().uuid(),
    action: sandboxActionSchema,
    acceptedMinor: minorUnits.optional(),
    payment: sandboxPaymentBindingSchema.optional(),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      (command.action === "INSPECT_ITEM") !==
      (command.acceptedMinor !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only an inspection requires an accepted amount.",
      });
    }
    if (
      (sandboxActionOperation(command.action) !== null) !==
      (command.payment !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Payment requests and outcomes require a payment intent.",
      });
    }
  });
export type SandboxCommand = z.infer<typeof sandboxCommandSchema>;

const postingSchema = z.object({
  account: z.enum(["GOOPER_CASH", "FUNDED_EXPOSURE", "MERCHANT_RECEIVABLE"]),
  deltaMinor: z.number().int().min(-100_000).max(100_000),
});
type Posting = z.infer<typeof postingSchema>;

export const sandboxStateSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.literal("SANDBOX"),
  id: z.string().uuid(),
  currency: z.enum(["CAD", "USD"]),
  amountMinor: minorUnits.refine((amount) => amount > 0),
  risk: z.enum(["PENDING", "APPROVED"]),
  payout: z.enum(["NOT_STARTED", "PENDING", "UNKNOWN", "FAILED", "SUCCEEDED"]),
  payoutAttempt: z.number().int().nonnegative(),
  // Older snapshots predate durable intents; they cannot accept new outcomes.
  payoutIntentId: z.string().uuid().nullable().default(null),
  returnStatus: z.enum([
    "AWAITING_RETURN",
    "RECEIVED",
    "APPROVED",
    "PARTIALLY_APPROVED",
    "REJECTED",
  ]),
  acceptedMinor: minorUnits,
  collection: z.enum([
    "NOT_DUE",
    "DUE",
    "PENDING",
    "UNKNOWN",
    "FAILED",
    "SETTLED",
  ]),
  collectionAttempt: z.number().int().nonnegative(),
  collectionIntentId: z.string().uuid().nullable().default(null),
  // Set only for a case started from a real development-store order line.
  order: z
    .object({
      orderId: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/),
      orderName: z.string().max(100),
      lineItemId: z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/),
      title: z.string().max(255),
      quantity: z.number().int().positive().max(1000),
    })
    .nullable()
    .default(null),
  events: z
    .array(
      z.object({
        command: sandboxCommandSchema,
        at: z.string().datetime(),
        postings: z.array(postingSchema),
      }),
    )
    .max(100),
});
export type SandboxState = z.infer<typeof sandboxStateSchema>;

export class SandboxError extends Error {}

function requireState(condition: boolean, message: string): asserts condition {
  if (!condition) throw new SandboxError(message);
}

export type SandboxOrderLink = NonNullable<SandboxState["order"]>;

export function createSandboxState(
  id: string,
  currency: "CAD" | "USD",
  { amountMinor = 5000, order = null }: { amountMinor?: number; order?: SandboxOrderLink | null } = {},
): SandboxState {
  return sandboxStateSchema.parse({
    schemaVersion: 1,
    mode: "SANDBOX",
    id,
    currency,
    amountMinor,
    risk: "PENDING",
    payout: "NOT_STARTED",
    payoutAttempt: 0,
    payoutIntentId: null,
    returnStatus: "AWAITING_RETURN",
    acceptedMinor: 0,
    collection: "NOT_DUE",
    collectionAttempt: 0,
    collectionIntentId: null,
    order,
    events: [],
  });
}

export function sandboxBalances(state: SandboxState) {
  const balances = {
    GOOPER_CASH: 0,
    FUNDED_EXPOSURE: 0,
    MERCHANT_RECEIVABLE: 0,
  };
  for (const event of state.events) {
    for (const posting of event.postings)
      balances[posting.account] += posting.deltaMinor;
  }
  return balances;
}

export function sandboxOperationReference(
  state: SandboxState,
  operation: SandboxOperation,
) {
  return operation === "payout"
    ? state.payoutIntentId
    : state.collectionIntentId;
}

// What the next request for an operation must pay or collect. Payout is the
// funded amount; collection is only the principal approved at inspection.
export function sandboxNextPayment(
  state: SandboxState,
  operation: SandboxOperation,
) {
  return {
    attempt:
      (operation === "payout" ? state.payoutAttempt : state.collectionAttempt) +
      1,
    amountMinor:
      operation === "payout" ? state.amountMinor : state.acceptedMinor,
    currency: state.currency,
  };
}

function requireBinding(
  state: SandboxState,
  command: SandboxCommand,
  isRequest: boolean,
) {
  const operation = sandboxActionOperation(command.action)!;
  const payment = command.payment!;
  const expected = sandboxNextPayment(state, operation);
  const currentIntent = sandboxOperationReference(state, operation);
  requireState(
    payment.attempt === expected.attempt - (isRequest ? 0 : 1) &&
      payment.amountMinor === expected.amountMinor &&
      payment.currency === expected.currency &&
      (isRequest
        ? payment.intentId !== currentIntent
        : payment.intentId === currentIntent),
    isRequest
      ? "The payment request does not match the amount due."
      : "This payment outcome does not match the current attempt.",
  );
}

// This is the provider-neutral workflow seam: matched provider outcomes enter
// here through durable payment intents. Screens never assert outcomes.
export function applySandboxCommand(
  previous: SandboxState,
  input: SandboxCommand,
  at = new Date().toISOString(),
): SandboxState {
  const command = sandboxCommandSchema.parse(input);
  const replay = previous.events.find(
    (event) => event.command.id === command.id,
  );
  if (replay) {
    requireState(
      JSON.stringify(replay.command) === JSON.stringify(command),
      "This action ID was already used for a different action.",
    );
    return previous;
  }
  requireState(
    previous.events.length < 100,
    "This test case is full. Start a new sample return.",
  );
  const state = sandboxStateSchema.parse(previous);
  const postings: Posting[] = [];
  const awaitingPayout =
    state.payout === "PENDING" || state.payout === "UNKNOWN";
  const awaitingCollection =
    state.collection === "PENDING" || state.collection === "UNKNOWN";

  const operation = sandboxActionOperation(command.action);
  if (operation) {
    const isRequest = command.action.startsWith("REQUEST_");
    // Preconditions below produce the clearer error when an action is early.
    const ready =
      operation === "payout"
        ? isRequest
          ? state.risk === "APPROVED"
          : awaitingPayout
        : isRequest
          ? state.acceptedMinor > 0
          : awaitingCollection;
    if (ready) requireBinding(state, command, isRequest);
  }

  switch (command.action) {
    case "APPROVE_RISK":
      requireState(
        state.risk === "PENDING",
        "Risk was already approved for this sample.",
      );
      state.risk = "APPROVED";
      break;
    case "REQUEST_PAYOUT":
      requireState(
        state.risk === "APPROVED",
        "Approve the sample risk check before funding.",
      );
      requireState(
        state.payout === "NOT_STARTED" || state.payout === "FAILED",
        "A payout already exists. Resolve its outcome before trying again.",
      );
      state.payout = "PENDING";
      state.payoutAttempt += 1;
      state.payoutIntentId = command.payment!.intentId;
      break;
    case "PAYOUT_UNKNOWN":
      requireState(
        state.payout === "PENDING",
        "Only a pending payout can time out.",
      );
      state.payout = "UNKNOWN";
      break;
    case "PAYOUT_FAILED":
      requireState(awaitingPayout, "There is no unresolved payout to fail.");
      state.payout = "FAILED";
      break;
    case "PAYOUT_SUCCEEDED":
      requireState(awaitingPayout, "There is no unresolved payout to confirm.");
      state.payout = "SUCCEEDED";
      postings.push(
        { account: "GOOPER_CASH", deltaMinor: -state.amountMinor },
        { account: "FUNDED_EXPOSURE", deltaMinor: state.amountMinor },
      );
      break;
    case "RECEIVE_ITEM":
      requireState(
        state.payout === "SUCCEEDED",
        "Confirm the sample customer payout first.",
      );
      requireState(
        state.returnStatus === "AWAITING_RETURN",
        "The sample item was already received.",
      );
      state.returnStatus = "RECEIVED";
      break;
    case "INSPECT_ITEM": {
      requireState(
        state.payout === "SUCCEEDED" && state.returnStatus === "RECEIVED",
        "Receive the item before approving or rejecting it.",
      );
      const accepted = command.acceptedMinor!;
      requireState(
        accepted <= state.amountMinor,
        "The accepted amount cannot exceed the customer payout.",
      );
      state.acceptedMinor = accepted;
      state.returnStatus =
        accepted === 0
          ? "REJECTED"
          : accepted === state.amountMinor
            ? "APPROVED"
            : "PARTIALLY_APPROVED";
      if (accepted > 0) {
        state.collection = "DUE";
        postings.push(
          { account: "FUNDED_EXPOSURE", deltaMinor: -accepted },
          { account: "MERCHANT_RECEIVABLE", deltaMinor: accepted },
        );
      }
      // Rejected principal stays exposed for review. No invented right to
      // charge the customer, force merchant repayment, or auto-write off loss.
      break;
    }
    case "REQUEST_COLLECTION":
      requireState(
        state.payout === "SUCCEEDED" &&
          state.acceptedMinor > 0 &&
          (state.collection === "DUE" || state.collection === "FAILED"),
        "Repayment requires a paid customer and explicit merchant inspection approval.",
      );
      state.collection = "PENDING";
      state.collectionAttempt += 1;
      state.collectionIntentId = command.payment!.intentId;
      break;
    case "COLLECTION_UNKNOWN":
      requireState(
        state.collection === "PENDING",
        "Only a pending collection can time out.",
      );
      state.collection = "UNKNOWN";
      break;
    case "COLLECTION_FAILED":
      requireState(
        awaitingCollection,
        "There is no unresolved collection to fail.",
      );
      state.collection = "FAILED";
      break;
    case "COLLECTION_SUCCEEDED":
      requireState(
        awaitingCollection,
        "There is no unresolved collection to settle.",
      );
      state.collection = "SETTLED";
      postings.push(
        { account: "MERCHANT_RECEIVABLE", deltaMinor: -state.acceptedMinor },
        { account: "GOOPER_CASH", deltaMinor: state.acceptedMinor },
      );
      break;
  }
  state.events.push({ command, at, postings });
  return sandboxStateSchema.parse(state);
}

export function sandboxActionAvailable(
  state: SandboxState,
  action: SandboxAction,
) {
  const operation = sandboxActionOperation(action);
  try {
    applySandboxCommand(state, {
      id: "00000000-0000-4000-8000-000000000000",
      action,
      ...(action === "INSPECT_ITEM"
        ? { acceptedMinor: state.amountMinor }
        : {}),
      ...(operation
        ? {
            payment: action.startsWith("REQUEST_")
              ? {
                  ...sandboxNextPayment(state, operation),
                  intentId: "00000000-0000-4000-8000-000000000001",
                }
              : {
                  ...sandboxNextPayment(state, operation),
                  attempt: Math.max(
                    1,
                    sandboxNextPayment(state, operation).attempt - 1,
                  ),
                  intentId:
                    sandboxOperationReference(state, operation) ??
                    "00000000-0000-4000-8000-000000000001",
                },
          }
        : {}),
    });
    return true;
  } catch {
    return false;
  }
}

export function parseSandboxMoney(value: string) {
  requireState(
    /^\d{1,4}(\.\d{1,2})?$/.test(value),
    "Enter an amount with no more than two decimal places.",
  );
  const [whole, fraction = ""] = value.split(".");
  return minorUnits.parse(
    Number(whole) * 100 + Number(fraction.padEnd(2, "0")),
  );
}
