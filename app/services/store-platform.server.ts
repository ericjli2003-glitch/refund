import prisma from "../db.server";
import { normalizeShopDomain } from "./customer-account.server";

// Gooper.io serves stores on more than one commerce platform. Every table keys a
// store by `shop`: a Shopify store by its myshopify.com domain, a Wix site by
// "wix-<instanceId>". The Wix form has no dot, so it can never be mistaken for
// a domain, and a lowercase UUID keeps it safe in URLs.
export type StorePlatform = "shopify" | "wix";

const WIX_STORE =
  /^wix-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isWixStore = (shop: string) => WIX_STORE.test(shop);

export const platformOf = (shop: string): StorePlatform =>
  isWixStore(shop) ? "wix" : "shopify";

export function wixStoreKey(instanceId: string) {
  const shop = `wix-${instanceId.trim().toLowerCase()}`;
  if (!isWixStore(shop)) throw new Error("Invalid Wix app instance ID.");
  return shop;
}

export function wixInstanceIdOf(shop: string) {
  if (!isWixStore(shop)) throw new Error("Not a Wix store.");
  return shop.slice("wix-".length);
}

// A store key from any platform, or the same error normalizeShopDomain throws.
export function normalizeStoreKey(value: string) {
  const shop = value.trim().toLowerCase();
  return isWixStore(shop) ? shop : normalizeShopDomain(shop);
}

// Wix permissions stand in for Shopify access scopes wherever shared code asks
// whether a store granted one (hasScope). Only scopes shared code checks are
// mapped.
export const WIX_SCOPE_EQUIVALENTS: Record<string, string[]> = {
  read_products: ["SCOPE.DC-STORES.READ-PRODUCTS", "SCOPE.DC-STORES.MANAGE-PRODUCTS"],
};

export function wixScopeString(permissions: string[]) {
  const granted = new Set(permissions.map((permission) => permission.toUpperCase()));
  return Object.entries(WIX_SCOPE_EQUIVALENTS)
    .filter(([, names]) => names.some((name) => granted.has(name)))
    .map(([scope]) => scope)
    .join(",");
}

export type StoreInstallation = { platform: StorePlatform; scope: string | null };

// Whether the store currently has Gooper.io installed, and the scopes it granted.
export async function storeInstallation(
  shop: string,
): Promise<StoreInstallation | null> {
  if (isWixStore(shop)) {
    const install = await prisma.wixInstallation.findUnique({
      where: { shop },
      select: { permissions: true },
    });
    return install
      ? { platform: "wix", scope: wixScopeString(install.permissions) }
      : null;
  }
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    select: { id: true, scope: true },
  });
  return session ? { platform: "shopify", scope: session.scope } : null;
}

// Installed stores among `shops`, with their granted scopes.
export async function installedStores(shops: string[]) {
  const wix = shops.filter(isWixStore);
  const shopify = shops.filter((shop) => !isWixStore(shop));
  const [sessions, installs] = await Promise.all([
    shopify.length
      ? prisma.session.findMany({
          where: { shop: { in: shopify }, isOnline: false },
          select: { shop: true, scope: true },
        })
      : [],
    wix.length
      ? prisma.wixInstallation.findMany({
          where: { shop: { in: wix } },
          select: { shop: true, permissions: true },
        })
      : [],
  ]);
  const installed = new Map<string, string | null>();
  for (const session of sessions) installed.set(session.shop, session.scope);
  for (const install of installs)
    installed.set(install.shop, wixScopeString(install.permissions));
  return installed;
}
