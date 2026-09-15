import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { hashCustomerId } from "./return-guards.server";

export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

// Gooper.io's own key material, independent of the Shopify app secret, so rotating
// either one never orphans data sealed or hashed with the other. The first
// secret writes; retired secrets are listed only so existing sealed values,
// signed quotes and customer identity hashes can still be read and matched.
export function refundSecrets() {
  const primary = process.env.REFUND_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!primary) throw new Error("Customer authentication is not configured.");
  const previous = (process.env.REFUND_PREVIOUS_SECRETS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([primary, ...previous])];
}

function key(purpose: string, secret: string) {
  return createHmac("sha256", secret).update(`refund:${purpose}:v1`).digest();
}

// Index 0 is the hash new records use; the rest match records written before
// a secret rotation.
export function customerIdentityHashes(customerId: string) {
  return refundSecrets().map((secret) => hashCustomerId(customerId, secret));
}

export const customerIdentityHash = (customerId: string) =>
  customerIdentityHashes(customerId)[0];

// A keyed digest for short secrets, like a 6-digit code, that a plain hash
// would expose to brute force if the table ever leaked.
export const keyedDigest = (purpose: string, value: string) =>
  createHmac("sha256", key(purpose, refundSecrets()[0]))
    .update(value)
    .digest("base64url");

export function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function seal(value: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    key("customer-session", refundSecrets()[0]),
    iv,
  );
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

// `current` is false when a retired secret was needed, so a durable record can
// be re-sealed rather than depending on that secret indefinitely.
export function unsealWithRotation(value: string, context: string) {
  const [iv, tag, encrypted] = value
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const secrets = refundSecrets();
  for (const [index, secret] of secrets.entries()) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key("customer-session", secret),
        iv,
      );
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(tag);
      return {
        value: Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]).toString("utf8"),
        current: index === 0,
      };
    } catch {
      // A wrong key fails GCM authentication; try the next configured secret.
    }
  }
  throw new Error("Sealed value could not be opened.");
}

export const unseal = (value: string, context: string) =>
  unsealWithRotation(value, context).value;

export function signQuote(payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key("return-quote", refundSecrets()[0])).update(body).digest("base64url")}`;
}

export function verifyQuoteSignature(token: string): unknown {
  if (token.length > 32_000) throw new Error("Invalid return quote.");
  const [body, signature, extra] = token.split(".");
  if (
    !body ||
    !signature ||
    extra ||
    !refundSecrets().some((secret) =>
      safeEqual(
        signature,
        createHmac("sha256", key("return-quote", secret))
          .update(body)
          .digest("base64url"),
      ),
    )
  ) {
    throw new Error("Invalid return quote. Request a new quote.");
  }
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

export function appOrigin() {
  const url = new URL(process.env.SHOPIFY_APP_URL || "");
  if (url.protocol !== "https:")
    throw new Error("The customer portal requires HTTPS.");
  return url.origin;
}

export function verifyPortalPost(request: Request, csrfToken: string) {
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== appOrigin() ||
    !safeEqual(request.headers.get("X-Return-CSRF") || "", csrfToken) ||
    !request.headers.get("Content-Type")?.startsWith("application/json")
  ) {
    throw new Response("Invalid customer request.", { status: 403 });
  }
}

export const privateHeaders = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
