import prisma from "../../db.server";
import { isWixStore, wixStoreKey } from "../store-platform.server";
import { WixApiError, type WixApi, type WixMethod } from "./wix-api.server";

// Gooper.io calls Wix as the app itself, per installed site, with the OAuth
// client-credentials grant: app ID + app secret + the site's instance ID buy a
// short-lived access token. There is no refresh token and nothing to store; a
// new token is minted whenever the cached one is about to expire. This is what
// @wix/sdk's AppStrategy({appId, appSecret, instanceId}) does.
export const WIX_API_ORIGIN = "https://www.wixapis.com";
const TOKEN_URL = `${WIX_API_ORIGIN}/oauth2/token`;
// Tokens are documented to last 4 hours (expires_in 14400). Renewing a few
// minutes early keeps a request from starting with a token that expires in
// flight.
const TOKEN_RENEW_MARGIN_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 10_000;
const API_TIMEOUT_MS = 20_000;

export type WixClientDeps = {
  fetch?: typeof fetch;
  now?: () => number;
};

export function wixConfigured() {
  return Boolean(process.env.WIX_APP_ID?.trim() && process.env.WIX_APP_SECRET?.trim());
}

function credentials() {
  const appId = process.env.WIX_APP_ID?.trim();
  const appSecret = process.env.WIX_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error("Wix is not configured.");
  return { appId, appSecret };
}

type CachedToken = { token: string; expiresAt: number };
const tokens = new Map<string, CachedToken>();
// One mint at a time per site, so a burst of calls shares a single request.
const minting = new Map<string, Promise<CachedToken>>();

// Drops the cached token, e.g. after Wix refuses it or the app is removed.
export function forgetWixAccessToken(instanceId: string) {
  tokens.delete(instanceId.trim().toLowerCase());
}

// Wix error bodies look like { message, details: { applicationError: { code,
// description } } } (or validationError). Only Wix's own code and message are
// kept, trimmed, so nothing we sent (tokens, secrets) can end up in a log.
async function wixError(response: Response, what: string) {
  let code: string | undefined;
  let detail = "";
  try {
    const body = (await response.json()) as {
      message?: unknown;
      code?: unknown;
      details?: { applicationError?: { code?: unknown; description?: unknown } };
    };
    const application = body?.details?.applicationError;
    const rawCode = application?.code ?? body?.code;
    if (typeof rawCode === "string" || typeof rawCode === "number")
      code = String(rawCode).slice(0, 100);
    const message = application?.description ?? body?.message;
    if (typeof message === "string") detail = message.slice(0, 300);
  } catch {
    // Not JSON; the status says enough.
  }
  const requestId = response.headers.get("x-wix-request-id");
  const status = response.status;
  const rejected = status >= 400 && status < 500 && status !== 409 && status !== 429;
  return new WixApiError(
    `${what} failed with status ${status}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}${requestId ? ` [request ${requestId.slice(0, 80)}]` : ""}`,
    status,
    rejected,
    code,
  );
}

// A network failure or timeout means we do not know whether Wix ran the call,
// so it is never marked rejected.
function unreachable(what: string, error: unknown) {
  const timedOut =
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new WixApiError(
    timedOut ? `${what} timed out.` : `${what} could not reach Wix.`,
    504,
    false,
  );
}

async function mintToken(instanceId: string, deps: WixClientDeps): Promise<CachedToken> {
  const { appId, appSecret } = credentials();
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let response: Response;
  try {
    response = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: appId,
        client_secret: appSecret,
        instance_id: instanceId,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw unreachable("Wix access token request", error);
  }
  if (!response.ok) throw await wixError(response, "Wix access token request");
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  const token = body?.access_token;
  const expiresIn = Number(body?.expires_in);
  if (typeof token !== "string" || !token || !Number.isFinite(expiresIn) || expiresIn <= 0)
    throw new WixApiError("Wix returned an unusable access token.", 502, false);
  lastMintedAt = now();
  return { token, expiresAt: now() + expiresIn * 1000 };
}

// Whether an error from minting a site's token (wixAccessToken) means Wix no
// longer has Gooper.io on that site, so its data can be deleted. Only 400 and
// 404 (instance not found / app not installed) count. 401 and 403 mean our
// own credentials were refused (a wrong or rotated WIX_APP_SECRET), which
// says nothing about the site; treating them as "removed" would let a
// credential problem wipe live stores. UNVERIFIED: the exact status Wix
// returns for a removed instance; 400 and 404 are both accepted. Apply this
// only to token mint errors: other endpoints use 400/404 for their own reasons.
// When this process last got a token from Wix for any site. A token proves the
// app's own credentials work, so a "not installed" answer about some other
// site can be believed. With broken credentials (say a bad secret rotation,
// which some OAuth servers answer with 400) no token is ever issued, and
// nothing gets deleted on the strength of those answers.
let lastMintedAt = 0;
const CREDENTIALS_PROVEN_MS = 24 * 3_600_000;
export const wixCredentialsProven = (now = Date.now()) =>
  lastMintedAt > 0 && now - lastMintedAt < CREDENTIALS_PROVEN_MS;

export function wixInstanceGone(error: unknown) {
  return error instanceof WixApiError && (error.status === 400 || error.status === 404);
}

// The app's access token for one installed site, cached in memory until
// shortly before it expires. `fresh` skips the cache.
export async function wixAccessToken(
  instanceId: string,
  deps: WixClientDeps & { fresh?: boolean } = {},
) {
  // Validates the ID shape before it is sent anywhere.
  const id = wixStoreKey(instanceId).slice("wix-".length);
  const now = deps.now ?? Date.now;
  const cached = tokens.get(id);
  if (!deps.fresh && cached && cached.expiresAt - TOKEN_RENEW_MARGIN_MS > now())
    return cached.token;
  let pending = minting.get(id);
  if (!pending) {
    pending = mintToken(id, deps).finally(() => minting.delete(id));
    minting.set(id, pending);
  }
  const minted = await pending;
  tokens.set(id, minted);
  return minted.token;
}

function apiUrl(path: string) {
  // Paths are ours (never caller-supplied hosts); still refuse anything that
  // could leave www.wixapis.com.
  if (!path.startsWith("/") || path.startsWith("//") || /[\s\\]/.test(path))
    throw new Error("Invalid Wix API path.");
  const url = new URL(path, WIX_API_ORIGIN);
  if (url.origin !== WIX_API_ORIGIN) throw new Error("Invalid Wix API path.");
  return url;
}

// A WixApi for one installed site.
//
// Idempotency: Wix has no general idempotency header that I could confirm.
// UNVERIFIED: none is sent, so `options.idempotencyKey` is ignored here.
// Callers that must not repeat a side effect (refunds) guard with their own
// records and re-read state before retrying.
export function createWixApi(instanceId: string, deps: WixClientDeps = {}): WixApi {
  const doFetch = deps.fetch ?? fetch;
  return async <T>(method: WixMethod, path: string, body?: unknown): Promise<T> => {
    const url = apiUrl(path);
    const what = `Wix ${method} ${url.pathname}`;
    const send = async (token: string) => {
      try {
        return await doFetch(url, {
          method,
          headers: {
            // Wix takes the raw token, no "Bearer" prefix (as @wix/sdk sends it).
            Authorization: token,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
      } catch (error) {
        throw unreachable(what, error);
      }
    };
    let response = await send(await wixAccessToken(instanceId, deps));
    // A 401 is refused before anything runs, so one retry with a newly minted
    // token is safe even for writes (the cached token may have been revoked).
    if (response.status === 401) {
      forgetWixAccessToken(instanceId);
      response = await send(await wixAccessToken(instanceId, { ...deps, fresh: true }));
    }
    if (!response.ok) throw await wixError(response, what);
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WixApiError(`${what} returned a response that is not JSON.`, 502, false);
    }
  };
}

// The API for a store key, only when that Wix site has Gooper.io installed.
// The instance ID comes from our own installation record, never from a caller.
export async function wixApiFor(shop: string): Promise<WixApi> {
  if (!isWixStore(shop)) throw new Error("Not a Wix store.");
  const install = await prisma.wixInstallation.findUnique({
    where: { shop },
    select: { instanceId: true },
  });
  if (!install) throw new Error("Gooper.io is not installed on this Wix site.");
  return createWixApi(install.instanceId);
}

// Test hook: clears every cached token.
export function resetWixTokenCache() {
  tokens.clear();
  minting.clear();
  lastMintedAt = 0;
}
