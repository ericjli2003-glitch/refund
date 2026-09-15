import { createCookie, redirect } from "react-router";
import { createRemoteJWKSet, jwtVerify } from "jose";
import prisma from "../db.server";
import {
  normalizeShopDomain,
  verifyCustomerAccess,
} from "./customer-account.server";
import { makeContinuation, returnHints } from "./return-intake.server";
import { claimIntakeDraft } from "./return-draft.server";
import {
  appOrigin,
  customerIdentityHashes,
  digest,
  privateHeaders,
  randomToken,
  safeEqual,
  seal,
  unseal,
} from "./customer-security.server";

const cookie = createCookie("__Host-refund_customer", {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 14_400,
});

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};
type PendingLogin = {
  verifier: string;
  nonce: string;
  discovery: Discovery;
};

export async function requireInstalledShop(value: string) {
  const shop = normalizeShopDomain(value);
  if (
    !(await prisma.session.findFirst({
      where: { shop, isOnline: false },
      select: { id: true },
    }))
  ) {
    throw new Response("This store has not connected Refund.", {
      status: 404,
      headers: privateHeaders,
    });
  }
  return shop;
}

async function readSession(request: Request) {
  const raw: unknown = await cookie.parse(request.headers.get("Cookie"));
  if (typeof raw !== "string" || !/^[\w-]{43}$/.test(raw)) return null;
  const session = await prisma.customerReturnSession.findUnique({
    where: { id: digest(raw) },
  });
  return session && session.expiresAt.getTime() > Date.now() ? session : null;
}

export async function getCustomerSession(request: Request, shop: string) {
  const session = await readSession(request);
  if (
    !session ||
    session.shop !== shop ||
    !session.accessToken ||
    !session.customerSubjectHash
  )
    return null;
  return {
    ...session,
    customerToken: unseal(session.accessToken, `${session.id}:${shop}`),
  };
}

// Discovery is anchored in the validated myshopify domain. Reject credential-bearing
// endpoints and non-Shopify hosts before sending codes or access tokens anywhere.
export async function discoverCustomerLogin(shop: string): Promise<Discovery> {
  const response = await fetch(
    `https://${shop}/.well-known/openid-configuration`,
    {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok)
    throw new Error("Customer sign-in is not available for this store.");
  const result = (await response.json()) as Discovery;
  for (const value of [
    result.issuer,
    result.authorization_endpoint,
    result.token_endpoint,
    result.jwks_uri,
  ]) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !(
        url.hostname === "shopify.com" ||
        url.hostname.endsWith(".shopify.com") ||
        url.hostname === shop
      )
    ) {
      throw new Error(
        "Shopify returned an unsupported authentication endpoint.",
      );
    }
  }
  return result;
}

export async function startCustomerLogin(request: Request) {
  const url = new URL(request.url);
  const shop = await requireInstalledShop(url.searchParams.get("shop") || "");
  const hints = returnHints(url, shop);
  const clientId = process.env.SHOPIFY_API_KEY;
  if (!clientId) throw new Error("Customer sign-in is not configured.");
  const discovery = await discoverCustomerLogin(shop);
  const raw = randomToken();
  const id = digest(raw);
  const state = randomToken();
  const verifier = randomToken();
  const nonce = randomToken();
  const old = await readSession(request);
  await prisma.$transaction([
    prisma.customerReturnSession.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          // The browser holds one store sign-in at a time. A session a store
          // link uses stays until it expires, so signing in to another store
          // doesn't end that link's live Shopify session early.
          ...(old ? [{ id: old.id, storeLinks: { none: {} } }] : []),
        ],
      },
    }),
    prisma.customerReturnSession.create({
      data: {
        id,
        shop,
        csrfToken: randomToken(),
        stateHash: digest(state),
        sealedState: seal(
          JSON.stringify({ verifier, nonce, discovery }),
          `${id}:${shop}`,
        ),
        orderHint: hints.orderName,
        itemHint: hints.itemName,
        draftId: hints.draftId,
        expiresAt: new Date(Date.now() + 600_000),
      },
    }),
  ]);
  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    // Identity/ownership uses the verified customer ID, not an email claim.
    // Requesting email also makes login depend on separate protected-field access.
    scope: "openid customer-account-api:full",
    redirect_uri: `${appOrigin()}/customer/callback`,
    state,
    nonce,
    code_challenge: digest(verifier),
    code_challenge_method: "S256",
  }).toString();
  return redirect(authUrl.toString(), {
    headers: { ...privateHeaders, "Set-Cookie": await cookie.serialize(raw) },
  });
}

export async function finishCustomerLogin(request: Request) {
  const url = new URL(request.url);
  const pending = await readSession(request);
  const state = url.searchParams.get("state") || "";
  if (
    !pending?.stateHash ||
    !pending.sealedState ||
    !safeEqual(pending.stateHash, digest(state))
  ) {
    throw new Response(
      "Sign-in expired or did not match this browser. Please start again.",
      { status: 400, headers: privateHeaders },
    );
  }
  await requireInstalledShop(pending.shop);
  const { verifier, nonce, discovery } = JSON.parse(
    unseal(pending.sealedState, `${pending.id}:${pending.shop}`),
  ) as PendingLogin;
  // Claim the callback exactly once, including errors and concurrent requests.
  const claimed = await prisma.customerReturnSession.updateMany({
    where: { id: pending.id, stateHash: pending.stateHash },
    data: { stateHash: null, sealedState: null },
  });
  if (claimed.count !== 1)
    throw new Response("This sign-in was already used.", {
      status: 400,
      headers: privateHeaders,
    });
  if (url.searchParams.has("error") || !url.searchParams.get("code")) {
    const retry = new URLSearchParams({
      loginError: "1",
      continuation: makeContinuation(pending.shop, {
        orderName: pending.orderHint || undefined,
        itemName: pending.itemHint || undefined,
        draftId: pending.draftId || undefined,
      }),
    });
    return redirect(`/returns/${pending.shop}?${retry}`, {
      headers: privateHeaders,
    });
  }
  const clientId = process.env.SHOPIFY_API_KEY!;
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Origin: appOrigin(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: `${appOrigin()}/customer/callback`,
      code: url.searchParams.get("code")!,
      code_verifier: verifier,
    }),
  });
  if (!response.ok)
    throw new Response(
      "Shopify could not finish sign-in. Please start again.",
      { status: 502, headers: privateHeaders },
    );
  const tokens = (await response.json()) as {
    access_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (
    !tokens.access_token ||
    !tokens.id_token ||
    !Number.isFinite(tokens.expires_in) ||
    tokens.expires_in! <= 60
  ) {
    throw new Error("Shopify returned an incomplete customer session.");
  }
  // Narrowed to plain locals: property narrowing on `tokens` does not survive
  // into the transaction closure below.
  const accessToken = tokens.access_token;
  const expiresIn = tokens.expires_in!;
  const { payload } = await jwtVerify(
    tokens.id_token,
    createRemoteJWKSet(new URL(discovery.jwks_uri)),
    {
      issuer: discovery.issuer,
      audience: clientId,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "nonce"],
    },
  );
  if (payload.nonce !== nonce)
    throw new Error("Customer sign-in verification failed.");
  const customerId = await verifyCustomerAccess(pending.shop, accessToken);
  const [customerSubjectHash, ...retiredSubjectHashes] =
    customerIdentityHashes(customerId);
  const raw = randomToken();
  const id = digest(raw);
  // The draft claim commits atomically with the session that lets the
  // customer use it, so a failure never leaves a claimed draft orphaned
  // with no session to resume it.
  await prisma.$transaction(async (tx) => {
    // Customer IDs are never stored, so records hashed under a retired secret
    // can only be re-keyed when that customer proves their identity again.
    if (retiredSubjectHashes.length) {
      const retired = {
        shop: pending.shop,
        customerSubjectHash: { in: retiredSubjectHashes },
      };
      const current = { customerSubjectHash };
      await tx.agentReturn.updateMany({ where: retired, data: current });
      await tx.returnDraft.updateMany({ where: retired, data: current });
      await tx.customerReturnSession.updateMany({
        where: retired,
        data: current,
      });
      await tx.agentAccessGrant.updateMany({ where: retired, data: current });
      await tx.agentStoreLink.updateMany({ where: retired, data: current });
      await tx.privacyRequest.updateMany({ where: retired, data: current });
    }
    if (pending.draftId)
      await claimIntakeDraft(
        { shop: pending.shop, customerSubjectHash, draftId: pending.draftId },
        tx,
      );
    await tx.customerReturnSession.delete({ where: { id: pending.id } });
    await tx.customerReturnSession.create({
      data: {
        id,
        shop: pending.shop,
        csrfToken: randomToken(),
        accessToken: seal(accessToken, `${id}:${pending.shop}`),
        customerSubjectHash,
        orderHint: pending.orderHint,
        itemHint: pending.itemHint,
        draftId: pending.draftId,
        expiresAt: new Date(
          Date.now() + Math.min(expiresIn - 60, 14_400) * 1000,
        ),
      },
    });
  });
  return redirect(`/returns/${pending.shop}`, {
    headers: { ...privateHeaders, "Set-Cookie": await cookie.serialize(raw) },
  });
}
