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
) {
  requireFundedSandbox();
  const state = createSandboxState(id, currency);
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
    state: sandboxStateSchema.parse(row.snapshot),
  }));
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
