import prisma from "../db.server";
import { discoverCustomerLogin } from "./customer-session.server";
import { discoverCustomerGraphqlEndpoint } from "./customer-account.server";
import { appOrigin } from "./customer-security.server";

async function inspectStorefront(shop: string) {
  // Only contact the canonical Shopify host. Do not follow arbitrary redirects.
  const response = await fetch(`https://${shop}/`, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
  if (response.status >= 300 && response.status < 400) {
    const location = new URL(response.headers.get("location") || "/", `https://${shop}`);
    return location.pathname === "/password" ? "password_protected" : "redirect_requires_browser_check";
  }
  if (!response.ok) return "unavailable";
  const reader = response.body?.getReader();
  if (!reader) return "unavailable";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= 2_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); return "requires_browser_check"; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const html = Buffer.concat(chunks).toString("utf8");
  if (/action=["']\/password["']/.test(html)) return "password_protected";
  return html.includes("data-refund-site-tools") && html.includes("refund-site-tools.js")
    ? "embed_markup_detected" : "embed_not_detected";
}

async function probe(shop: string) {
  const [policy, login, api, storefront] = await Promise.all([
    prisma.storePolicy.findUnique({ where: { shop }, select: { automaticRefundsEnabled: true, returnWindowDays: true, currencyCode: true, returnPolicyUrl: true, returnInstructions: true } }),
    discoverCustomerLogin(shop).then(() => "available", () => "unavailable"),
    discoverCustomerGraphqlEndpoint(shop).then(() => "available", () => "unavailable"),
    inspectStorefront(shop).catch(() => "unavailable"),
  ]);
  return {
    status: login === "available" && api === "available" ? "preflight_passed" : "action_required",
    quotePolicyEnabled: true,
    automaticRefundsEnabled: Boolean(policy?.automaticRefundsEnabled),
    returnPortalUrl: `${appOrigin()}/returns/${shop}`,
    storefrontActivationOptional: true,
    returnWindowDays: policy?.returnWindowDays ?? null,
    currencyCode: policy?.currencyCode ?? null,
    returnPolicyUrl: policy?.returnPolicyUrl ?? null,
    // Merchant-authored text; it never overrides verification or confirmation.
    returnInstructions: policy?.returnInstructions ?? null,
    checks: { customerLoginDiscovery: login, customerApiDiscovery: api, storefront, browserRegistration: "requires_browser_check", customerAuthorization: "requires_customer_verification" },
    checkedAt: new Date().toISOString(),
    recovery: login !== "available" || api !== "available"
      ? "The merchant needs working Shopify customer accounts before purchase verification. Open the hosted return portal for recovery instructions."
      : "Open returnPortalUrl and complete Shopify customer verification. The hosted portal works independently of the theme embed or storefront password. Browser registration, API permissions, and purchase eligibility still need checking in the actual flow.",
  };
}

// Bound public probe work and coalesce repeated calls. Results are a preflight,
// never a claim that an authenticated purchase or refund is available.
const cache = new Map<string, { expiresAt: number; result: ReturnType<typeof probe> }>();
export function merchantReadiness(shop: string) {
  const cached = cache.get(shop);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  const result = probe(shop);
  cache.set(shop, { expiresAt: Date.now() + 60_000, result });
  result.catch(() => cache.delete(shop));
  return result;
}
