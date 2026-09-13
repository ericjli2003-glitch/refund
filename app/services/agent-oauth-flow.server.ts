import { randomUUID } from "node:crypto";
import { createCookie, redirect } from "react-router";
import prisma from "../db.server";
import {
  CONNECTION_IDLE_MS,
  agentResource,
  agentScopes,
} from "./agent-access.server";
import {
  appOrigin,
  digest,
  privateHeaders,
  randomToken,
  safeEqual,
  unseal,
} from "./customer-security.server";
import { normalizeShopDomain } from "./customer-account.server";
import {
  connectionBrowserCookie,
  readConnectionBrowser,
} from "./store-link.server";

export const agentFlowCookie = createCookie("__Host-refund_agent_flow", {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 1200,
});

export function shopFromAgentResource(value: URL | undefined) {
  if (
    !value ||
    value.origin !== appOrigin() ||
    value.search ||
    value.hash ||
    value.username ||
    value.password
  )
    throw new Error(
      "Use this merchant's exact Refund MCP URL as the resource.",
    );
  const shop = normalizeShopDomain(value.pathname.replace(/^\/mcp\//, ""));
  if (agentResource(shop) !== value.href)
    throw new Error("Invalid Refund resource.");
  return shop;
}

// First rollout: hosted ChatGPT and Claude only, not arbitrary sites or loopback.
// Names supplied in registration are never treated as proof of client identity.
export function assistantForRedirect(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error("Unsupported assistant callback.");
  if (url.hostname === "claude.ai" && url.pathname === "/api/mcp/auth_callback")
    return "Claude";
  if (
    url.hostname === "chatgpt.com" &&
    (url.pathname === "/connector_platform_oauth_redirect" ||
      /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname))
  )
    return "ChatGPT";
  throw new Error(
    "Only the documented ChatGPT and hosted Claude callbacks are supported in this rollout.",
  );
}

export function checkedScopes(scopes?: string[]) {
  const result = scopes?.length ? scopes : [...agentScopes];
  if (
    result.length > 3 ||
    new Set(result).size !== result.length ||
    result.some(
      (scope) => !agentScopes.includes(scope as (typeof agentScopes)[number]),
    )
  )
    throw new Error("Unsupported assistant permissions.");
  return result;
}

export async function getAgentAuthorizationRequest(
  request: Request,
  rawId: string,
) {
  const cookie: unknown = await agentFlowCookie.parse(
    request.headers.get("Cookie"),
  );
  if (
    !/^[\w-]{43}$/.test(rawId) ||
    typeof cookie !== "string" ||
    !/^[\w-]{43}$/.test(cookie)
  )
    throw new Response("Start this connection again from your assistant.", {
      status: 400,
      headers: privateHeaders,
    });
  const flow = await prisma.agentOAuthRequest.findUnique({
    where: { id: digest(rawId) },
  });
  if (
    !flow ||
    flow.status !== "PENDING" ||
    flow.expiresAt.getTime() <= Date.now() ||
    !safeEqual(flow.browserHash, digest(cookie))
  )
    throw new Response(
      "This assistant connection expired or was already used. Start again from your assistant.",
      { status: 400, headers: privateHeaders },
    );
  return flow;
}

export async function finishAgentConsent(
  request: Request,
  rawId: string,
  session: { id: string; shop: string } | null,
) {
  const flow = await getAgentAuthorizationRequest(request, rawId);
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== appOrigin() ||
    request.headers.get("Content-Type")?.split(";")[0] !==
      "application/x-www-form-urlencoded"
  )
    throw new Response("Invalid consent request.", {
      status: 403,
      headers: privateHeaders,
    });
  const text = await request.text();
  if (text.length > 8192)
    throw new Response("Consent request too large.", {
      status: 413,
      headers: privateHeaders,
    });
  const form = new URLSearchParams(text);
  const decision = form.get("decision");
  if (
    form.getAll("csrf").length !== 1 ||
    !safeEqual(form.get("csrf") || "", flow.csrfToken) ||
    form.getAll("decision").length !== 1 ||
    !["allow", "deny"].includes(decision || "")
  )
    throw new Response("Invalid consent request.", {
      status: 403,
      headers: privateHeaders,
    });
  const allStores = flow.shop === null;
  if (
    decision === "allow" &&
    !allStores &&
    (!session || session.shop !== flow.shop)
  )
    throw new Response("Sign in to this merchant before allowing access.", {
      status: 401,
      headers: privateHeaders,
    });
  // Revalidate installation and the registered callback even on a saved flow.
  assistantForRedirect(flow.redirectUri);
  if (!allStores) {
    const installed = await prisma.session.findFirst({
      where: { shop: flow.shop!, isOnline: false },
      select: { id: true },
    });
    if (!installed)
      throw new Response("This merchant disconnected Refund.", {
        status: 404,
        headers: privateHeaders,
      });
  }
  const code = randomToken();
  // An all-stores connection needs no store sign-in to approve because it
  // grants no purchase access by itself. The approving browser is recorded so
  // store links, which do grant access, complete only in this browser.
  const browser =
    allStores && decision === "allow"
      ? ((await readConnectionBrowser(request)) ?? randomToken())
      : null;
  const connectionId = browser ? randomUUID() : null;
  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.agentOAuthRequest.updateMany({
      where: {
        id: flow.id,
        status: "PENDING",
        expiresAt: { gt: new Date() },
        browserHash: flow.browserHash,
      },
      data:
        decision === "allow"
          ? {
              status: "APPROVED",
              ...(connectionId ? { connectionId } : { sessionId: session!.id }),
              codeHash: digest(code),
              codeExpiresAt: new Date(Date.now() + 120_000),
            }
          : { status: "DENIED" },
    });
    if (result.count === 1 && connectionId && browser)
      await tx.agentConnection.create({
        data: {
          id: connectionId,
          clientId: flow.clientId,
          scopes: flow.scopes,
          browserHash: digest(browser),
          expiresAt: new Date(Date.now() + CONNECTION_IDLE_MS),
        },
      });
    return result.count;
  });
  if (claimed !== 1)
    throw new Response("This consent was already used.", {
      status: 409,
      headers: privateHeaders,
    });
  const callback = new URL(flow.redirectUri);
  callback.searchParams.set("iss", appOrigin());
  if (flow.sealedState)
    callback.searchParams.set(
      "state",
      unseal(flow.sealedState, `agent-oauth:${flow.id}`),
    );
  if (decision === "allow") callback.searchParams.set("code", code);
  else callback.searchParams.set("error", "access_denied");
  return redirect(callback.href, {
    headers: {
      ...privateHeaders,
      ...(browser
        ? { "Set-Cookie": await connectionBrowserCookie.serialize(browser) }
        : {}),
    },
  });
}
