import { createHash } from "node:crypto";
import { importSPKI, jwtVerify, type CryptoKey } from "jose";

import { wixStoreKey } from "../store-platform.server";

// Wix POSTs each webhook as a bare JWT (the whole body), signed RS256 with the
// app's key pair; the public key is in the app dashboard under Webhooks. The
// payload nests JSON strings three deep:
//   jwt.payload.data   -> JSON string of the envelope
//   envelope           -> { eventType, instanceId, data: string, identity?: string, accountInfo? }
//   envelope.data      -> JSON string of the event body
// App lifecycle events (AppInstalled, AppRemoved, PaidPlan*) carry
// { appId, ... } as the body. Domain events (e.g. wix.ecom.v1.*) carry
// { id, entityId, eventTime, createdEvent | updatedEvent | deletedEvent | actionEvent }.
// Shape per @wix/sdk's webhook parser (eventHandlersModules.parseJWT).

export class WixWebhookRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WixWebhookRejected";
  }
}

export type WixWebhookIdentity = {
  identityType?: string;
  wixUserId?: string;
  memberId?: string;
  appId?: string;
  anonymousVisitorId?: string;
};

export type WixWebhookEvent = {
  // Stable ID for dedupe (WebhookReceipt.id): the domain event's own ID when it
  // has one, else a hash of the signed token.
  id: string;
  eventType: string;
  instanceId: string;
  shop: string;
  data: Record<string, unknown>;
  identity?: WixWebhookIdentity;
  accountInfo?: { accountId?: string; parentAccountId?: string; siteId?: string };
  issuedAt?: Date;
};

export const WIX_APP_INSTALLED = "AppInstalled";
export const WIX_APP_REMOVED = "AppRemoved";
export const WIX_REFUND_COMPLETED = "wix.ecom.v1.order_transactions_refund_completed";

// Wix retries failed deliveries for a while; how long is UNVERIFIED. A token
// older than this is treated as a replay. Duplicates inside the window are
// caught by the receipt table.
export const WIX_WEBHOOK_MAX_AGE_MS = 72 * 3_600_000;
const MAX_TOKEN_LENGTH = 1_000_000;

// The dashboard shows the key as PEM; it is sometimes pasted base64-encoded
// (one line), which @wix/sdk also accepts. Env files often hold "\n" escapes.
export function parseWixPublicKey(value: string) {
  const text = value.trim().replace(/\\n/g, "\n");
  if (text.includes("-----BEGIN")) return text;
  return Buffer.from(text, "base64").toString("utf8").trim();
}

const keys = new Map<string, Promise<CryptoKey>>();
function publicKey(pem: string) {
  let key = keys.get(pem);
  if (!key) {
    key = importSPKI(parseWixPublicKey(pem), "RS256");
    key.catch(() => keys.delete(pem));
    keys.set(pem, key);
  }
  return key;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseJsonObject(value: unknown, what: string) {
  if (typeof value !== "string") throw new WixWebhookRejected(`Missing ${what}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WixWebhookRejected(`Malformed ${what}.`);
  }
  if (!isRecord(parsed)) throw new WixWebhookRejected(`Malformed ${what}.`);
  return parsed;
}

const optionalString = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

export async function verifyWixWebhook(
  rawBody: string,
  {
    publicKey: pem,
    appId,
    now = new Date(),
  }: { publicKey: string; appId: string; now?: Date },
): Promise<WixWebhookEvent> {
  const token = rawBody.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || token.split(".").length !== 3)
    throw new WixWebhookRejected("Not a Wix webhook token.");

  // Imported outside the try: a key that fails to import is our
  // misconfiguration (a 500), not a bad request.
  const key = await publicKey(pem);
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ["RS256"],
      currentDate: now,
    }));
  } catch {
    throw new WixWebhookRejected("Invalid Wix webhook signature.");
  }
  // Replay window, when Wix stamps the token (it normally does).
  // UNVERIFIED: Wix's retry schedule.
  let issuedAt: Date | undefined;
  if (typeof payload.iat === "number") {
    issuedAt = new Date(payload.iat * 1000);
    const age = now.getTime() - issuedAt.getTime();
    if (age > WIX_WEBHOOK_MAX_AGE_MS || age < -5 * 60_000)
      throw new WixWebhookRejected("Stale Wix webhook.");
  }

  const envelope = parseJsonObject(payload.data, "webhook envelope");
  const eventType = envelope.eventType;
  if (typeof eventType !== "string" || !eventType || eventType.length > 150)
    throw new WixWebhookRejected("Missing event type.");
  if (typeof envelope.instanceId !== "string")
    throw new WixWebhookRejected("Missing app instance.");
  let shop: string;
  try {
    shop = wixStoreKey(envelope.instanceId);
  } catch {
    throw new WixWebhookRejected("Invalid app instance.");
  }
  const data = parseJsonObject(envelope.data, "event data");
  // Lifecycle events name the app. The key is per app already, so this only
  // catches a key shared across apps or a misrouted delivery.
  const lifecycle = eventType === WIX_APP_INSTALLED || eventType === WIX_APP_REMOVED;
  if ((lifecycle || "appId" in data) && data.appId !== appId)
    throw new WixWebhookRejected("Webhook is for a different app.");

  let identity: WixWebhookIdentity | undefined;
  if (envelope.identity !== undefined && envelope.identity !== null) {
    const parsed = parseJsonObject(envelope.identity, "webhook identity");
    identity = {
      identityType: optionalString(parsed.identityType),
      wixUserId: optionalString(parsed.wixUserId),
      memberId: optionalString(parsed.memberId),
      appId: optionalString(parsed.appId),
      anonymousVisitorId: optionalString(parsed.anonymousVisitorId),
    };
  }
  const account = isRecord(envelope.accountInfo) ? envelope.accountInfo : undefined;

  // Domain events carry their own ID, the same across redeliveries. App events
  // do not (AppInstalled's body is identical on every reinstall), so the token
  // itself identifies the delivery.
  const eventId = optionalString(data.id);
  const id =
    eventId && eventId.length <= 200
      ? `wix:${eventId}`
      : `wix-jwt:${createHash("sha256").update(token).digest("hex")}`;

  return {
    id,
    eventType,
    instanceId: shop.slice("wix-".length),
    shop,
    data,
    identity,
    accountInfo: account && {
      accountId: optionalString(account.accountId),
      parentAccountId: optionalString(account.parentAccountId),
      siteId: optionalString(account.siteId),
    },
    issuedAt,
  };
}

// The body of a domain action event (e.g. refund completed).
export function wixActionBody(event: WixWebhookEvent) {
  const action = event.data.actionEvent;
  return isRecord(action) && isRecord(action.body) ? action.body : null;
}
