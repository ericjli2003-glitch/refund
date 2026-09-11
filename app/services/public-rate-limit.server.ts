import { createHmac } from "node:crypto";
import prisma from "../db.server";

export type RatePolicy = { bucket: string; limit: number; seconds: number };

export function publicRateLimitKey(identity: string, bucket: string) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("Rate limiting is not configured.");
  return createHmac("sha256", secret)
    .update(`public-rate-limit:v1:${bucket}:${identity}`)
    .digest("hex");
}

export async function consumePublicRateLimit(
  identity: string,
  policy: RatePolicy,
) {
  const key = publicRateLimitKey(identity, policy.bucket);
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
    RETURNING "hits", LEAST(${policy.seconds}, GREATEST(1, CEIL(EXTRACT(EPOCH FROM
      ("expiresAt" - clock_timestamp())))))::integer AS "retryAfter"
  `;
  // Retry time uses the clock after lock acquisition, bounded to the configured
  // window so millisecond storage rounding cannot add a spurious extra second.
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
