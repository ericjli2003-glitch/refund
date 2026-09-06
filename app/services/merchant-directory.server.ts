import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { normalizeShopDomain } from "./customer-account.server";

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
      shop { myshopifyDomain name primaryDomain { host } }
    }
  `);
  const result = (await response.json()) as {
    data?: {
      shop: {
        myshopifyDomain: string;
        name: string;
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
  const data = { primaryDomain, name: info.name, verifiedAt: new Date() };
  return prisma.merchantDirectory.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
}

export async function resolveMerchant(value: string) {
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
