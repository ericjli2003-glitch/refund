import * as z from "zod/v4";
import { randomUUID } from "node:crypto";
import { appOrigin, seal, unseal } from "./customer-security.server";
import { resolveMerchant } from "./merchant-directory.server";

export const intakeSchema = z
  .object({
    merchant: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .describe(
        "Merchant website URL or domain. Ask for the website if only a store name is known.",
      ),
    orderName: z.string().trim().max(120).optional(),
    itemName: z.string().trim().max(120).optional(),
  })
  .strict();
const continuationSchema = z
  .object({
    version: z.literal(1),
    shop: z.string(),
    expiresAt: z.number(),
    orderName: z.string().max(120).optional(),
    itemName: z.string().max(120).optional(),
  })
  .strict();

export function makeContinuation(
  shop: string,
  hints: { orderName?: string; itemName?: string },
  now = Date.now(),
) {
  return seal(
    JSON.stringify({
      version: 1,
      shop,
      ...hints,
      expiresAt: now + 30 * 60_000,
    }),
    "return-intake:v1",
  );
}

export function readContinuation(
  token: string,
  shop: string,
  now = Date.now(),
) {
  try {
    if (token.length > 4096) throw new Error();
    const value = continuationSchema.parse(
      JSON.parse(unseal(token, "return-intake:v1")),
    );
    if (
      value.shop !== shop ||
      value.expiresAt <= now ||
      value.expiresAt > now + 30 * 60_000
    )
      throw new Error();
    return value;
  } catch {
    throw new Response(
      "This return link expired or is invalid. Start again from the store's return page.",
      { status: 400 },
    );
  }
}

// Hints only: possession of this link never establishes order ownership or consent.
export function returnHints(url: URL, shop: string) {
  const token = url.searchParams.get("continuation");
  if (token) return readContinuation(token, shop);
  return {
    orderName: url.searchParams.get("orderName")?.slice(0, 120) || undefined,
    itemName: url.searchParams.get("itemName")?.slice(0, 120) || undefined,
  };
}

export async function startReturnIntake(input: unknown) {
  const { merchant, orderName, itemName } = intakeSchema.parse(input);
  const correlationId = randomUUID();
  const store = await resolveMerchant(merchant);
  if (!store)
    return {
      status: "merchant_not_resolved" as const,
      correlationId,
      message:
        "Refund could not verify this store as connected. Check the website address or use the merchant's published return page. This does not establish whether the purchase is returnable.",
    };
  const continuation = makeContinuation(store.shop, { orderName, itemName });
  const url = new URL(`/returns/${store.shop}`, appOrigin());
  url.searchParams.set("continuation", continuation);
  return {
    status: "verification_required" as const,
    correlationId,
    merchant: store,
    continueUrl: url.href,
    expiresInSeconds: 1800,
    authenticationRequired: true,
    confirmationRequired: true,
    returnSubmitted: false,
    refundSubmitted: false,
    nextStep:
      "Open continueUrl in the browser. Ask the customer to complete Shopify verification themselves and keep passwords and sign-in codes on Shopify's page. When the portal returns, use get_return_session, find_returnable_items, and quote_return. Stop after showing the exact quote; do not submit unless the customer later gives explicit confirmation. If interrupted, reopen continueUrl and use get_return_session. Give support the correlationId, never credentials.",
  };
}
