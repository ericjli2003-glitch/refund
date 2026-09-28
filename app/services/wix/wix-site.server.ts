import prisma from "../../db.server";
import {
  merchantHost,
  mergeFormerAliases,
  normalizeMerchantName,
} from "../merchant-directory.server";
import { isWixStore, wixInstanceIdOf, wixStoreKey } from "../store-platform.server";
import type { WixApi } from "./wix-api.server";
import { forgetWixAccessToken } from "./wix-client.server";

// GET /apps/v1/instance (App Instance API), called as the app for one site.
// Needs the "Manage Your App" scope, which Wix grants every app.
type WixAppInstanceResponse = {
  instance?: { instanceId?: unknown; permissions?: unknown };
  site?: {
    siteDisplayName?: unknown;
    // Only present once the site is published.
    url?: unknown;
    // ISO-4217. UNVERIFIED that Wix Stores always prices in this currency:
    // Wix documents it as the site's payment currency. Refund math uses each
    // order's own currency, so this only seeds StorePolicy.currencyCode.
    paymentCurrency?: unknown;
  };
};

// Free Wix addresses put many sites on one host (user.wixsite.com/site-a,
// user.wixsite.com/site-b), so the host alone does not identify a site.
const SHARED_WIX_HOSTS = /(?:^|\.)(?:wixsite\.com|wixstudio\.io|wixstudio\.com|editorx\.io|wix\.com)$/;

export function wixSiteHost(url: unknown) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    return merchantHost(url);
  } catch {
    return null;
  }
}

export const isSharedWixHost = (host: string) => SHARED_WIX_HOSTS.test(host);

const stringOr = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export async function syncWixSite(shop: string, api: WixApi, now = new Date()) {
  const response = await api<WixAppInstanceResponse>("GET", "/apps/v1/instance");
  const instanceId = stringOr(response?.instance?.instanceId)?.toLowerCase();
  if (!instanceId || instanceId !== wixInstanceIdOf(shop))
    throw new Error("Could not verify the site with Wix.");
  const site = response.site ?? {};
  const host = wixSiteHost(site.url);
  const siteUrl = host ? (site.url as string).trim() : null;
  // MerchantDirectory.primaryDomain is unique and is how a customer's
  // "gooper, return my order from shop.example" finds the store. A custom
  // domain belongs to one site, so it is used as is. A free Wix address shares
  // its host with every other site of that Wix user (and a site with no
  // published URL has none), so the store key stands in: it is unique, can
  // never collide with a real hostname (no dot), and simply never matches a
  // website lookup. Such stores are found by name.
  const primaryDomain = host && !isSharedWixHost(host) ? host : shop;
  const name = stringOr(site.siteDisplayName) ?? (host && !isSharedWixHost(host) ? host : null);
  if (!name) throw new Error("Could not read the site's name from Wix.");
  const currency = stringOr(site.paymentCurrency)?.toUpperCase() ?? null;
  const currencyCode = currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
  const permissions = Array.isArray(response.instance?.permissions)
    ? response.instance.permissions.filter(
        (permission): permission is string => typeof permission === "string",
      )
    : [];

  const normalized = normalizeMerchantName(name);
  // Aliases come only from the name Wix reports, as for Shopify stores.
  const current = [...new Set([normalized, `${normalized} storefront`])];
  const stored = await prisma.merchantDirectory.findUnique({
    where: { shop },
    select: { aliases: true, formerAliases: true },
  });
  const { aliases, formerAliases } = mergeFormerAliases(
    current,
    stored?.aliases ?? [],
    stored?.formerAliases,
    now,
  );
  const directory = { primaryDomain, name, aliases, formerAliases, verifiedAt: now };
  const installation = { permissions, siteName: name, siteUrl, currencyCode };
  await prisma.$transaction([
    prisma.wixInstallation.upsert({
      where: { instanceId },
      create: { instanceId, shop, ...installation },
      update: installation,
    }),
    prisma.merchantDirectory.upsert({
      where: { shop },
      // New installations are listed by default; updates keep the merchant's
      // listing choice.
      create: { shop, ...directory },
      update: directory,
    }),
  ]);
  return { name, primaryDomain, currencyCode };
}

// On install. Writes nothing until Wix confirms the instance with a token
// minted for it (a replayed install event for a removed site fails there).
export async function provisionWixSite(instanceId: string, api: WixApi) {
  const shop = wixStoreKey(instanceId);
  const merchant = await syncWixSite(shop, api);
  if (!merchant.currencyCode) throw new Error("Could not determine the store currency.");
  // Reinstalling must never overwrite a merchant's choices.
  await prisma.storePolicy.upsert({
    where: { shop },
    create: { shop, currencyCode: merchant.currencyCode, automaticRefundsEnabled: false },
    update: {},
  });
  return { shop, ...merchant };
}

// On removal: the same tables the Shopify uninstall webhook clears, with the
// Wix installation in place of the Shopify session. Idempotent.
export async function removeWixSite(shop: string) {
  if (!isWixStore(shop)) throw new Error("Not a Wix store.");
  await prisma.$transaction([
    prisma.merchantOpportunity.deleteMany({ where: { knownShop: shop } }),
    prisma.merchantDirectory.deleteMany({ where: { shop } }),
    prisma.agentStoreLinkRequest.deleteMany({ where: { shop } }),
    prisma.agentStoreLink.deleteMany({ where: { shop } }),
    prisma.emailVerification.deleteMany({ where: { shop } }),
    // Emails confirmed in a chat about this store; setup emails are the
    // customer's own and stay with their connection.
    prisma.connectionEmail.deleteMany({ where: { sourceShop: shop } }),
    prisma.customerReturnSession.deleteMany({ where: { shop } }),
    prisma.returnDraft.deleteMany({ where: { shop } }),
    prisma.agentOAuthRequest.deleteMany({ where: { shop } }),
    prisma.agentReturn.deleteMany({ where: { shop } }),
    prisma.fundedReturnSandbox.deleteMany({ where: { shop } }),
    prisma.fundedPaymentEvent.deleteMany({ where: { shop } }),
    prisma.fundedPaymentIntent.deleteMany({ where: { shop } }),
    prisma.fundedSandboxProviderPayment.deleteMany({ where: { shop } }),
    prisma.fundedEntitlement.deleteMany({ where: { shop } }),
    prisma.privacyRequest.deleteMany({ where: { shop } }),
    prisma.webhookReceipt.deleteMany({ where: { shop } }),
    prisma.storePolicy.deleteMany({ where: { shop } }),
    prisma.wixInstallation.deleteMany({ where: { shop } }),
  ]);
  forgetWixAccessToken(wixInstanceIdOf(shop));
}
