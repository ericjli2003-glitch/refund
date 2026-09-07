import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// Never run this check against a merchant or production database.
const url = new URL(process.env.DATABASE_URL || "");
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.pathname !== "/refund_ci"
) {
  throw new Error(
    "Grant cascade test requires the isolated local refund_ci database.",
  );
}
const prisma = new PrismaClient();
const rollback = new Error("Roll back successful test fixtures");
try {
  await prisma.$transaction(async (tx) => {
    const sessionId = `ci-${randomUUID()}`;
    await tx.customerReturnSession.create({
      data: {
        id: sessionId,
        shop: "ci.myshopify.com",
        csrfToken: "test-only",
        customerSubjectHash: "test-subject",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await tx.agentAccessGrant.create({
      data: {
        tokenHash: `test-hash-${randomUUID()}`,
        sessionId,
        shop: "ci.myshopify.com",
        customerSubjectHash: "test-subject",
        clientId: "test-client",
        resource: "https://refund.test/mcp/ci.myshopify.com",
        scopes: ["returns:read"],
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    assert.equal(await tx.agentAccessGrant.count({ where: { sessionId } }), 1);
    await tx.customerReturnSession.delete({ where: { id: sessionId } });
    assert.equal(await tx.agentAccessGrant.count({ where: { sessionId } }), 0);
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
  console.log(
    "PASS: customer-session deletion cascades to assistant grants; fixtures rolled back.",
  );
} finally {
  await prisma.$disconnect();
}
