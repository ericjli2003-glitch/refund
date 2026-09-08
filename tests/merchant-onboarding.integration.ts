import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import prisma from "../app/db.server";
import {
  provisionMerchant,
  resolveMerchant,
  findPublishedMerchants,
} from "../app/services/merchant-directory.server";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Requires isolated refund_ci PostgreSQL database",
);
const prefix = `onboarding-${randomUUID()}`;
const shops = [`${prefix}.myshopify.com`, `${prefix}-duplicate.myshopify.com`];
const name = `Demo ${randomUUID()}`;
const admin = (shop: string) =>
  ({
    graphql: async () =>
      Response.json({
        data: {
          shop: {
            myshopifyDomain: shop,
            name,
            currencyCode: "CAD",
            primaryDomain: { host: shop },
          },
        },
      }),
  }) as Parameters<typeof provisionMerchant>[1];
try {
  for (const shop of shops) {
    await prisma.session.create({
      data: {
        id: `offline_${shop}`,
        shop,
        state: "test",
        isOnline: false,
        accessToken: "test-only-never-sent",
      },
    });
    await provisionMerchant(shop, admin(shop));
  }
  const policy = await prisma.storePolicy.findUniqueOrThrow({
    where: { shop: shops[0] },
  });
  assert.equal(policy.currencyCode, "CAD");
  assert.equal(policy.automaticRefundsEnabled, false);
  await prisma.storePolicy.update({
    where: { shop: shops[0] },
    data: {
      returnWindowDays: 7,
      maxAutoRefundAmount: "17.00",
      automaticRefundsEnabled: true,
    },
  });
  await provisionMerchant(shops[0], admin(shops[0]));
  const repeated = await prisma.storePolicy.findUniqueOrThrow({
    where: { shop: shops[0] },
  });
  assert.equal(repeated.returnWindowDays, 7);
  assert.equal(repeated.maxAutoRefundAmount, "17.00");
  assert.equal(repeated.automaticRefundsEnabled, true);
  assert.deepEqual(
    await findPublishedMerchants(name),
    [],
    "Private installations are not published automatically",
  );
  await prisma.merchantDirectory.update({
    where: { shop: shops[0] },
    data: { discoveryPublished: true },
  });
  assert.equal(
    await resolveMerchant(""),
    null,
    "A missing merchant must not select the only published store",
  );
  assert.equal(await resolveMerchant("   "), null);
  assert.equal(
    (await resolveMerchant(`  ${name.toUpperCase()}   STOREFRONT `))?.shop,
    shops[0],
  );
  await prisma.merchantDirectory.update({
    where: { shop: shops[1] },
    data: { discoveryPublished: true },
  });
  assert.equal(
    await resolveMerchant(name),
    null,
    "Duplicate names must never silently pick a merchant",
  );
  await prisma.session.deleteMany({ where: { shop: shops[1] } });
  assert.equal(
    (await resolveMerchant(name))?.shop,
    shops[0],
    "Uninstalled merchants are excluded",
  );
  await prisma.session.deleteMany({ where: { shop: shops[0] } });
  assert.deepEqual(await findPublishedMerchants(name), []);
  console.log(
    "Passed: automatic provisioning, store currency, preservation of settings, publication scope, alias resolution, ambiguity, uninstall visibility.",
  );
} finally {
  await prisma.merchantDirectory.deleteMany({ where: { shop: { in: shops } } });
  await prisma.storePolicy.deleteMany({ where: { shop: { in: shops } } });
  await prisma.session.deleteMany({ where: { shop: { in: shops } } });
  await prisma.$disconnect();
}
