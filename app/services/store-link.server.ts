import { createCookie } from "react-router";
import prisma from "../db.server";
import { CONNECTION_LIFETIME_MS } from "./agent-access.server";
import {
  appOrigin,
  digest,
  privateHeaders,
  randomToken,
  safeEqual,
} from "./customer-security.server";
import { resolveMerchant } from "./merchant-directory.server";

// Identifies the browser that approved an all-stores connection. A store link
// completes only in that browser, so a link someone else sends can't attach
// the customer's store sign-in to that sender's assistant connection.
export const connectionBrowserCookie = createCookie("__Host-refund_connection", {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: CONNECTION_LIFETIME_MS / 1000,
});

const LINK_REQUEST_LIFETIME_MS = 20 * 60_000;
const OPAQUE_TOKEN = /^[\w-]{43}$/;

export async function readConnectionBrowser(request: Request) {
  const raw: unknown = await connectionBrowserCookie.parse(
    request.headers.get("Cookie"),
  );
  return typeof raw === "string" && OPAQUE_TOKEN.test(raw) ? raw : null;
}

export async function startStoreLink(
  connectionId: string,
  merchant: string,
  now = Date.now(),
) {
  const store = await resolveMerchant(merchant);
  if (!store)
    return {
      status: "merchant_not_resolved" as const,
      linkUrl: null,
      nextStep:
        "The store couldn't be uniquely identified. Use find_store with the store's name or website and ask the customer which store they bought from. Never pick one for them.",
    };
  const existing = await prisma.agentStoreLink.findUnique({
    where: { connectionId_shop: { connectionId, shop: store.shop } },
    include: { session: { select: { expiresAt: true } } },
  });
  if (existing && existing.session.expiresAt.getTime() > now)
    return {
      status: "already_linked" as const,
      merchant: store,
      linkUrl: null,
      expiresAt: existing.session.expiresAt.toISOString(),
      nextStep: `This connection can already use ${store.shop}. Pass it as the shop argument.`,
    };
  const raw = randomToken();
  await prisma.agentStoreLinkRequest.deleteMany({
    where: { expiresAt: { lt: new Date(now) } },
  });
  await prisma.agentStoreLinkRequest.create({
    data: {
      id: digest(raw),
      connectionId,
      shop: store.shop,
      csrfToken: randomToken(),
      expiresAt: new Date(now + LINK_REQUEST_LIFETIME_MS),
    },
  });
  return {
    status: "sign_in_required" as const,
    merchant: store,
    linkUrl: `${appOrigin()}/connect/stores/link/${raw}`,
    expiresInSeconds: LINK_REQUEST_LIFETIME_MS / 1000,
    nextStep: `Give the customer linkUrl. They sign in to ${store.name} on Shopify's page and approve the link, in the same browser they used to connect Refund. Never ask for sign-in codes in chat. Afterwards, retry with shop "${store.shop}".`,
  };
}

export async function getStoreLinkRequest(
  request: Request,
  raw: string,
  now = Date.now(),
) {
  const invalid = (message: string) =>
    new Response(message, { status: 400, headers: privateHeaders });
  if (!OPAQUE_TOKEN.test(raw))
    throw invalid("This store link is invalid. Ask your assistant for a new one.");
  const [link, browser] = await Promise.all([
    prisma.agentStoreLinkRequest.findUnique({
      where: { id: digest(raw) },
      include: { connection: true },
    }),
    readConnectionBrowser(request),
  ]);
  if (
    !link ||
    link.status !== "PENDING" ||
    link.expiresAt.getTime() <= now ||
    link.connection.revokedAt ||
    link.connection.expiresAt.getTime() <= now
  )
    throw invalid(
      "This store link expired or was already used. Ask your assistant for a new one.",
    );
  if (!browser || !safeEqual(link.connection.browserHash, digest(browser)))
    throw invalid(
      "Open this link in the browser where you approved Refund in your assistant. If that isn't possible, remove Refund from your assistant and connect it again.",
    );
  return link;
}

export async function completeStoreLink(
  request: Request,
  raw: string,
  session: { id: string; shop: string } | null,
) {
  const link = await getStoreLinkRequest(request, raw);
  const forbidden = () =>
    new Response("Invalid store link request.", {
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
  if (text.length > 8192)
    throw new Response("Store link request too large.", {
      status: 413,
      headers: privateHeaders,
    });
  const form = new URLSearchParams(text);
  const decision = form.get("decision");
  if (
    form.getAll("csrf").length !== 1 ||
    !safeEqual(form.get("csrf") || "", link.csrfToken) ||
    form.getAll("decision").length !== 1 ||
    !["allow", "deny"].includes(decision || "")
  )
    throw forbidden();
  if (decision === "allow" && (!session || session.shop !== link.shop))
    throw new Response("Sign in to this store before linking it.", {
      status: 401,
      headers: privateHeaders,
    });
  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.agentStoreLinkRequest.updateMany({
      where: { id: link.id, status: "PENDING", expiresAt: { gt: new Date() } },
      data: { status: decision === "allow" ? "LINKED" : "DENIED" },
    });
    // Relinking replaces the store's expired session with the fresh one.
    if (result.count === 1 && decision === "allow")
      await tx.agentStoreLink.upsert({
        where: {
          connectionId_shop: { connectionId: link.connectionId, shop: link.shop },
        },
        create: {
          connectionId: link.connectionId,
          shop: link.shop,
          sessionId: session!.id,
        },
        update: { sessionId: session!.id, createdAt: new Date() },
      });
    return result.count;
  });
  if (claimed !== 1)
    throw new Response("This store link was already used.", {
      status: 409,
      headers: privateHeaders,
    });
  return { linked: decision === "allow", shop: link.shop };
}
