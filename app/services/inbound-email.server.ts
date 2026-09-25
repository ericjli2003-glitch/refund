import { createHmac, timingSafeEqual } from "node:crypto";
import { escapeHtml, isEmailAddress } from "./email.server";

// Resend can receive mail at gooper.io but has no forwarding feature of its
// own: it POSTs an email.received webhook, and this service fetches the full
// message and re-sends a copy through Resend's own send API to a real inbox.

export class InboundWebhookRejected extends Error {}

const SIGNATURE_TOLERANCE_SECONDS = 300;

// Resend's webhooks are signed by Svix: HMAC-SHA256 over
// "{svix-id}.{svix-timestamp}.{body}", keyed by the base64-decoded secret
// (after stripping its "whsec_" prefix), base64-encoded, and carried as one
// or more "v1,<signature>" entries in svix-signature.
export function signInboundWebhookBody(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
) {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const digest = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${digest}`;
}

export function verifyInboundWebhookSignature(
  secret: string,
  rawBody: string,
  headers: Headers,
  now: Date,
) {
  const id = headers.get("svix-id");
  const timestampHeader = headers.get("svix-timestamp");
  const signatureHeader = headers.get("svix-signature");
  if (!id || !timestampHeader || !signatureHeader)
    throw new InboundWebhookRejected("Missing signature headers.");
  if (!/^\d{1,12}$/.test(timestampHeader))
    throw new InboundWebhookRejected("Malformed timestamp.");
  const timestamp = Number(timestampHeader);
  if (
    Math.abs(Math.floor(now.getTime() / 1000) - timestamp) >
    SIGNATURE_TOLERANCE_SECONDS
  )
    throw new InboundWebhookRejected(
      "Signature timestamp is outside tolerance.",
    );

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest();

  const matches = signatureHeader
    .split(" ")
    .filter(Boolean)
    .some((candidate) => {
      const [version, value] = candidate.split(",");
      if (version !== "v1" || !value) return false;
      let received: Buffer;
      try {
        received = Buffer.from(value, "base64");
      } catch {
        return false;
      }
      return (
        received.length === expected.length &&
        timingSafeEqual(expected, received)
      );
    });
  if (!matches) throw new InboundWebhookRejected("Signature does not match.");
}

export type ReceivedEmailEvent = { emailId: string };

// Returns null for any event type other than email.received, so the route
// can acknowledge and ignore it. Throws only when the body claims to be a
// received-email event but is malformed.
export function parseInboundEmailEvent(
  rawBody: string,
): ReceivedEmailEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new InboundWebhookRejected("Event body is not JSON.");
  }
  const event = value as { type?: unknown; data?: { email_id?: unknown } };
  if (event?.type !== "email.received") return null;
  const emailId = event.data?.email_id;
  if (typeof emailId !== "string" || emailId.length === 0)
    throw new InboundWebhookRejected("Received-email event has no email_id.");
  return { emailId };
}

export type ReceivedEmail = {
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  attachments: { filename: string }[];
};

export async function fetchReceivedEmail(
  emailId: string,
  apiKey: string,
): Promise<ReceivedEmail> {
  const response = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new Error("Gooper.io couldn't retrieve the received email.");
  const body = (await response.json()) as {
    from: string;
    to: string[];
    subject: string;
    html: string | null;
    text: string | null;
    attachments?: { filename: string }[];
  };
  return {
    from: body.from,
    to: body.to,
    subject: body.subject,
    html: body.html ?? null,
    text: body.text ?? null,
    attachments: body.attachments ?? [],
  };
}

// Builds the forwarded copy. Resend can only send from an address on a
// domain it has verified, so the visible From stays on that domain; the
// original sender goes in Reply-To (when it looks like a real address) and
// is quoted in the body so it is never lost.
export function buildForwardPayload(
  email: ReceivedEmail,
  forwardTo: string,
  fromDomain: string,
) {
  const receivedAt = email.to[0] ?? `support@${fromDomain}`;
  const fromLocalPart = receivedAt.split("@")[0] || "support";
  const from = `Gooper.io <${fromLocalPart}@${fromDomain}>`;
  const subject = `[Gooper.io] ${email.subject}`;
  const attachmentNote =
    email.attachments.length > 0
      ? `(${email.attachments.length} attachment(s) were not forwarded; view the original in the Resend dashboard.)`
      : "";

  const text = [
    `Forwarded from ${receivedAt}`,
    `Original sender: ${email.from}`,
    "",
    email.text ?? "(no plain-text body)",
    ...(attachmentNote ? ["", attachmentNote] : []),
  ].join("\n");

  const html = [
    `<p><em>Forwarded from ${escapeHtml(receivedAt)}<br />Original sender: ${escapeHtml(email.from)}</em></p>`,
    "<hr />",
    email.html ?? `<p>${escapeHtml(email.text ?? "(no body)")}</p>`,
    ...(attachmentNote ? [`<p><em>${escapeHtml(attachmentNote)}</em></p>`] : []),
  ].join("");

  return {
    from,
    to: [forwardTo],
    subject,
    text,
    html,
    ...(isEmailAddress(email.from) ? { reply_to: [email.from] } : {}),
  };
}

export async function sendForward(
  payload: ReturnType<typeof buildForwardPayload>,
  apiKey: string,
  idempotencyKey: string,
) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Gooper.io couldn't forward the email.");
}
