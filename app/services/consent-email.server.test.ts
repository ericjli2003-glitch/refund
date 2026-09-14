import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import prisma from "../db.server";
import { connectionEmailContext } from "./connection-email.server";
import {
  completeConsentTap,
  consentEmailState,
  consentTapCsrf,
  getConsentTap,
  moveConfirmedEmails,
  resendConsentCode,
  sendConsentCode,
  verifyConsentCode,
} from "./consent-email.server";
import { unseal } from "./customer-security.server";

const flow = { id: "request-1", clientId: "client" };
const connectionId = "0d9b7c1e-5a4f-4e2b-8c3d-1f6a7b8c9d0e";

function mockDelegate(
  t: TestContext,
  target: object,
  name: string,
  implementation: (...args: never[]) => unknown,
) {
  const original = Reflect.get(target, name);
  const mock = t.mock.fn(implementation);
  Reflect.set(target, name, mock);
  t.after(() => Reflect.set(target, name, original));
  return mock;
}

type Row = Record<string, unknown> & {
  id: string;
  status: string;
  attempts: number;
  matchNumber: number;
  createdAt: Date;
};
type Where = Record<string, unknown>;

function matches(row: Row, where: Where) {
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const rule = condition as { in?: unknown[]; gt?: Date };
      if (rule.in) return rule.in.includes(value);
      if (rule.gt) return value instanceof Date && value > rule.gt;
    }
    return value === condition;
  });
}

// An in-memory ConsentEmailCheck table with just the queries the service uses.
function checks(t: TestContext) {
  process.env.SHOPIFY_APP_URL = "https://refund.test";
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  const saved = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    REFUND_EMAIL_FROM: process.env.REFUND_EMAIL_FROM,
  };
  process.env.RESEND_API_KEY = "re_test";
  process.env.REFUND_EMAIL_FROM = "Refund <returns@refund.test>";
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const rows: Row[] = [];
  const table = prisma.consentEmailCheck;
  mockDelegate(t, table, "create", async ({ data }: { data: Where }) => {
    const row = { attempts: 0, status: "PENDING", createdAt: new Date(), ...data } as Row;
    rows.push(row);
    return row;
  });
  mockDelegate(t, table, "count", async ({ where }: { where: Where }) =>
    rows.filter((row) => matches(row, where)).length,
  );
  mockDelegate(t, table, "findFirst", async ({ where }: { where: Where }) =>
    [...rows].reverse().find((row) => matches(row, where)) ?? null,
  );
  mockDelegate(t, table, "findMany", async ({ where }: { where: Where }) =>
    rows.filter((row) => matches(row, where)),
  );
  mockDelegate(t, table, "findUnique", async ({ where }: { where: { id: string } }) => {
    const row = rows.find((entry) => entry.id === where.id);
    return row
      ? { ...row, request: { status: "PENDING", clientId: "client", expiresAt: new Date(Date.now() + 600_000) } }
      : null;
  });
  mockDelegate(t, table, "updateMany", async ({ where, data }: { where: Where; data: Where }) => {
    const hit = rows.filter((row) => matches(row, where));
    for (const row of hit) Object.assign(row, data);
    return { count: hit.length };
  });
  mockDelegate(t, table, "deleteMany", async ({ where }: { where: Where }) => {
    const before = rows.length;
    for (let index = rows.length - 1; index >= 0; index--)
      if (matches(rows[index], where)) rows.splice(index, 1);
    return { count: before - rows.length };
  });
  mockDelegate(t, prisma, "$transaction", async (operations: never) =>
    Promise.all(operations as unknown as Promise<unknown>[]),
  );
  mockDelegate(t, prisma.agentOAuthClient, "findUnique", async () => null);
  const sent: Array<{ to: string[]; subject: string; text: string; html: string }> = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "email" });
    },
  );
  return { rows, sent };
}

const codeFrom = (email: { subject: string }) => email.subject.slice(0, 6);
const tapTokenFrom = (email: { text: string }) =>
  email.text.match(/verify\/connect-email\/([\w-]{43})/)![1];

test("a code sent to the customer's shopping email confirms it on the approving page", async (t) => {
  const { sent } = checks(t);
  const now = Date.now();
  assert.deepEqual(await sendConsentCode(flow, " Pat@Example.com", now), {
    ok: true,
    message: "We sent a code to p••@example.com.",
  });
  assert.deepEqual(sent[0].to, ["pat@example.com"]);
  assert.match(sent[0].subject, /^\d{6} is your Refund code$/);
  assert.match(sent[0].text, /never for marketing/i);
  assert.match(sent[0].text, /https:\/\/refund\.test\/verify\/connect-email\/[\w-]{43}/);
  const [pending] = await consentEmailState(flow.id, now);
  assert.equal(pending.email, "p••@example.com");
  assert.equal(pending.confirmed, false);
  assert.ok(pending.matchNumber! >= 10 && pending.matchNumber! < 100);

  const code = codeFrom(sent[0]);
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  for (let left = 4; left >= 1; left--)
    assert.equal(
      (await verifyConsentCode(flow.id, pending.id, wrong, now)).message,
      `That code didn’t match. You have ${left} ${left === 1 ? "try" : "tries"} left.`,
    );
  assert.match((await verifyConsentCode(flow.id, pending.id, wrong, now)).message, /cancelled it/);
  // Even the right code no longer works once it's been guessed at five times.
  assert.equal((await verifyConsentCode(flow.id, pending.id, code, now)).ok, false);
  assert.deepEqual(await consentEmailState(flow.id, now), []);

  assert.equal((await sendConsentCode(flow, "pat@example.com", now)).ok, true);
  const [fresh] = await consentEmailState(flow.id, now);
  // A code is bound to its own authorization request, and so to its browser.
  assert.equal(
    (await verifyConsentCode("another-request", fresh.id, codeFrom(sent[1]), now)).ok,
    false,
  );
  assert.deepEqual(await verifyConsentCode(flow.id, fresh.id, codeFrom(sent[1]), now), {
    ok: true,
    message: "Email confirmed.",
  });
  assert.equal((await consentEmailState(flow.id, now))[0].confirmed, true);
  assert.deepEqual(await sendConsentCode(flow, "pat@example.com", now), {
    ok: true,
    message: "That email is already confirmed.",
  });
});

test("resending waits a moment, and codes to one address are capped", async (t) => {
  const { sent } = checks(t);
  const now = Date.now();
  await sendConsentCode(flow, "pat@example.com", now);
  const [pending] = await consentEmailState(flow.id, now);
  assert.match((await resendConsentCode(flow, pending.id, now + 5_000)).message, /just sent/);
  assert.equal((await resendConsentCode(flow, pending.id, now + 31_000)).ok, true);
  assert.equal(sent.length, 2);
  // The new code replaces the old one.
  assert.equal((await consentEmailState(flow.id, now + 31_000)).length, 1);
  for (const id of ["request-2", "request-3", "request-4"])
    assert.equal(
      (await sendConsentCode({ id, clientId: "client" }, "pat@example.com", now + 31_000)).ok,
      true,
    );
  assert.match(
    (await sendConsentCode({ id: "request-5", clientId: "client" }, "pat@example.com", now + 31_000))
      .message,
    /a few codes already/,
  );
  assert.equal(sent.length, 5);
  assert.equal((await sendConsentCode(flow, "not an email", now)).ok, false);
});

test("a tap on another device confirms only with the number shown on the page", async (t) => {
  const { rows, sent } = checks(t);
  const now = Date.now();
  await sendConsentCode(flow, "pat@example.com", now);
  const token = tapTokenFrom(sent[0]);
  const check = await getConsentTap(token);
  const tap = (value: string, choice: string, csrf: string) =>
    completeConsentTap(
      new Request(`https://refund.test/verify/connect-email/${value}`, {
        method: "POST",
        headers: {
          Origin: "https://refund.test",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf, choice }),
      }),
      value,
    );
  await assert.rejects(
    tap(token, String(check.matchNumber), "forged"),
    (error) => error instanceof Response && error.status === 403,
  );
  const wrong = check.matchNumber === 99 ? "98" : String(check.matchNumber + 1);
  assert.deepEqual(await tap(token, wrong, consentTapCsrf(check.id)), { outcome: "mismatch" });
  await assert.rejects(
    getConsentTap(token),
    (error) => error instanceof Response && error.status === 400,
  );

  await sendConsentCode(flow, "pat@example.com", now);
  const second = tapTokenFrom(sent[1]);
  const secondCheck = await getConsentTap(second);
  assert.deepEqual(
    await tap(second, String(secondCheck.matchNumber), consentTapCsrf(secondCheck.id)),
    { outcome: "confirmed" },
  );
  assert.equal(rows.find((row) => row.id === secondCheck.id)!.status, "CONFIRMED");
});

test("confirmed emails move to the new connection, and the codes are cleared", async (t) => {
  const { rows, sent } = checks(t);
  const now = Date.now();
  await sendConsentCode(flow, "pat@example.com", now);
  const [pending] = await consentEmailState(flow.id, now);
  await verifyConsentCode(flow.id, pending.id, codeFrom(sent[0]), now);
  await sendConsentCode(flow, "other@example.com", now);
  const upserts: Array<{ create: Record<string, unknown> }> = [];
  mockDelegate(t, prisma.connectionEmail, "upsert", async (args: never) => {
    upserts.push(args);
    return {};
  });
  assert.equal(await moveConfirmedEmails(prisma, flow.id, connectionId), 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].create.source, "ONBOARDING");
  assert.equal(
    unseal(upserts[0].create.sealedEmail as string, connectionEmailContext(connectionId)),
    "pat@example.com",
  );
  assert.equal(rows.length, 0);
});
