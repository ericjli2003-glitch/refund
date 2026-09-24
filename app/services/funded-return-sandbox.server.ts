import type { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "../db.server";
import {
  applySandboxCommand,
  createSandboxState,
  SandboxError,
  sandboxActionOperation,
  sandboxStateSchema,
  type SandboxCommand,
} from "../funded-return-sandbox";

export function fundedSandboxEnabled(environment = process.env) {
  return (
    (environment.NODE_ENV === "development" ||
      environment.NODE_ENV === "test") &&
    environment.GOOPER_FUNDED_RETURNS_SANDBOX === "1"
  );
}

export function requireFundedSandbox() {
  if (!fundedSandboxEnabled()) throw new Response("Not found", { status: 404 });
}

export async function createFundedSandbox(
  shop: string,
  id: string,
  currency: "CAD" | "USD",
  options: Parameters<typeof createSandboxState>[2] = {},
) {
  requireFundedSandbox();
  const state = createSandboxState(id, currency, options);
  const row = await prisma.fundedReturnSandbox.upsert({
    where: { shop_id: { shop, id } },
    create: { shop, id, snapshot: state },
    update: {},
  });
  const existing = sandboxStateSchema.parse(row.snapshot);
  if (existing.currency !== currency)
    throw new SandboxError("That sample ID already uses another currency.");
  return row;
}

export async function listFundedSandboxes(shop: string) {
  requireFundedSandbox();
  const rows = await prisma.fundedReturnSandbox.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    createdAt: row.createdAt,
    state: sandboxStateSchema.parse(row.snapshot),
  }));
}

// Only real development-store orders whose line-item units are actively
// reserved for Gooper may use funded-return wording on the main dashboard.
// Synthetic samples and ordinary Shopify refunds never enter this list.
export async function listDashboardFundedReturns(shop: string) {
  requireFundedSandbox();
  const cases = await listFundedSandboxes(shop);
  if (!cases.length) return [];
  const funded = await prisma.fundedEntitlement.findMany({
    where: {
      shop,
      status: "ACTIVE",
      caseId: { in: cases.map((row) => row.id) },
    },
    select: { caseId: true, orderId: true },
  });
  return cases.filter(
    (row) =>
      row.state.payout === "SUCCEEDED" &&
      row.state.order !== null &&
      funded.some(
        (unit) =>
          unit.caseId === row.id && unit.orderId === row.state.order?.orderId,
      ),
  );
}

export async function updateDashboardFundedReturn(
  shop: string,
  input: {
    id: string;
    version: number;
    actionId: string;
    action: "RECEIVE_ITEM" | "INSPECT_ITEM";
  },
) {
  requireFundedSandbox();
  const id = z.string().uuid().parse(input.id);
  const version = z.number().int().nonnegative().parse(input.version);
  const actionId = z.string().uuid().parse(input.actionId);
  const row = (await listDashboardFundedReturns(shop)).find(
    (candidate) => candidate.id === id,
  );
  if (!row)
    throw new SandboxError("This isn't an active Gooper-funded return.");
  await updateFundedSandbox(shop, id, version, {
    id: actionId,
    action: input.action,
    ...(input.action === "INSPECT_ITEM"
      ? { acceptedMinor: row.state.amountMinor }
      : {}),
  });
}

type Transaction = Prisma.TransactionClient;

export class CaseVersionConflict extends Error {}

// Applies one workflow command inside a caller's transaction. With an expected
// version the merchant's view must be current; without one (matched provider
// outcomes) the row version still guards against concurrent writers.
export async function applyCaseCommand(
  transaction: Transaction,
  shop: string,
  id: string,
  expectedVersion: number | null,
  command: SandboxCommand,
) {
  const row = await transaction.fundedReturnSandbox.findUnique({
    where: { shop_id: { shop, id } },
  });
  if (!row) throw new SandboxError("Sample return not found for this store.");
  const previous = sandboxStateSchema.parse(row.snapshot);
  const next = applySandboxCommand(previous, command);
  // A retried POST is a no-op even if its old expected version is now stale.
  if (next === previous) return { changed: false, state: previous };
  if (expectedVersion !== null && row.version !== expectedVersion)
    throw new SandboxError("This sample changed. Refresh and try again.");
  const changed = await transaction.fundedReturnSandbox.updateMany({
    where: { shop, id, version: row.version },
    data: { snapshot: next, version: { increment: 1 } },
  });
  if (changed.count !== 1)
    throw expectedVersion === null
      ? new CaseVersionConflict("Sample changed during a provider update.")
      : new SandboxError(
          "Another action just updated this sample. Refresh and try again.",
        );
  return { changed: true, state: next };
}

export async function updateFundedSandbox(
  shop: string,
  id: string,
  version: number,
  command: SandboxCommand,
) {
  requireFundedSandbox();
  z.string().uuid().parse(id);
  z.number().int().nonnegative().parse(version);
  // Payment requests create durable intents, and only matched provider
  // outcomes may resolve them. Neither can be asserted from a screen.
  if (sandboxActionOperation(command.action))
    throw new SandboxError("Payments go through the sandbox payment provider.");
  await prisma.$transaction((transaction) =>
    applyCaseCommand(transaction, shop, id, version, command),
  );
}
