import { createHmac } from "node:crypto";
import prisma from "../db.server";

export type RatePolicy = { bucket: string; limit: number; seconds: number };

export async function consumePublicRateLimit(
  identity: string,
  policy: RatePolicy,
) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("Rate limiting is not configured.");
  const key = createHmac("sha256", secret)
    .update(`public-rate-limit:v1:${policy.bucket}:${identity}`)
    .digest("hex");
  // The database clock and atomic upsert are shared by every server replica.
  // Cap denied counters so repeated abuse cannot overflow the integer column.
  const [row] = await prisma.$queryRaw<
    Array<{ hits: number; retryAfter: number }>
  >`
    INSERT INTO "PublicRateLimit" ("key", "hits", "expiresAt")
    VALUES (${key}, 1, CURRENT_TIMESTAMP + ${policy.seconds} * INTERVAL '1 second')
    ON CONFLICT ("key") DO UPDATE SET
      "hits" = CASE WHEN "PublicRateLimit"."expiresAt" <= CURRENT_TIMESTAMP
        THEN 1 ELSE LEAST("PublicRateLimit"."hits" + 1, ${policy.limit + 1}) END,
      "expiresAt" = CASE WHEN "PublicRateLimit"."expiresAt" <= CURRENT_TIMESTAMP
        THEN CURRENT_TIMESTAMP + ${policy.seconds} * INTERVAL '1 second'
        ELSE "PublicRateLimit"."expiresAt" END
    RETURNING "hits", GREATEST(1, CEIL(EXTRACT(EPOCH FROM
      ("expiresAt" - CURRENT_TIMESTAMP))))::integer AS "retryAfter"
  `;
  if (!row) throw new Error("Rate limit storage is unavailable.");
  return { allowed: row.hits <= policy.limit, retryAfter: row.retryAfter };
}

export async function prunePublicRateLimits() {
  // Bound each sweep; active counters must never be removed.
  return prisma.$executeRaw`
    DELETE FROM "PublicRateLimit" WHERE "key" IN (
      SELECT "key" FROM "PublicRateLimit"
      WHERE "expiresAt" < CURRENT_TIMESTAMP - INTERVAL '1 hour'
      ORDER BY "expiresAt" LIMIT 10000
    )
  `;
}
