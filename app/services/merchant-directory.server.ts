import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { normalizeShopDomain } from "./customer-account.server";

export const normalizeMerchantName = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
export const merchantProfilePath = (shop: string) =>
  `/stores/${encodeURIComponent(shop)}`;

// Only published profiles with a current installation are searchable. Names are
// hints for navigation; they never authorize access to customer information.
export async function findPublishedMerchants(query = "") {
  const name = normalizeMerchantName(query);
  if (name.length > 120) return [];
  let domain: string | null = null;
  try {
    domain = merchantHost(query);
  } catch {
    /* A business name need not be a domain. */
  }
  const profiles = await prisma.merchantDirectory.findMany({
    where: {
      discoveryPublished: true,
      ...(name
        ? {
            OR: [
              { aliases: { has: name } },
              ...(domain ? [{ shop: domain }, { primaryDomain: domain }] : []),
            ],
          }
        : {}),
    },
    orderBy: { shop: "asc" },
    take: 100,
    select: {
      shop: true,
      name: true,
      primaryDomain: true,
      aliases: true,
      verifiedAt: true,
    },
  });
  if (!profiles.length) return [];
  const installed = await prisma.session.findMany({
    where: {
      shop: { in: profiles.map((profile) => profile.shop) },
      isOnline: false,
    },
    select: { shop: true },
  });
  const shops = new Set(installed.map((session) => session.shop));
  return profiles.filter((profile) => shops.has(profile.shop));
}

export function merchantHost(value: string) {
  const input = value.trim();
  if (!input || input.length > 2048 || /[\s\\]/.test(input))
    throw new Error("Enter the store's website address.");
  const url = new URL(input.includes("://") ? input : `https://${input}`);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      url.hostname,
    )
  )
    throw new Error("Enter a valid HTTPS store website address.");
  return url.hostname;
}

export async function syncMerchantDirectory(
  shop: string,
  admin: AdminApiContext,
) {
  const response = await admin.graphql(`#graphql
    query RefundMerchantDomain {
      shop { myshopifyDomain name currencyCode primaryDomain { host } }
    }
  `);
  const result = (await response.json()) as {
    data?: {
      shop: {
        myshopifyDomain: string;
        name: string;
        currencyCode: string;
        primaryDomain: { host: string };
      };
    };
    errors?: unknown[];
  };
  const info = result.data?.shop;
  if (
    !info ||
    result.errors?.length ||
    normalizeShopDomain(info.myshopifyDomain) !== shop
  )
    throw new Error("Could not verify the merchant's website with Shopify.");
  const primaryDomain = merchantHost(info.primaryDomain.host);
  const normalized = normalizeMerchantName(info.name);
  const aliases = [
    ...new Set([
      normalized,
      `${normalized} storefront`,
      ...(shop === "testing-bl7vdfur.myshopify.com"
        ? ["testing", "testing storefront"]
        : []),
    ]),
  ];
  const data = {
    primaryDomain,
    name: info.name,
    aliases,
    verifiedAt: new Date(),
  };
  const profile = await prisma.merchantDirectory.upsert({
    where: { shop },
    create: {
      shop,
      ...data,
      discoveryPublished: shop === "testing-bl7vdfur.myshopify.com",
    },
    update: data,
  });
  return { ...profile, currencyCode: info.currencyCode };
}

export async function provisionMerchant(shop: string, admin: AdminApiContext) {
  const merchant = await syncMerchantDirectory(shop, admin);
  if (!/^[A-Z]{3}$/.test(merchant.currencyCode || ""))
    throw new Error("Could not determine the store currency.");
  // Reauthentication/reinstallation must never overwrite a merchant's choices.
  await prisma.storePolicy.upsert({
    where: { shop },
    create: {
      shop,
      currencyCode: merchant.currencyCode,
      automaticRefundsEnabled: false,
    },
    update: {},
  });
  return merchant;
}

export async function resolveMerchant(value: string) {
  if (!value.trim() || value.length > 2048) return null;
  if (!/[:/\\.]/.test(value)) {
    const matches = await findPublishedMerchants(value);
    if (matches.length !== 1) return null;
    return resolveMerchant(matches[0].shop);
  }
  const host = merchantHost(value);
  const canonical = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host);
  const directory = await prisma.merchantDirectory.findUnique({
    where: canonical ? { shop: host } : { primaryDomain: host },
  });
  const shop = canonical ? normalizeShopDomain(host) : directory?.shop;
  if (
    !shop ||
    !(await prisma.session.findFirst({
      where: { shop, isOnline: false },
      select: { id: true },
    }))
  )
    return null;
  // Custom domains can change owners. Recheck against the installed shop, never
  // fetch a caller-supplied hostname or infer identity from a redirect/DNS record.
  if (!canonical) {
    const { unauthenticated } = await import("../shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    const current = await syncMerchantDirectory(shop, admin);
    if (current.primaryDomain !== host) return null;
    return { shop, name: current.name, domain: host };
  }
  return { shop, name: directory?.name || shop, domain: host };
}
