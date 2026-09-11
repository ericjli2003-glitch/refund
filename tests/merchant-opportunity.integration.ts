import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import { recordMerchantOpportunity } from "../app/services/merchant-opportunity.server";
import { startReturnIntake } from "../app/services/return-intake.server";
import {
  action as report,
  loader as reportRead,
} from "../app/routes/api.merchant-discovery-failure";
import { loader as lookupRead } from "../app/routes/api.merchants";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Requires isolated refund_ci PostgreSQL database",
);
process.env.SHOPIFY_APP_URL = "https://refund.test";
const prefix = `Opportunity ${randomUUID()}`;
const shop = `opportunity-${randomUUID()}.myshopify.com`;
const shops = [shop, `duplicate-${shop}`];
const absent = `absent-${randomUUID()}.myshopify.com`;
const labels = [prefix, `${prefix} unknown`, absent];
const args = (request: Request) => ({
  request,
  params: {},
  context: {},
  url: new URL(request.url),
  pattern: "/api/merchant-discovery-failure",
});
const request = () =>
  new Request("https://refund.test/api/merchant-discovery-failure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchant: prefix }),
  });
try {
  await prisma.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: "test",
      isOnline: false,
      accessToken: "test-only-never-sent",
    },
  });
  await prisma.merchantDirectory.create({
    data: {
      shop,
      primaryDomain: shop,
      name: prefix,
      aliases: [prefix.toLowerCase()],
      discoveryPublished: true,
    },
  });
  const before = await prisma.returnDraft.count();
  const returnsBefore = await prisma.agentReturn.count();
  const response = await report(args(request()));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.status, "stopped");
  assert.equal(body.returnSubmitted, false);
  assert.equal(body.refundSubmitted, false);
  assert.doesNotMatch(
    JSON.stringify(body),
    /opportunit|knownShop|merchantLabel|UNREVIEWED|continueUrl/i,
  );
  await recordMerchantOpportunity(prefix.toUpperCase(), "discovery_report");
  const entries = await prisma.merchantOpportunity.findMany({
    where: { merchantLabel: prefix },
  });
  assert.equal(
    entries.length,
    1,
    "Retries/case changes collapse to one daily signal",
  );
  assert.equal(
    entries[0].kind,
    "DISCOVERY_GAP",
    "Installed store is not a new merchant lead",
  );
  assert.equal(entries[0].knownShop, shop);
  assert.equal(entries[0].reviewStatus, "UNREVIEWED");
  const read = await reportRead(
    args(new Request("https://refund.test/api/merchant-discovery-failure")),
  );
  assert.equal(read.status, 405, "No public read access to opportunities");
  await lookupRead(
    args(
      new Request(
        `https://refund.test/api/merchants?query=${encodeURIComponent(labels[1])}`,
      ),
    ),
  );
  assert.equal(
    await prisma.merchantOpportunity.count({
      where: { merchantLabel: labels[1] },
    }),
    0,
    "Passive GET lookup creates no opportunity",
  );
  const failure = await startReturnIntake({
    merchant: absent,
    itemName: "private product",
    orderName: "private order",
  });
  assert.equal(failure.status, "merchant_not_resolved");
  assert.equal("continueUrl" in failure, false);
  const unverified = await prisma.merchantOpportunity.findFirstOrThrow({
    where: { merchantLabel: absent },
  });
  assert.equal(unverified.kind, "UNRESOLVED_MERCHANT");
  assert.equal(unverified.knownShop, null);
  assert.doesNotMatch(
    JSON.stringify(unverified),
    /private product|private order/,
  );
  await prisma.session.create({
    data: {
      id: `offline_${shops[1]}`,
      shop: shops[1],
      state: "test",
      isOnline: false,
      accessToken: "test-only-never-sent",
    },
  });
  await prisma.merchantDirectory.create({
    data: {
      shop: shops[1],
      primaryDomain: shops[1],
      name: prefix,
      aliases: [prefix.toLowerCase()],
      discoveryPublished: true,
    },
  });
  await recordMerchantOpportunity(prefix, "lookup");
  assert.equal(
    (
      await prisma.merchantOpportunity.findUniqueOrThrow({
        where: { id: entries[0].id },
      })
    ).kind,
    "AMBIGUOUS_MATCH",
  );
  await prisma.merchantOpportunity.update({
    where: { id: unverified.id },
    data: { expiresAt: new Date(0) },
  });
  await recordMerchantOpportunity(prefix, "lookup");
  assert.equal(
    await prisma.merchantOpportunity.findUnique({
      where: { id: unverified.id },
    }),
    null,
    "Expired signals are removed",
  );
  assert.equal(
    await prisma.returnDraft.count(),
    before,
    "Discovery failure never creates a return draft",
  );
  assert.equal(
    await prisma.agentReturn.count(),
    returnsBefore,
    "Discovery failure never submits anything",
  );
  console.log(
    "Passed: private persisted opportunities, daily dedupe, installed/unknown/ambiguous classification, passive-read exclusion, retention, no sensitive hints, no return side effects.",
  );
} finally {
  await prisma.merchantOpportunity.deleteMany({
    where: { merchantLabel: { in: labels } },
  });
  await prisma.merchantDirectory.deleteMany({ where: { shop: { in: shops } } });
  await prisma.session.deleteMany({ where: { shop: { in: shops } } });
  await prisma.$disconnect();
}
