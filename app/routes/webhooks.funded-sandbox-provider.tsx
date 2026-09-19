import type { ActionFunctionArgs } from "react-router";
import { requireFundedSandbox } from "../services/funded-return-sandbox.server";
import {
  fundedPaymentProvider,
  ingestProviderEvent,
} from "../services/funded-payment-intents.server";
import { ProviderEventRejected } from "../services/funded-payment-provider.server";

// Development-only callback endpoint for the fake funded-payment provider.
// Returns 404 outside the enabled sandbox. Authenticity comes from the event
// signature; the body is read raw so the signature covers exact bytes.
export const action = async ({ request }: ActionFunctionArgs) => {
  requireFundedSandbox();
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  // Refuse oversized bodies before reading them into memory.
  if (Number(request.headers.get("content-length") ?? 0) > 16_000)
    return new Response("Payload too large", { status: 413 });
  const rawBody = await request.text();
  if (rawBody.length > 16_000)
    return new Response("Payload too large", { status: 413 });
  try {
    const disposition = await ingestProviderEvent(
      fundedPaymentProvider(),
      rawBody,
      request.headers,
    );
    return Response.json({ disposition });
  } catch (error) {
    if (error instanceof ProviderEventRejected)
      return new Response("Rejected", { status: 400 });
    throw error;
  }
};

export const loader = () => {
  requireFundedSandbox();
  return new Response("Method not allowed", { status: 405 });
};
