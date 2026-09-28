import { Prisma } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { processWebhookOnce } from "../services/webhook-reconciliation.server";
import { WixApiError } from "../services/wix/wix-api.server";
import { createWixApi, wixAccessToken } from "../services/wix/wix-client.server";
import { recordWixRefundCompleted } from "../services/wix/wix-refund-events.server";
import { provisionWixSite, removeWixSite } from "../services/wix/wix-site.server";
import {
  WIX_APP_INSTALLED,
  WIX_APP_REMOVED,
  WIX_REFUND_COMPLETED,
  WixWebhookRejected,
  verifyWixWebhook,
  wixActionBody,
} from "../services/wix/wix-webhooks.server";

// Wix app webhooks. Set this route's URL for each event in the Wix app
// dashboard (Webhooks). The body is a JWT signed with the app's key; it is
// read raw and verified before anything else happens.
//
// Wix has no GDPR/customer data-deletion webhook for apps like Shopify's
// customers/redact (none in its SDK event catalog). Site-level deletion
// happens on AppRemoved; customer requests reach us through the site owner.
const MAX_BODY = 500_000;

async function recordReceipt(id: string, shop: string, topic: string) {
  try {
    await prisma.webhookReceipt.create({ data: { id, shop, topic } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
      throw error;
  }
}

const stillInstalled = (instanceId: string) =>
  wixAccessToken(instanceId, { fresh: true }).then(
    () => true,
    (error: unknown) => {
      if (error instanceof WixApiError && error.rejected) return false;
      throw error;
    },
  );

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
    return new Response("Payload too large", { status: 413 });

  const appId = process.env.WIX_APP_ID?.trim();
  const publicKey = process.env.WIX_WEBHOOK_PUBLIC_KEY?.trim();
  if (!appId || !process.env.WIX_APP_SECRET?.trim() || !publicKey)
    return new Response("Wix is not configured", { status: 503 });

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY)
    return new Response("Payload too large", { status: 413 });

  let event;
  try {
    event = await verifyWixWebhook(rawBody, { publicKey, appId });
  } catch (error) {
    if (error instanceof WixWebhookRejected)
      return new Response("Rejected", { status: 400 });
    throw error;
  }

  const seen = await prisma.webhookReceipt.findUnique({
    where: { id: event.id },
    select: { id: true },
  });
  if (seen) return Response.json({ duplicate: true });

  switch (event.eventType) {
    case WIX_APP_INSTALLED:
      // Calls Wix, so it runs outside a transaction. Idempotent: every write
      // is an upsert, and a failure (5xx) lets Wix retry.
      await provisionWixSite(event.instanceId, createWixApi(event.instanceId));
      await recordReceipt(event.id, event.shop, event.eventType);
      return Response.json({ installed: true });
    case WIX_APP_REMOVED:
      // A replayed removal must never delete a site that still has the app,
      // so Wix confirms first: it mints no token for a removed instance. An
      // unclear answer throws, and Wix retries.
      if (await stillInstalled(event.instanceId))
        return Response.json({ ignored: true });
      // No receipt: removal deletes the site's receipts too, and repeating a
      // removal is harmless.
      await removeWixSite(event.shop);
      return Response.json({ removed: true });
    case WIX_REFUND_COMPLETED:
      await processWebhookOnce({
        webhookId: event.id,
        shop: event.shop,
        topic: event.eventType,
        process: async (transaction) => {
          await recordWixRefundCompleted(transaction, event.shop, wixActionBody(event));
        },
      });
      return Response.json({ recorded: true });
    default:
      // Paid plan changes and anything else subscribed later: acknowledged
      // so Wix does not retry.
      return Response.json({ ignored: true });
  }
};

export const loader = () => new Response("Method not allowed", { status: 405 });
