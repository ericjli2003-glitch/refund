import type { ActionFunctionArgs } from "react-router";
import { isEmailAddress } from "../services/email.server";
import {
  InboundWebhookRejected,
  buildForwardPayload,
  fetchReceivedEmail,
  parseInboundEmailEvent,
  sendForward,
  verifyInboundWebhookSignature,
} from "../services/inbound-email.server";

// Resend has no forwarding feature of its own: it POSTs this webhook when it
// receives mail at gooper.io, and this route fetches the full message and
// re-sends a copy to a real inbox. The body is read raw so the signature
// covers exact bytes.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  // Refuse oversized bodies before reading them into memory. The webhook
  // payload is metadata only (attachment content is fetched separately).
  if (Number(request.headers.get("content-length") ?? 0) > 100_000)
    return new Response("Payload too large", { status: 413 });

  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  const apiKey = process.env.RESEND_API_KEY;
  const forwardTo = process.env.INBOUND_EMAIL_FORWARD_TO?.trim() ?? "";
  if (!secret || !apiKey || !isEmailAddress(forwardTo))
    return new Response("Inbound forwarding is not configured", {
      status: 503,
    });

  const rawBody = await request.text();
  if (rawBody.length > 100_000)
    return new Response("Payload too large", { status: 413 });

  try {
    verifyInboundWebhookSignature(
      secret,
      rawBody,
      request.headers,
      new Date(),
    );
    const event = parseInboundEmailEvent(rawBody);
    if (!event) return Response.json({ ignored: true });

    const email = await fetchReceivedEmail(event.emailId, apiKey);
    const payload = buildForwardPayload(email, forwardTo, "gooper.io");
    // Idempotency key ties to the received email, so a retried webhook
    // delivery can never forward the same message twice.
    await sendForward(payload, apiKey, event.emailId);
    return Response.json({ forwarded: true });
  } catch (error) {
    if (error instanceof InboundWebhookRejected)
      return new Response("Rejected", { status: 400 });
    throw error;
  }
};

export const loader = () => new Response("Method not allowed", { status: 405 });
