import { createHmac, timingSafeEqual } from "node:crypto";

import { wixStoreKey } from "../store-platform.server";

// Identifies the Wix site (and user) behind a request from Gooper.io's
// self-hosted dashboard page.
//
// Wix loads the page in an iframe with `?instance=<signature>.<data>`:
//   data      = base64url(JSON { instanceId, signDate, uid?, permissions?, siteOwnerId?, vendorProductId?, ... })
//   signature = base64url(HMAC-SHA256(key = app secret, message = the data part as received))
// both without padding. Source: Wix's "Parse the app instance query
// parameter" guide, confirmed only through search summaries (dev.wix.com was
// unreachable). UNVERIFIED: the exact field list; anything but instanceId and
// signDate is optional here. signDate is required: without it an instance
// would never expire, so a leaked dashboard URL would work forever.
//
// Wix's newer dashboard SDK instead hands the page an access token; see
// verifyWixDashboardToken below.

export class WixInstanceRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WixInstanceRejected";
  }
}

export type WixDashboardInstance = {
  instanceId: string;
  shop: string;
  // The Wix user viewing the dashboard.
  userId?: string;
  // The viewer's role on the site, e.g. "OWNER".
  permissions?: string;
  siteOwnerId?: string;
  // The app plan; empty when free.
  vendorProductId?: string;
  signDate: Date;
};

// A dashboard session starts from a freshly signed instance; the page should
// reload (Wix re-signs on every load) rather than live on a day-old one.
export const WIX_INSTANCE_MAX_AGE_MS = 24 * 3_600_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const optionalString = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

export function verifyWixDashboardInstance(
  value: string | null | undefined,
  {
    secret,
    now = new Date(),
    maxAgeMs = WIX_INSTANCE_MAX_AGE_MS,
  }: { secret: string; now?: Date; maxAgeMs?: number },
): WixDashboardInstance {
  if (!secret) throw new Error("Wix is not configured.");
  if (!value || value.length > 8192) throw new WixInstanceRejected("Missing Wix instance.");
  const parts = value.split(".");
  if (parts.length !== 2) throw new WixInstanceRejected("Malformed Wix instance.");
  const signature = parts[0].replace(/=+$/, "");
  const data = parts[1];
  if (!BASE64URL.test(signature) || !BASE64URL.test(data.replace(/=+$/, "")))
    throw new WixInstanceRejected("Malformed Wix instance.");

  const expected = createHmac("sha256", secret).update(data).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    throw new WixInstanceRejected("Invalid Wix instance signature.");

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new WixInstanceRejected("Malformed Wix instance.");
  }

  let shop: string;
  try {
    shop = wixStoreKey(String(payload.instanceId ?? ""));
  } catch {
    throw new WixInstanceRejected("Invalid Wix instance.");
  }

  if (typeof payload.signDate !== "string" || !payload.signDate)
    throw new WixInstanceRejected("Wix instance has no sign date.");
  const signDate = new Date(payload.signDate);
  const age = now.getTime() - signDate.getTime();
  if (Number.isNaN(age) || age > maxAgeMs || age < -CLOCK_SKEW_MS)
    throw new WixInstanceRejected("Expired Wix instance.");

  return {
    instanceId: shop.slice("wix-".length),
    shop,
    userId: optionalString(payload.uid),
    permissions: optionalString(payload.permissions),
    siteOwnerId: optionalString(payload.siteOwnerId),
    vendorProductId: optionalString(payload.vendorProductId),
    signDate,
  };
}

// The dashboard SDK route: the page sends the access token Wix gave it, and
// Wix's token-info endpoint says which app and instance it belongs to (what
// @wix/sdk's AppStrategy.elevated() does). Requires the token to be issued to
// this app. UNVERIFIED: the full token-info response; only clientId and
// instanceId are relied on, as the SDK does.
export async function verifyWixDashboardToken(
  token: string | null | undefined,
  { appId, fetch: doFetch = fetch }: { appId: string; fetch?: typeof fetch },
): Promise<Pick<WixDashboardInstance, "instanceId" | "shop">> {
  if (!appId) throw new Error("Wix is not configured.");
  const value = token?.replace(/^Bearer\s+/i, "").trim();
  if (!value || value.length > 8192) throw new WixInstanceRejected("Missing Wix access token.");
  const response = await doFetch("https://www.wixapis.com/oauth2/token-info", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token: value }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 400 && response.status < 500)
    throw new WixInstanceRejected("Invalid Wix access token.");
  if (!response.ok) throw new Error(`Wix token check failed with status ${response.status}.`);
  const info = (await response.json().catch(() => null)) as {
    clientId?: unknown;
    instanceId?: unknown;
  } | null;
  if (info?.clientId !== appId) throw new WixInstanceRejected("Token is for a different app.");
  let shop: string;
  try {
    shop = wixStoreKey(String(info.instanceId ?? ""));
  } catch {
    throw new WixInstanceRejected("Invalid Wix instance.");
  }
  return { instanceId: shop.slice("wix-".length), shop };
}
