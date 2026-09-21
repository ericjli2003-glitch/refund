import prisma from "../db.server";
import { customerIdentityHash } from "./customer-security.server";

// A log of who reached a customer's personal data, kept so an incident can be
// reconstructed. Rows hold a keyed identity hash and Shopify identifiers, never
// an email, name or order total.

// Who was behind the access.
export type AccessActor =
  // The customer reading or acting on their own data, already verified.
  | "CUSTOMER"
  // The merchant, signed into the embedded admin for their own shop.
  | "MERCHANT"
  // Scheduled or webhook-driven work with no human present.
  | "SYSTEM";

// Where the request came from.
export type AccessSource = "PORTAL" | "ASSISTANT" | "ADMIN" | "JOB";

export const ACCESS_LOG_RETENTION_DAYS = 365;

export function accessLogExpiry(now = new Date()) {
  return new Date(
    now.getTime() + ACCESS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

// The subject may be a Shopify customer GID or the keyed email subject used for
// store links. Both are hashed the same way records elsewhere are, so a
// redaction request matches these rows too.
export function accessSubjectHash(subject: string | null | undefined) {
  const value = subject?.trim();
  if (!value) return null;
  try {
    return customerIdentityHash(value);
  } catch {
    // Hashing needs configured secrets. Losing the identifier is better than
    // losing the row, so the access is still recorded without one.
    return null;
  }
}

export type AccessRecord = {
  shop: string;
  actor: AccessActor;
  source: AccessSource;
  // A stable verb naming what was reached, e.g. READ_CUSTOMER_ORDERS.
  action: string;
  // Pre-hashed, or a raw subject to hash. Use subject unless the caller
  // already holds the hash.
  subject?: string | null;
  subjectHash?: string | null;
  // Shopify GID of the order or return involved, when there is one.
  resource?: string | null;
  // How many records the access covered.
  recordCount?: number;
};

// Best effort by design. A customer's return must not fail because the audit
// write did, so this never throws into the request path. A write that fails is
// reported to the server log, where the gap is at least visible.
export async function recordAccess(record: AccessRecord) {
  try {
    await prisma.personalDataAccess.create({
      data: {
        shop: record.shop,
        actor: record.actor,
        source: record.source,
        action: record.action,
        customerSubjectHash:
          record.subjectHash ?? accessSubjectHash(record.subject),
        resource: record.resource ?? null,
        recordCount: record.recordCount ?? 0,
        expiresAt: accessLogExpiry(),
      },
    });
  } catch (error) {
    console.error(
      "Personal data access was not logged:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

// Redaction drops the identifier but keeps the row. The timeline of what was
// reached stays intact for security review, and nothing in it points at a
// person any more.
export async function redactAccessSubjects(subjectHashes: string[]) {
  if (!subjectHashes.length) return 0;
  const { count } = await prisma.personalDataAccess.updateMany({
    where: { customerSubjectHash: { in: subjectHashes } },
    data: { customerSubjectHash: null },
  });
  return count;
}

export async function pruneAccessLog(now = new Date()) {
  const { count } = await prisma.personalDataAccess.deleteMany({
    where: { expiresAt: { lte: now } },
  });
  return count;
}
