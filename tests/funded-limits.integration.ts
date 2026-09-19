import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import {
  createFundedSandbox,
  updateFundedSandbox,
} from "../app/services/funded-return-sandbox.server";
import { requestSandboxPayment } from "../app/services/funded-payment-intents.server";
import { fundingLimits } from "../app/services/funded-limits.server";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Requires isolated refund_ci PostgreSQL database",
);
process.env.NODE_ENV = "test";
process.env.GOOPER_FUNDED_RETURNS_SANDBOX = "1";
const shops: string[] = [];
const saved = { ...process.env };

async function approvedCase(shop: string, currency: "CAD" | "USD" = "CAD", amountMinor = 5000) {
  const id = randomUUID();
  await createFundedSandbox(shop, id, currency, { amountMinor });
  await updateFundedSandbox(shop, id, 0, { id: randomUUID(), action: "APPROVE_RISK" });
  return id;
}
const payout = (shop: string, caseId: string) =>
  requestSandboxPayment({ shop, caseId, version: 1, commandId: randomUUID(), operation: "payout" });
const newShop = () => {
  const shop = `limits-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  return shop;
};

try {
  // Defaults are the proposed pilot numbers; bad overrides fail loudly.
  assert.deepEqual(fundingLimits({}), {
    paused: false,
    perReturnMinor: 15_000,
    perMerchantMinor: 150_000,
    portfolioMinor: 1_400_000,
  });
  assert.throws(() => fundingLimits({ GOOPER_FUNDED_MAX_PER_RETURN_CENTS: "12.5" }));
  assert.throws(() => fundingLimits({ GOOPER_FUNDED_MAX_PER_MERCHANT_CENTS: "-1" }));

  // Kill switch.
  {
    const shop = newShop();
    const id = await approvedCase(shop);
    process.env.GOOPER_FUNDED_PAUSED = "1";
    await assert.rejects(payout(shop, id), /paused.*No payout was requested/);
    delete process.env.GOOPER_FUNDED_PAUSED;
    assert.equal(await prisma.fundedPaymentIntent.count({ where: { shop } }), 0);
    await payout(shop, id);
  }

  // Per-return cap.
  {
    const shop = newShop();
    const id = await approvedCase(shop, "CAD", 20_000);
    await assert.rejects(payout(shop, id), /per-return limit/);
  }

  // Per-merchant cap: a payout in flight and unrepaid exposure both count;
  // another store and another currency don't.
  {
    process.env.GOOPER_FUNDED_MAX_PER_MERCHANT_CENTS = "10000";
    const shop = newShop();
    await payout(shop, await approvedCase(shop));
    await payout(shop, await approvedCase(shop));
    await assert.rejects(payout(shop, await approvedCase(shop)), /store has reached its limit/);
    const other = newShop();
    await payout(other, await approvedCase(other));
    await payout(shop, await approvedCase(shop, "USD"));
    delete process.env.GOOPER_FUNDED_MAX_PER_MERCHANT_CENTS;
  }

  // Concurrent payouts with room for exactly one: one wins.
  {
    process.env.GOOPER_FUNDED_MAX_PER_MERCHANT_CENTS = "5000";
    const shop = newShop();
    const [a, b] = [await approvedCase(shop), await approvedCase(shop)];
    const results = await Promise.allSettled([payout(shop, a), payout(shop, b)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    delete process.env.GOOPER_FUNDED_MAX_PER_MERCHANT_CENTS;
  }

  // Portfolio cap across stores.
  {
    const existing = await prisma.fundedReturnSandbox.findMany({ select: { snapshot: true } });
    // Room for exactly one more $50 payout across everything already in the DB.
    const { sandboxStateSchema, sandboxBalances } = await import("../app/funded-return-sandbox");
    let outstanding = 0;
    for (const row of existing) {
      const state = sandboxStateSchema.parse(row.snapshot);
      if (state.currency !== "CAD") continue;
      if (state.payout === "PENDING" || state.payout === "UNKNOWN") outstanding += state.amountMinor;
      else if (state.payout === "SUCCEEDED") {
        const balances = sandboxBalances(state);
        outstanding += balances.FUNDED_EXPOSURE + balances.MERCHANT_RECEIVABLE;
      }
    }
    process.env.GOOPER_FUNDED_MAX_PORTFOLIO_CENTS = String(outstanding + 5000);
    const first = newShop();
    await payout(first, await approvedCase(first));
    const second = newShop();
    await assert.rejects(payout(second, await approvedCase(second)), /total limit/);
    delete process.env.GOOPER_FUNDED_MAX_PORTFOLIO_CENTS;
  }

  // Limits apply to payouts only, never to repayment collection.
  console.log(
    "Passed: funding limits — kill switch, per-return, per-merchant (in-flight and unrepaid, per store and currency), concurrent payouts, portfolio.",
  );
} finally {
  process.env = saved;
  await prisma.fundedPaymentIntent.deleteMany({ where: { shop: { in: shops } } });
  await prisma.fundedReturnSandbox.deleteMany({ where: { shop: { in: shops } } });
  await prisma.$disconnect();
}
