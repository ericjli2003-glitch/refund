import { Prisma } from "@prisma/client";

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

export class WixSiteNotInstalled extends Error {
  constructor() {
    super("Gooper.io is not installed on this Wix site.");
    this.name = "WixSiteNotInstalled";
  }
}

// What Wix says about the site now, checked against the store key.
async function readWixSite(shop: string, api: WixApi, now: Date) {
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
  return {
    instanceId,
    name,
    currencyCode,
    // Never includes discoveryPublished: the merchant's listing choice stays.
    directory: { primaryDomain, name, aliases, formerAliases, verifiedAt: now },
    installation: { permissions, siteName: name, siteUrl, currencyCode },
  };
}

type Directory = Awaited<ReturnType<typeof readWixSite>>["directory"];

const primaryDomainTaken = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  JSON.stringify(error.meta?.target ?? "").includes("primaryDomain");

// Writes the directory row. A custom domain can still be held by another
// store's row: a merchant who moved from Shopify to Wix with Gooper.io on
// both keeps the domain on the Shopify row until that store is uninstalled or
// resynced. primaryDomain is unique, so rather than failing (which would
// block install forever), the site is listed under its store key, as a free
// Wix address is: still found by name, never by that website. The next sync
// claims the domain once it is free. Returns the domain actually stored.
async function writeDirectory(
  write: (directory: Directory) => Promise<unknown>,
  directory: Directory,
  shop: string,
) {
  try {
    await write(directory);
    return directory.primaryDomain;
  } catch (error) {
    if (directory.primaryDomain === shop || !primaryDomainTaken(error)) throw error;
    await write({ ...directory, primaryDomain: shop });
    return shop;
  }
}

// Refreshes an installed site's details. Update-only: a sync racing with
// removeWixSite (the maintenance sweep, a custom-domain lookup) must never
// bring a removed site back, so it writes nothing once the installation row
// is gone and throws WixSiteNotInstalled. Only provisionWixSite creates rows.
export async function syncWixSite(shop: string, api: WixApi, now = new Date()) {
  const site = await readWixSite(shop, api, now);
  const { count } = await prisma.wixInstallation.updateMany({
    where: { instanceId: site.instanceId, shop },
    data: site.installation,
  });
  if (!count) throw new WixSiteNotInstalled();
  // If removal lands between these writes, this matches no row and writes
  // nothing. A missing row is left for provisioning to create.
  const primaryDomain = await writeDirectory(
    (directory) => prisma.merchantDirectory.updateMany({ where: { shop }, data: directory }),
    site.directory,
    shop,
  );
  return { name: site.name, primaryDomain, currencyCode: site.currencyCode };
}

// On install. Writes nothing until Wix confirms the instance with a token
// minted for it (a replayed install event for a removed site fails there).
// The installation is written on its own, before the directory, so nothing
// about the directory row can keep the site from being installed. A failure
// after it throws, and the install webhook's retry (every write here is an
// upsert) finishes the job.
export async function provisionWixSite(instanceId: string, api: WixApi, now = new Date()) {
  const shop = wixStoreKey(instanceId);
  const site = await readWixSite(shop, api, now);
  if (!site.currencyCode) throw new Error("Could not determine the store currency.");
  await prisma.wixInstallation.upsert({
    where: { instanceId: site.instanceId },
    create: { instanceId: site.instanceId, shop, ...site.installation },
    update: site.installation,
  });
  const primaryDomain = await writeDirectory(
    (directory) =>
      prisma.merchantDirectory.upsert({
        where: { shop },
        // New installations are listed by default; updates keep the
        // merchant's listing choice.
        create: { shop, ...directory },
        update: directory,
      }),
    site.directory,
    shop,
  );
  // Reinstalling must never overwrite a merchant's choices.
  await prisma.storePolicy.upsert({
    where: { shop },
    create: { shop, currencyCode: site.currencyCode, automaticRefundsEnabled: false },
    update: {},
  });
  return { shop, name: site.name, primaryDomain, currencyCode: site.currencyCode };
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
