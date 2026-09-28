import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { pruneAccessLog } from "./access-log.server";
import { pruneExpiredCustomerAccess } from "./agent-access.server";
import { syncMerchantDirectory } from "./merchant-directory.server";
import { prunePublicRateLimits } from "./public-rate-limit.server";
import { isWixStore, storeInstallation, wixInstanceIdOf } from "./store-platform.server";

// One shop's directory row, brought back in line with Shopify. Shared by the
// six-hourly sweep and by the shop/update webhook.
export async function refreshShop(shop: string) {
  if (isWixStore(shop)) {
    const [
      { removeWixSite, syncWixSite },
      { wixAccessToken, wixApiFor, wixCredentialsProven, wixInstanceGone },
    ] = await Promise.all([
      import("./wix/wix-site.server"),
      import("./wix/wix-client.server"),
    ]);
    // Wix mints no token for a site that removed the app. The AppRemoved
    // webhook can miss that (lost, or Wix still minted a token when it
    // checked), so the sweep asks Wix afresh and cleans up what it no longer
    // has. Only "instance not found" (400/404) counts; refused credentials
    // or an outage throw and the site is retried next sweep.
    try {
      await wixAccessToken(wixInstanceIdOf(shop), { fresh: true });
    } catch (error) {
      // Only once another site's token has shown the app's credentials work:
      // a misconfigured app must never read as every site being gone.
      if (!wixInstanceGone(error) || !wixCredentialsProven()) throw error;
      await removeWixSite(shop);
      return;
    }
    await syncWixSite(shop, await wixApiFor(shop));
  } else {
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    await syncMerchantDirectory(shop, admin);
  }
  // If uninstall finished while the platform query was in flight, remove the
  // stale mapping. Publication still requires a current installation on every
  // lookup.
  if (!(await storeInstallation(shop)))
    await prisma.merchantDirectory.deleteMany({ where: { shop } });
}

export async function refreshInstalledMerchants(
  refresh = refreshShop,
  renew: () => Promise<void> = async () => {},
) {
  let cursor: string | undefined;
  const result = { refreshed: 0, failed: 0 };
  // Shopify stores first, then Wix sites, each in key order.
  let platform: "shopify" | "wix" = "shopify";
  for (;;) {
    const shops =
      platform === "shopify"
        ? await prisma.session.groupBy({
            by: ["shop"],
            where: { isOnline: false, ...(cursor ? { shop: { gt: cursor } } : {}) },
            orderBy: { shop: "asc" },
            take: 50,
          })
        : await prisma.wixInstallation.findMany({
            where: cursor ? { shop: { gt: cursor } } : {},
            orderBy: { shop: "asc" },
            take: 50,
            select: { shop: true },
          });
    if (!shops.length) {
      if (platform === "wix") return result;
      platform = "wix";
      cursor = undefined;
      continue;
    }
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
