import { randomInt } from "node:crypto";
import * as z from "zod/v4";
import prisma from "../db.server";
import {
  assistantName,
  storeLinkAccess,
  storeLinkEmailContext,
} from "./agent-access.server";
import {
  appOrigin,
  customerIdentityHash,
  digest,
  privateHeaders,
  randomToken,
  safeEqual,
  seal,
  unseal,
} from "./customer-security.server";
import { emailConfigured, escapeHtml, sendEmail } from "./email.server";
import { resolveMerchant } from "./merchant-directory.server";
import { adminData, adminFor, type AdminGraphql } from "./shopify-admin.server";
import { startStoreLink } from "./store-link.server";
import {
  emailSubject,
  verifiedLinksAllowed,
} from "./verified-customer-returns.server";

const VERIFICATION_LIFETIME_MS = 20 * 60_000;
const EMAILS_PER_CONNECTION_PER_HOUR = 10;
const EMAILS_PER_ADDRESS_PER_HOUR = 3;
const OPAQUE_TOKEN = /^[\w-]{43}$/;

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    /["\\\s]/.test(email) ||
    !z.email().safeParse(email).success
  )
    throw new Error("That doesn't look like an email address.");
  return email;
}

export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.min(Math.max(local.length - 1, 2), 5))}@${domain}`;
}

export const verificationEmailContext = (id: string) => `email-verification:${id}`;

// Three numbers to choose from, including the one shown in the customer's
// chat. Someone who starts a link with another person's email can't see it.
export function numberChoices(matchNumber: number) {
  const choices = new Set([matchNumber]);
  while (choices.size < 3) choices.add(randomInt(10, 100));
  return [...choices].sort((left, right) => left - right);
}

const ORDERS_BY_EMAIL = `#graphql
  query OrdersForEmailCheck($query: String!) {
    orders(first: 5, query: $query) { nodes { id email } }
  }
`;

async function hasOrdersForEmail(shop: string, email: string, admin?: AdminGraphql) {
  const client = admin ?? (await adminFor(shop));
  const { orders } = await adminData<{
    orders: { nodes: Array<{ id: string; email: string | null }> };
  }>(client, ORDERS_BY_EMAIL, { query: `email:"${email}"` }, "Shopify could not look up orders.");
  return orders.nodes.some((order) => order.email?.toLowerCase() === email);
}

function button(url: string, label: string) {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;background:#0a6b52;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">${escapeHtml(label)}</a>`;
}

function emailLayout(paragraphs: string[], action?: string) {
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#16201c;max-width:520px;margin:0 auto;padding:24px">${paragraphs
    .map((text) => `<p style="margin:0 0 16px">${text}</p>`)
    .join("")}${action ? `<p style="margin:24px 0">${action}</p>` : ""}</div>`;
}

type Store = { shop: string; name: string };

// Sends the one-tap confirmation. An address with no order at the store gets a
// short "we couldn't find an order" note instead, and the chat hears the same
// thing either way, so nobody can use Refund to learn who shops where.
export async function startEmailVerification(
  connectionId: string,
  store: Store,
  email: string,
  now = Date.now(),
  admin?: AdminGraphql,
) {
  const since = new Date(now - 3_600_000);
  const emailHash = customerIdentityHash(emailSubject(email));
  const [byConnection, byAddress, connection] = await Promise.all([
    prisma.emailVerification.count({
      where: { connectionId, createdAt: { gt: since } },
    }),
    prisma.emailVerification.count({
      where: { shop: store.shop, emailHash, createdAt: { gt: since } },
    }),
    prisma.agentConnection.findUnique({
      where: { id: connectionId },
      select: { clientId: true },
    }),
  ]);
  if (
    byConnection >= EMAILS_PER_CONNECTION_PER_HOUR ||
    byAddress >= EMAILS_PER_ADDRESS_PER_HOUR
  )
    return {
      status: "try_again_later" as const,
      merchant: store,
      linkUrl: null,
      nextStep:
        "Refund has sent a few confirmation emails already. Let the customer know kindly that the most recent email still works for 20 minutes, or that they can try again in about an hour.",
    };
  let hasOrders: boolean;
  try {
    hasOrders = await hasOrdersForEmail(store.shop, email, admin);
  } catch {
    // This store can't look orders up by email yet; use Shopify sign-in.
    return null;
  }
  const raw = randomToken();
  const id = digest(raw);
  const matchNumber = randomInt(10, 100);
  await prisma.emailVerification.create({
    data: {
      id,
      connectionId,
      shop: store.shop,
      sealedEmail: seal(email, verificationEmailContext(id)),
      emailHash,
      matchNumber,
      csrfToken: randomToken(),
      status: hasOrders ? "PENDING" : "NO_ORDERS",
      expiresAt: new Date(now + VERIFICATION_LIFETIME_MS),
    },
  });
  const assistant = connection ? await assistantName(connection.clientId) : "your assistant";
  const storeName = escapeHtml(store.name);
  const assistantHtml = escapeHtml(assistant);
  const url = `${appOrigin()}/verify/email/${raw}`;
  try {
    await sendEmail(
      hasOrders
        ? {
            to: email,
            subject: `Confirm your return with ${store.name}`,
            text: `Hi there,\n\nYou asked ${assistant} to help with a return from ${store.name}. Tap the link below to confirm it's you. You'll pick the number ${assistant} is showing you.\n\nYes, that's me: ${url}\n\nThe link works for 20 minutes. If you didn't ask for this, just ignore this email and nothing will happen.\n\nRefund, returns for ${store.name}`,
            html: emailLayout(
              [
                "Hi there,",
                `You asked ${assistantHtml} to help with a return from <strong>${storeName}</strong>. Tap below to confirm it’s you. You’ll pick the number ${assistantHtml} is showing you.`,
                `<span style="color:#56635e;font-size:14px">The link works for 20 minutes. If you didn’t ask for this, just ignore this email and nothing will happen.</span>`,
              ],
              button(url, "Yes, that’s me"),
            ),
            idempotencyKey: id,
          }
        : {
            to: email,
            subject: `About your return with ${store.name}`,
            text: `Hi there,\n\nYou asked ${assistant} to help with a return from ${store.name}, but we couldn't find an order there for this email address. If you checked out with a different email, just give that one to ${assistant}.\n\nIf you didn't ask for this, you can ignore this email.\n\nRefund, returns for ${store.name}`,
            html: emailLayout([
              "Hi there,",
              `You asked ${assistantHtml} to help with a return from <strong>${storeName}</strong>, but we couldn’t find an order there for this email address. If you checked out with a different email, just give that one to ${assistantHtml}.`,
              `<span style="color:#56635e;font-size:14px">If you didn’t ask for this, you can ignore this email.</span>`,
            ]),
            idempotencyKey: id,
          },
    );
  } catch {
    await prisma.emailVerification.deleteMany({ where: { id } });
    return null;
  }
  return {
    status: "email_sent" as const,
    merchant: store,
    linkUrl: null,
    sentTo: maskEmail(email),
    matchNumber,
    expiresInSeconds: VERIFICATION_LIFETIME_MS / 1000,
    nextStep: `Let the customer know, warmly, that an email from Refund is on its way to ${maskEmail(email)}. They tap "Yes, that's me" and pick the number ${matchNumber}, so tell them that number. When they say they're done, continue with shop "${store.shop}". If nothing arrives in a couple of minutes, they may have used a different email at checkout.`,
  };
}

// link_store: already linked, the email confirmation, or a Shopify sign-in
// link when this store can't use email confirmation.
export async function linkStore(
  connectionId: string,
  merchant: string,
  email?: string,
  now = Date.now(),
  admin?: AdminGraphql,
) {
  const store = await resolveMerchant(merchant);
  if (!store) return startStoreLink(connectionId, merchant, now);
  const [existing, policy, installed] = await Promise.all([
    prisma.agentStoreLink.findUnique({
      where: { connectionId_shop: { connectionId, shop: store.shop } },
      include: { session: true },
    }),
    prisma.storePolicy.findUnique({ where: { shop: store.shop } }),
    prisma.session.findFirst({
      where: { shop: store.shop, isOnline: false },
      select: { scope: true },
    }),
  ]);
  if (existing && storeLinkAccess(existing, policy, installed?.scope, now))
    return startStoreLink(connectionId, store.shop, now);
  // Email-confirmed links always use the store's confirmed Refund return rules.
  const emailReady = emailConfigured() && verifiedLinksAllowed(policy, installed?.scope);
  if (emailReady && email) {
    let address: string;
    try {
      address = normalizeEmail(email);
    } catch {
      return {
        status: "invalid_email" as const,
        merchant: store,
        linkUrl: null,
        nextStep:
          "That email doesn't look quite right. Ask the customer, kindly, to double-check it.",
      };
    }
    const sent = await startEmailVerification(connectionId, store, address, now, admin);
    if (sent) return sent;
  }
  const link = await startStoreLink(connectionId, store.shop, now);
  if (emailReady && !email && link.status === "sign_in_required")
    return {
      status: "email_needed" as const,
      merchant: store,
      linkUrl: null,
      signedInShortcutUrl: link.linkUrl,
      nextStep: `Ask the customer, in one short friendly question, which email they used for their ${store.name} order. Then call link_store again with that email, and Refund will send a one-tap confirmation, no sign-in needed. If they'd rather not share it, offer signedInShortcutUrl instead, which finishes instantly if they're already signed in to ${store.name}.`,
    };
  return link;
}

export async function getEmailVerification(raw: string, now = Date.now()) {
  const invalid = (message: string) =>
    new Response(message, { status: 400, headers: privateHeaders });
  if (!OPAQUE_TOKEN.test(raw))
    throw invalid("This confirmation link isn't valid. Ask your assistant to send a new one.");
  const check = await prisma.emailVerification.findUnique({
    where: { id: digest(raw) },
    include: { connection: true },
  });
  if (
    !check ||
    check.status !== "PENDING" ||
    check.expiresAt.getTime() <= now ||
    check.connection.revokedAt ||
    check.connection.expiresAt.getTime() <= now
  )
    throw invalid(
      "This confirmation link has expired or was already used. Ask your assistant to send a new one.",
    );
  return check;
}

export async function completeEmailVerification(request: Request, raw: string) {
  const check = await getEmailVerification(raw);
  const forbidden = () =>
    new Response("Invalid confirmation request.", {
      status: 403,
      headers: privateHeaders,
    });
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== appOrigin() ||
    request.headers.get("Content-Type")?.split(";")[0] !==
      "application/x-www-form-urlencoded"
  )
    throw forbidden();
  const text = await request.text();
  if (text.length > 4096) throw forbidden();
  const form = new URLSearchParams(text);
  const choice = form.get("choice") || "";
  if (
    form.getAll("csrf").length !== 1 ||
    !safeEqual(form.get("csrf") || "", check.csrfToken) ||
    form.getAll("choice").length !== 1 ||
    !/^(deny|\d{2})$/.test(choice)
  )
    throw forbidden();
  // A wrong number cancels the request, so it can't be guessed.
  const matched = choice === String(check.matchNumber);
  const email = matched
    ? unseal(check.sealedEmail, verificationEmailContext(check.id))
    : null;
  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.emailVerification.updateMany({
      where: { id: check.id, status: "PENDING", expiresAt: { gt: new Date() } },
      data: { status: matched ? "VERIFIED" : "CANCELLED" },
    });
    if (result.count === 1 && email) {
      const linkData = {
        verifiedBy: "EMAIL",
        customerSubjectHash: check.emailHash,
        sealedEmail: seal(email, storeLinkEmailContext(check.connectionId, check.shop)),
        sealedCustomerId: null,
        sessionId: null,
        lastUsedAt: new Date(),
      };
      await tx.agentStoreLink.upsert({
        where: {
          connectionId_shop: { connectionId: check.connectionId, shop: check.shop },
        },
        create: { connectionId: check.connectionId, shop: check.shop, ...linkData },
        update: { ...linkData, createdAt: new Date() },
      });
    }
    return result.count;
  });
  if (claimed !== 1)
    throw new Response("This confirmation link was already used.", {
      status: 409,
      headers: privateHeaders,
    });
  return {
    outcome: matched
      ? ("linked" as const)
      : choice === "deny"
        ? ("denied" as const)
        : ("mismatch" as const),
    shop: check.shop,
  };
}
