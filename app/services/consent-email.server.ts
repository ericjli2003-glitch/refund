import { randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { assistantName } from "./agent-access.server";
import { addConnectionEmail } from "./connection-email.server";
import {
  appOrigin,
  customerIdentityHash,
  digest,
  keyedDigest,
  privateHeaders,
  randomToken,
  safeEqual,
  seal,
  unseal,
} from "./customer-security.server";
import { maskEmail, normalizeEmail } from "./email-address.server";
import { escapeHtml, sendEmail } from "./email.server";
import { emailSubject } from "./verified-customer-returns.server";

const CODE_LIFETIME_MS = 15 * 60_000;
const RESEND_COOLDOWN_MS = 30_000;
const CODES_PER_REQUEST = 8;
const CODES_PER_ADDRESS_PER_HOUR = 5;
const MAX_CODE_ATTEMPTS = 5;
const OPAQUE_TOKEN = /^[\w-]{43}$/;

export const consentEmailContext = (id: string) => `consent-email:${id}`;
export const consentTapCsrf = (id: string) => keyedDigest("consent-email-tap", id);
const codeDigest = (id: string, code: string) =>
  keyedDigest("consent-email-code", `${id}:${code}`);

type Flow = { id: string; clientId: string };
type StepResult = { ok: boolean; message: string };
const ok = (message: string): StepResult => ({ ok: true, message });
const fail = (message: string): StepResult => ({ ok: false, message });

// What the consent page shows: confirmed emails and codes still waiting.
export async function consentEmailState(requestId: string, now = Date.now()) {
  const checks = await prisma.consentEmailCheck.findMany({
    where: { requestId, status: { in: ["PENDING", "CONFIRMED"] } },
    orderBy: { createdAt: "asc" },
  });
  return checks.flatMap((check) => {
    const confirmed = check.status === "CONFIRMED";
    if (!confirmed && check.expiresAt.getTime() <= now) return [];
    try {
      return [
        {
          id: check.id,
          email: maskEmail(unseal(check.sealedEmail, consentEmailContext(check.id))),
          confirmed,
          matchNumber: confirmed ? null : check.matchNumber,
        },
      ];
    } catch {
      return [];
    }
  });
}

export async function sendConsentCode(flow: Flow, input: string, now = Date.now()) {
  let email: string;
  try {
    email = normalizeEmail(input);
  } catch {
    return fail("That doesn’t look like an email address. Mind checking it?");
  }
  const emailHash = customerIdentityHash(emailSubject(email));
  const [forRequest, forAddress, latest] = await Promise.all([
    prisma.consentEmailCheck.count({ where: { requestId: flow.id } }),
    prisma.consentEmailCheck.count({
      where: { emailHash, createdAt: { gt: new Date(now - 3_600_000) } },
    }),
    prisma.consentEmailCheck.findFirst({
      where: { requestId: flow.id, emailHash, status: { in: ["PENDING", "CONFIRMED"] } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  if (latest?.status === "CONFIRMED") return ok("That email is already confirmed.");
  if (latest && now - latest.createdAt.getTime() < RESEND_COOLDOWN_MS)
    return fail("We just sent a code. Give it a moment to arrive, then you can send another.");
  if (forRequest >= CODES_PER_REQUEST || forAddress >= CODES_PER_ADDRESS_PER_HOUR)
    return fail(
      "We’ve sent a few codes already. Use the most recent one, or try again in a little while.",
    );
  const raw = randomToken();
  const id = digest(raw);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.$transaction([
    prisma.consentEmailCheck.updateMany({
      where: { requestId: flow.id, emailHash, status: "PENDING" },
      data: { status: "REPLACED" },
    }),
    prisma.consentEmailCheck.create({
      data: {
        id,
        requestId: flow.id,
        sealedEmail: seal(email, consentEmailContext(id)),
        emailHash,
        codeHash: codeDigest(id, code),
        matchNumber: randomInt(10, 100),
        expiresAt: new Date(now + CODE_LIFETIME_MS),
      },
    }),
  ]);
  const assistant = await assistantName(flow.clientId);
  const url = `${appOrigin()}/verify/connect-email/${raw}`;
  const privacy =
    "Refund uses this email only to find your orders at stores that use Refund. Never for marketing.";
  try {
    await sendEmail({
      to: email,
      subject: `${code} is your Refund code`,
      text: `Hi there,\n\nHere’s your code to finish connecting ${assistant} to Refund:\n\n${code}\n\nOn a different device? Tap the link below and choose the number shown on the Refund page:\n${url}\n\n${privacy}\n\nThe code works for 15 minutes. If you didn’t ask for this, just ignore this email.`,
      html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#16201c;max-width:520px;margin:0 auto;padding:24px"><p style="margin:0 0 16px">Hi there,</p><p style="margin:0 0 16px">Here’s your code to finish connecting ${escapeHtml(assistant)} to Refund:</p><p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px">${code}</p><p style="margin:0 0 12px">On a different device? Tap below and choose the number shown on the Refund page.</p><p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0a6b52;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">Confirm on this device</a></p><p style="margin:0 0 8px;color:#56635e;font-size:14px">${privacy}</p><p style="margin:0;color:#56635e;font-size:14px">The code works for 15 minutes. If you didn’t ask for this, just ignore this email.</p></div>`,
      idempotencyKey: id,
    });
  } catch {
    await prisma.consentEmailCheck.deleteMany({ where: { id } });
    return fail("We couldn’t send the email just now. Please try again in a moment.");
  }
  return ok(`We sent a code to ${maskEmail(email)}.`);
}

export async function resendConsentCode(flow: Flow, checkId: string, now = Date.now()) {
  const check = await prisma.consentEmailCheck.findFirst({
    where: { id: checkId, requestId: flow.id, status: "PENDING" },
  });
  if (!check) return fail("That code isn’t active any more. Enter your email again for a new one.");
  try {
    return await sendConsentCode(
      flow,
      unseal(check.sealedEmail, consentEmailContext(check.id)),
      now,
    );
  } catch {
    return fail("That code isn’t active any more. Enter your email again for a new one.");
  }
}

export async function verifyConsentCode(
  requestId: string,
  checkId: string,
  input: string,
  now = Date.now(),
) {
  const code = input.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return fail("Enter the 6-digit code from the email.");
  const check = await prisma.consentEmailCheck.findFirst({
    where: { id: checkId, requestId },
  });
  if (!check || check.status !== "PENDING" || check.expiresAt.getTime() <= now)
    return fail("That code has expired. Send a new one and we’ll get you sorted.");
  if (safeEqual(check.codeHash, codeDigest(check.id, code))) {
    const { count } = await prisma.consentEmailCheck.updateMany({
      where: { id: check.id, status: "PENDING" },
      data: { status: "CONFIRMED" },
    });
    return count === 1
      ? ok("Email confirmed.")
      : fail("That code has expired. Send a new one and we’ll get you sorted.");
  }
  // Counting attempts against the value just read stops parallel guessing.
  const attempts = check.attempts + 1;
  const cancelled = attempts >= MAX_CODE_ATTEMPTS;
  const { count } = await prisma.consentEmailCheck.updateMany({
    where: { id: check.id, status: "PENDING", attempts: check.attempts },
    data: { attempts, ...(cancelled ? { status: "CANCELLED" } : {}) },
  });
  if (count !== 1) return fail("Please try that code again.");
  const left = MAX_CODE_ATTEMPTS - attempts;
  return fail(
    cancelled
      ? "That code didn’t match, so we cancelled it to keep your orders safe. Send a new code to try again."
      : `That code didn’t match. You have ${left} ${left === 1 ? "try" : "tries"} left.`,
  );
}

export async function removeConsentEmail(requestId: string, checkId: string) {
  await prisma.consentEmailCheck.deleteMany({
    where: { id: checkId, requestId, status: { in: ["PENDING", "CONFIRMED"] } },
  });
  return ok("Removed.");
}

export async function getConsentTap(raw: string, now = Date.now()) {
  const invalid = new Response(
    "This link has expired or was already used. Send a new code from the Refund page.",
    { status: 400, headers: privateHeaders },
  );
  if (!OPAQUE_TOKEN.test(raw)) throw invalid;
  const check = await prisma.consentEmailCheck.findUnique({
    where: { id: digest(raw) },
    include: { request: true },
  });
  if (
    !check ||
    check.status !== "PENDING" ||
    check.expiresAt.getTime() <= now ||
    check.request.status !== "PENDING" ||
    check.request.expiresAt.getTime() <= now
  )
    throw invalid;
  return check;
}

// The one-tap button from the email, opened on any device. The number shown
// on the consent page must be picked, so a stranger's request can't be
// confirmed from the customer's inbox.
export async function completeConsentTap(request: Request, raw: string) {
  const check = await getConsentTap(raw);
  const forbidden = new Response("Invalid confirmation request.", {
    status: 403,
    headers: privateHeaders,
  });
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== appOrigin() ||
    request.headers.get("Content-Type")?.split(";")[0] !==
      "application/x-www-form-urlencoded"
  )
    throw forbidden;
  const text = await request.text();
  if (text.length > 4096) throw forbidden;
  const form = new URLSearchParams(text);
  const choice = form.get("choice") || "";
  if (
    form.getAll("csrf").length !== 1 ||
    !safeEqual(form.get("csrf") || "", consentTapCsrf(check.id)) ||
    form.getAll("choice").length !== 1 ||
    !/^(deny|\d{2})$/.test(choice)
  )
    throw forbidden;
  const matched = choice === String(check.matchNumber);
  const { count } = await prisma.consentEmailCheck.updateMany({
    where: { id: check.id, status: "PENDING" },
    data: { status: matched ? "CONFIRMED" : "CANCELLED" },
  });
  if (count !== 1)
    throw new Response("This link was already used.", {
      status: 409,
      headers: privateHeaders,
    });
  return {
    outcome: matched
      ? ("confirmed" as const)
      : choice === "deny"
        ? ("denied" as const)
        : ("mismatch" as const),
  };
}

// Confirmed emails become the new connection's, and the checks are cleared.
export async function moveConfirmedEmails(
  tx: Pick<Prisma.TransactionClient, "consentEmailCheck" | "connectionEmail">,
  requestId: string,
  connectionId: string,
) {
  const checks = await tx.consentEmailCheck.findMany({
    where: { requestId, status: "CONFIRMED" },
  });
  for (const check of checks)
    await addConnectionEmail(
      tx,
      connectionId,
      unseal(check.sealedEmail, consentEmailContext(check.id)),
      "ONBOARDING",
    );
  await tx.consentEmailCheck.deleteMany({ where: { requestId } });
  return checks.length;
}
