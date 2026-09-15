import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import prisma from "../app/db.server";
import {
  consumePublicRateLimit,
  prunePublicRateLimits,
  publicRateLimitKey,
} from "../app/services/public-rate-limit.server";
import {
  refreshInstalledMerchants,
  runMerchantMaintenance,
} from "../app/services/merchant-maintenance.server";
import { syncMerchantDirectory } from "../app/services/merchant-directory.server";
import {
  createPublicRateLimiter,
  publicRatePolicy,
  trustedProxyHops,
} from "../server/public-rate-limit";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Infrastructure tests require the isolated local refund_ci database",
);
process.env.SHOPIFY_API_SECRET ||= "test-secret";

test("public infrastructure enforces shared limits and maintains installed merchants", async (t) => {
  t.after(() => prisma.$disconnect());
  await t.test(
    "concurrent consumers share one atomic quota, expiry resets it, and cleanup retains active limits",
    async () => {
      const policy = { bucket: `ci-${randomUUID()}`, limit: 7, seconds: 60 };
      const identity = randomUUID();
      const key = publicRateLimitKey(identity, policy.bucket);
      try {
        const results = await Promise.all(
          Array.from({ length: 40 }, () =>
            consumePublicRateLimit(identity, policy),
          ),
        );
        assert.equal(results.filter((result) => result.allowed).length, 7);
        assert.ok(
          results.every(
            (result) => result.retryAfter > 0 && result.retryAfter <= 60,
          ),
        );
        assert.equal(
          (await prisma.publicRateLimit.findUniqueOrThrow({ where: { key } }))
            .hits,
          8,
        );
        assert.ok(!key.includes(identity));
        await prunePublicRateLimits();
        assert.equal(
          (await consumePublicRateLimit(identity, policy)).allowed,
          false,
        );
        await prisma.publicRateLimit.update({
          where: { key },
          data: { expiresAt: new Date(0) },
        });
        assert.equal(
          (await consumePublicRateLimit(identity, policy)).allowed,
          true,
        );
        await prisma.publicRateLimit.update({
          where: { key },
          data: { expiresAt: new Date(0) },
        });
        await prunePublicRateLimits();
        assert.equal(
          await prisma.publicRateLimit.findUnique({ where: { key } }),
          null,
        );
      } finally {
        await prisma.publicRateLimit.deleteMany({ where: { key } });
      }
    },
  );

  await t.test(
    "HTTP preserves preflight, returns retry guidance, and ignores forged proxy prefixes",
    async () => {
      assert.equal(
        publicRatePolicy("/mcp/public")?.bucket,
        publicRatePolicy("/api/return-intake/")?.bucket,
      );
      assert.equal(publicRatePolicy("/REGISTER/")?.bucket, "register");
      assert.equal(publicRatePolicy("/start-return.data")?.bucket, "intake");
      assert.equal(publicRatePolicy("/health"), null);
      for (const path of [
        "/customer/login",
        "/customer/callback.data",
        "/verify/email/token",
        "/verify/connect-email/token",
        "/connect/manage",
      ])
        assert.equal(publicRatePolicy(path)?.bucket, "sign-in");
      assert.equal(publicRatePolicy("/mcp/stores"), null);
      assert.equal(publicRatePolicy("/mcp"), null);
      assert.equal(publicRatePolicy("/agent/authorize/request")?.bucket, "consent");
      assert.equal(trustedProxyHops("0"), 0);
      assert.throws(() => trustedProxyHops("true"));
      const identities: string[] = [];
      let fail = false;
      const app = express();
      app.set("trust proxy", 1);
      app.use(
        createPublicRateLimiter(async (identity) => {
          identities.push(identity);
          if (fail) throw new Error("private database error");
          return { allowed: false, retryAfter: 17 };
        }),
      );
      app.use((_req, res) => res.sendStatus(204));
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}`;
      try {
        assert.equal(
          (await fetch(`${url}/api/return-intake`, { method: "OPTIONS" }))
            .status,
          204,
        );
        assert.equal((await fetch(`${url}/health`)).status, 204);
        assert.equal(identities.length, 0);
        const denied = await fetch(`${url}/register`, {
          method: "POST",
          headers: { "X-Forwarded-For": "198.51.100.1, 203.0.113.9" },
        });
        assert.equal(denied.status, 429);
        assert.equal(denied.headers.get("Retry-After"), "17");
        assert.equal(denied.headers.get("Access-Control-Allow-Origin"), "*");
        assert.deepEqual(identities, ["203.0.113.9"]);
        fail = true;
        const unavailable = await fetch(`${url}/authorize`);
        assert.equal(unavailable.status, 503);
        assert.equal(
          (await unavailable.json()).error,
          "temporarily_unavailable",
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  await t.test(
    "backfill spans pages, deduplicates offline sessions, isolates failures and preserves merchant choices",
    async () => {
      const prefix = `maintenance-ci-${randomUUID().slice(0, 8)}`;
      const shops = Array.from(
        { length: 55 },
        (_, index) =>
          `${prefix}-${String(index).padStart(2, "0")}.myshopify.com`,
      );
      const onlineOnly = `${prefix}-online.myshopify.com`;
      await prisma.session.createMany({
        data: [
          ...shops.map((shop) => ({
            id: `offline_${shop}`,
            shop,
            state: "ci",
            accessToken: "ci-only",
            isOnline: false,
          })),
          {
            id: `${prefix}-duplicate`,
            shop: shops[0],
            state: "ci",
            accessToken: "ci-only",
            isOnline: false,
          },
          {
            id: `${prefix}-online`,
            shop: onlineOnly,
            state: "ci",
            accessToken: "ci-only",
            isOnline: true,
          },
        ],
      });
      await prisma.merchantDirectory.create({
        data: {
          shop: shops[0],
          primaryDomain: `${prefix}.old.example.com`,
          name: "Original",
          discoveryPublished: false,
        },
      });
      await prisma.storePolicy.create({
        data: {
          shop: shops[0],
          automaticRefundsEnabled: false,
          maxAutoRefundAmount: "12.00",
          currencyCode: "CAD",
        },
      });
      const visited = new Set<string>();
      let renewals = 0;
      try {
        const result = await refreshInstalledMerchants(
          async (shop) => {
            assert.ok(
              shops.includes(shop),
              "Only this test's installed offline shops should exist",
            );
            assert.equal(visited.has(shop), false);
            visited.add(shop);
            if (shop === shops[1])
              throw new Error("Simulated expired installation");
            await syncMerchantDirectory(shop, {
              graphql: async () =>
                Response.json({
                  data: {
                    shop: {
                      myshopifyDomain: shop,
                      name: "Updated",
                      currencyCode: "CAD",
                      primaryDomain: {
                        host:
                          shop === shops[0]
                            ? `${prefix}.new.example.com`
                            : shop,
                      },
                    },
                  },
                }),
            } as Parameters<typeof syncMerchantDirectory>[1]);
          },
          async () => {
            renewals++;
          },
        );
        assert.deepEqual(result, { refreshed: 54, failed: 1 });
        assert.equal(renewals, 55);
        const profile = await prisma.merchantDirectory.findUniqueOrThrow({
          where: { shop: shops[0] },
        });
        assert.equal(profile.primaryDomain, `${prefix}.new.example.com`);
        assert.equal(profile.discoveryPublished, false);
        const policy = await prisma.storePolicy.findUniqueOrThrow({
          where: { shop: shops[0] },
        });
        assert.equal(policy.maxAutoRefundAmount, "12.00");
        assert.equal(policy.automaticRefundsEnabled, false);
      } finally {
        await prisma.session.deleteMany({
          where: { shop: { in: [...shops, onlineOnly] } },
        });
        await prisma.merchantDirectory.deleteMany({
          where: { shop: { in: shops } },
        });
        await prisma.storePolicy.deleteMany({ where: { shop: { in: shops } } });
      }
    },
  );

  await t.test(
    "only one replica holds the maintenance lease; failed jobs can retry",
    async () => {
      await prisma.maintenanceLease.deleteMany({
        where: { key: "merchant-directory" },
      });
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = runMerchantMaintenance(async (_refresh, renew) => {
        await renew!();
        entered();
        await blocked;
        return { refreshed: 1, failed: 0 };
      });
      await Promise.race([started, first]);
      try {
        assert.equal(
          await runMerchantMaintenance(async () => {
            throw new Error("Second replica must not run");
          }),
          null,
        );
        release();
        assert.deepEqual(await first, { refreshed: 1, failed: 0 });
        assert.equal(await runMerchantMaintenance(), null);
        await prisma.maintenanceLease.update({
          where: { key: "merchant-directory" },
          data: { expiresAt: new Date(0) },
        });
        await assert.rejects(
          runMerchantMaintenance(async () => {
            throw new Error("Simulated failure");
          }),
          /Simulated failure/,
        );
        const lease = await prisma.maintenanceLease.findUniqueOrThrow({
          where: { key: "merchant-directory" },
        });
        assert.ok(lease.expiresAt.getTime() - Date.now() <= 300_000);
      } finally {
        release();
        await first;
        await prisma.maintenanceLease.deleteMany({
          where: { key: "merchant-directory" },
        });
      }
    },
  );
});
