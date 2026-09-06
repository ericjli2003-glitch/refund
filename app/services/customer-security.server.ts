import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64url");

function key(purpose: string) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("Customer authentication is not configured.");
  return createHmac("sha256", secret).update(`refund:${purpose}:v1`).digest();
}

export function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function seal(value: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("customer-session"), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function unseal(value: string, context: string) {
  const [iv, tag, encrypted] = value
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key("customer-session"), iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

export function signQuote(payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", key("return-quote")).update(body).digest("base64url")}`;
}

export function verifyQuoteSignature(token: string): unknown {
  if (token.length > 32_000) throw new Error("Invalid return quote.");
  const [body, signature, extra] = token.split(".");
  if (
    !body ||
    !signature ||
    extra ||
    !safeEqual(
      signature,
      createHmac("sha256", key("return-quote"))
        .update(body)
        .digest("base64url"),
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
