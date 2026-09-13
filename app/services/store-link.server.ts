import { createCookie } from "react-router";
import prisma from "../db.server";
import {
  CONNECTION_IDLE_MS,
  storeLinkAccess,
  storeLinkCustomerContext,
} from "./agent-access.server";
import { verifyCustomerAccess } from "./customer-account.server";
import {
  appOrigin,
  customerIdentityHash,
  customerIdentityHashes,
  digest,
  privateHeaders,
  randomToken,
  safeEqual,
  seal,
} from "./customer-security.server";
import { resolveMerchant } from "./merchant-directory.server";
import { verifiedLinksAllowed } from "./verified-customer-returns.server";

// Identifies the browser that approved an all-stores connection. A store link
// completes only in that browser, so a link someone else sends can't attach
// the customer's store sign-in to that sender's assistant connection.
export const connectionBrowserCookie = createCookie("__Host-refund_connection", {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: CONNECTION_IDLE_MS / 1000,
});

const LINK_REQUEST_LIFETIME_MS = 20 * 60_000;
// Unfinished link requests a connection can hold at once.
const PENDING_LINK_REQUEST_LIMIT = 10;
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
    return {
      status: "already_linked" as const,
      merchant: store,
      linkUrl: null,
      staysLinkedWithoutSignIn: Boolean(
        (existing.sealedCustomerId || existing.sealedEmail) &&
          verifiedLinksAllowed(policy, installed?.scope),
      ),
      nextStep: `Good news: ${store.name} is already connected, so carry on with shop "${store.shop}" without asking the customer to do anything.`,
    };
  const pending = await prisma.agentStoreLinkRequest.count({
    where: { connectionId, status: "PENDING", expiresAt: { gt: new Date(now) } },
  });
  if (pending >= PENDING_LINK_REQUEST_LIMIT)
    return {
      status: "too_many_link_requests" as const,
      merchant: store,
      linkUrl: null,
      nextStep:
        "This connection has several unfinished store links. Ask the customer to finish one, or wait up to 20 minutes for them to expire, before starting another.",
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
    nextStep: `Share linkUrl in a friendly way, like "Tap here to connect ${store.name}, it only takes a moment." It opens in the browser they used to connect Refund and finishes instantly if they're already signed in to ${store.name}. Never ask for sign-in codes in chat. When they're back, carry on with shop "${store.shop}".`,
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
  session: {
    id: string;
    shop: string;
    customerToken: string;
    customerSubjectHash: string | null;
  } | null,
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
  const signInFirst = (message: string) =>
    new Response(message, { status: 401, headers: privateHeaders });
  let linkData: {
    customerSubjectHash: string;
    sealedCustomerId: string;
    sessionId: string;
    lastUsedAt: Date;
  } | null = null;
  if (decision === "allow") {
    if (!session || session.shop !== link.shop || !session.customerSubjectHash)
      throw signInFirst("Sign in to this store before linking it.");
    // Record who the customer proved to be, so the link can keep working after
    // this Shopify session ends where the store allows it.
    const customerId = await verifyCustomerAccess(
      link.shop,
      session.customerToken,
    ).catch(() => null);
    if (
      !customerId ||
      !customerIdentityHashes(customerId).includes(session.customerSubjectHash)
    )
      throw signInFirst("Sign in to this store again before linking it.");
    linkData = {
      customerSubjectHash: customerIdentityHash(customerId),
      sealedCustomerId: seal(
        customerId,
        storeLinkCustomerContext(link.connectionId, link.shop),
      ),
      sessionId: session.id,
      lastUsedAt: new Date(),
    };
  }
  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.agentStoreLinkRequest.updateMany({
      where: { id: link.id, status: "PENDING", expiresAt: { gt: new Date() } },
      data: { status: linkData ? "LINKED" : "DENIED" },
    });
    // Relinking replaces the store's earlier sign-in and customer.
    if (result.count === 1 && linkData)
      await tx.agentStoreLink.upsert({
        where: {
          connectionId_shop: { connectionId: link.connectionId, shop: link.shop },
        },
        create: { connectionId: link.connectionId, shop: link.shop, ...linkData },
        update: { ...linkData, createdAt: new Date() },
      });
    return result.count;
  });
  if (claimed !== 1)
    throw new Response("This store link was already used.", {
      status: 409,
      headers: privateHeaders,
    });
  return { linked: Boolean(linkData), shop: link.shop };
}
