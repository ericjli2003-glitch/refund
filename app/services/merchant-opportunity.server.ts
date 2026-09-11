import * as z from "zod/v4";
import prisma from "../db.server";
import { digest } from "./customer-security.server";
import {
  merchantHost,
  normalizeMerchantName,
} from "./merchant-directory.server";

// Only a business label/domain is accepted. Never save a URL path/query, email,
// conversation, order hint, product, customer identifier, IP address, or token.
export function opportunityLabel(value: string) {
  const input = value.normalize("NFKC").trim();
  if (!input || input.length > 2048 || /[@\p{Cc}\p{Cf}]/u.test(input))
    return null;
  if (/[:/\\.]/.test(input)) {
    try {
      return merchantHost(input);
    } catch {
      return null;
    }
  }
  const label = input.replace(/\s+/g, " ");
  return label.length <= 120 &&
    /\p{L}/u.test(label) &&
    /^[\p{L}\p{M}\p{N} &'’()-]+$/u.test(label)
    ? label
    : null;
}
export const discoveryFailureSchema = z
  .object({
    merchant: z
      .string()
      .min(1)
      .max(2048)
      .refine(
        (value) => opportunityLabel(value) !== null,
        "Provide only a merchant name or HTTPS domain.",
      ),
  })
  .strict();

export const stoppedDiscovery = {
  status: "stopped" as const,
  returnSubmitted: false,
  refundSubmitted: false,
  nextStep:
    "Stop here. Do not start a return, look up purchases, request a quote, substitute another store or item, or contact the merchant. Do not ask for a URL as a fallback. Nothing has been submitted.",
};

// Process-local abuse budget; no customer identifiers or IP addresses are kept.
// Public reports remain unverified, even when they mention an installed store.
let windowStart = 0;
let writes = 0;
export async function recordMerchantOpportunity(
  merchant: string,
  source: "intake" | "lookup" | "discovery_report",
  now = new Date(),
) {
  const merchantLabel = opportunityLabel(merchant);
  if (!merchantLabel) return false;
  if (now.getTime() - windowStart >= 60_000) {
    windowStart = now.getTime();
    writes = 0;
  }
  if (writes >= 30)
    throw new Response(
      "Discovery reporting is temporarily unavailable. Stop without submitting a return.",
      { status: 429 },
    );
  writes++;
  const profiles = await prisma.merchantDirectory.findMany({
    where: {
      discoveryPublished: true,
      OR: [
        { shop: merchantLabel },
        { primaryDomain: merchantLabel },
        { aliases: { has: normalizeMerchantName(merchantLabel) } },
      ],
    },
    select: { shop: true },
    take: 100,
  });
  const sessions = profiles.length
    ? await prisma.session.findMany({
        where: {
          shop: { in: profiles.map((profile) => profile.shop) },
          isOnline: false,
        },
        select: { shop: true },
      })
    : [];
  const installed = [...new Set(sessions.map((session) => session.shop))];
  const knownShop = installed.length === 1 ? installed[0] : null;
  const kind = knownShop
    ? "DISCOVERY_GAP"
    : installed.length > 1
      ? "AMBIGUOUS_MATCH"
      : "UNRESOLVED_MERCHANT";
  const id = digest(
    `opportunity:v1:${normalizeMerchantName(merchantLabel)}:${now.toISOString().slice(0, 10)}`,
  );
  await prisma.merchantOpportunity.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  await prisma.merchantOpportunity.upsert({
    where: { id },
    create: {
      id,
      merchantLabel,
      knownShop,
      kind,
      source,
      firstSeenAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 90 * 86_400_000),
    },
    update: { lastSeenAt: now, knownShop, kind },
  });
  return true;
}

export async function noteUnresolvedMerchant(
  merchant: string,
  source: "intake" | "lookup",
  correlationId: string,
) {
  try {
    await recordMerchantOpportunity(merchant, source);
  } catch {
    console.warn("merchant_opportunity_record_failed", { correlationId });
  }
  // A diagnostics outage can never turn a failed lookup into a return flow.
}
