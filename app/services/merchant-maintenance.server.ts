import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { pruneAccessLog } from "./access-log.server";
import { pruneExpiredCustomerAccess } from "./agent-access.server";
import { syncMerchantDirectory } from "./merchant-directory.server";
import { prunePublicRateLimits } from "./public-rate-limit.server";

// One shop's directory row, brought back in line with Shopify. Shared by the
// six-hourly sweep and by the shop/update webhook.
export async function refreshShop(shop: string) {
  const { unauthenticated } = await import("../shopify.server");
  const { admin } = await unauthenticated.admin(shop);
  await syncMerchantDirectory(shop, admin);
  // If uninstall finished while the Admin query was in flight, remove the stale
  // mapping. Publication still requires a current installation on every lookup.
  if (
    !(await prisma.session.findFirst({
      where: { shop, isOnline: false },
      select: { id: true },
    }))
  )
    await prisma.merchantDirectory.deleteMany({ where: { shop } });
}

export async function refreshInstalledMerchants(
  refresh = refreshShop,
  renew: () => Promise<void> = async () => {},
) {
  let cursor: string | undefined;
  const result = { refreshed: 0, failed: 0 };
  for (;;) {
    const shops = await prisma.session.groupBy({
      by: ["shop"],
      where: { isOnline: false, ...(cursor ? { shop: { gt: cursor } } : {}) },
      orderBy: { shop: "asc" },
      take: 50,
    });
    if (!shops.length) return result;
    for (const { shop } of shops) {
      await renew();
      try {
        await refresh(shop);
        result.refreshed++;
      } catch {
        // A revoked installation or Shopify outage must not block other shops.
        result.failed++;
      }
      cursor = shop;
    }
  }
}

export async function runMerchantMaintenance(
  refresh = refreshInstalledMerchants,
) {
  const owner = randomUUID();
  const claimed = await prisma.$executeRaw`
    INSERT INTO "MaintenanceLease" ("key", "owner", "expiresAt")
    VALUES ('merchant-directory', ${owner}, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
    ON CONFLICT ("key") DO UPDATE SET "owner" = ${owner},
      "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
    WHERE "MaintenanceLease"."expiresAt" <= CURRENT_TIMESTAMP
  `;
  if (claimed !== 1) return null;
  let nextRunSeconds = 300;
  try {
    await prunePublicRateLimits();
    await pruneExpiredCustomerAccess();
    await pruneAccessLog();
    const result = await refresh(undefined, async () => {
      const renewed = await prisma.$executeRaw`
        UPDATE "MaintenanceLease" SET "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes'
        WHERE "key" = 'merchant-directory' AND "owner" = ${owner}
          AND "expiresAt" > CURRENT_TIMESTAMP
      `;
      if (renewed !== 1) throw new Error("Merchant maintenance lease expired.");
    });
    nextRunSeconds = result.failed ? 900 : 21600;
    return result;
  } finally {
    await prisma.$executeRaw`
      UPDATE "MaintenanceLease" SET "expiresAt" = CURRENT_TIMESTAMP + ${nextRunSeconds} * INTERVAL '1 second'
      WHERE "key" = 'merchant-directory' AND "owner" = ${owner}
    `;
  }
}

export function startMerchantMaintenance() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async () => {
    try {
      const result = await runMerchantMaintenance();
      if (result) console.info("Merchant directory refreshed", result);
    } catch {
      console.error("Merchant directory maintenance failed; it will retry.");
    } finally {
      if (!stopped) timer = setTimeout(tick, 60_000).unref();
    }
  };
  timer = setTimeout(tick, 10_000).unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}


// Shopify sends shop/update when a merchant changes their store's details,
// including its name. Without it a rename is invisible to store search until
// the next sweep, up to six hours later, or until the merchant opens the app.
// Errors are left to propagate so Shopify retries; the sweep is the backstop.
export async function shopUpdateWebhookAction(
  request: Request,
  authenticateWebhook: (request: Request) => Promise<{ shop: string; topic: string }>,
  refresh = refreshShop,
) {
  const { shop, topic } = await authenticateWebhook(request);
  if (topic === "SHOP_UPDATE") await refresh(shop);
  return new Response();
}
