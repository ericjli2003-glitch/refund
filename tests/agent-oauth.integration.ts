import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import express from "express";
import { createCookie } from "react-router";
import prisma from "../app/db.server";
import { createOAuthRouter } from "../server/oauth";
import { createAgentOAuthProvider } from "../app/services/agent-oauth-provider.server";
import {
  StoreLinkRequiredError,
  authorizeConnection,
  connectionStore,
  listAgentGrants,
  listConnectionStores,
  pruneExpiredCustomerAccess,
  revokeAgentGrant,
} from "../app/services/agent-access.server";
import {
  customerIdentityHash,
  digest,
  randomToken,
  seal,
} from "../app/services/customer-security.server";
import { getAgentAuthorizationRequest } from "../app/services/agent-oauth-flow.server";
import { action as consentAction } from "../app/routes/agent.authorize.$requestId";
import { action as mcpAction } from "../app/routes/mcp.$shop";
import { action as mcpStoresAction } from "../app/routes/mcp.stores";
import { action as storeLinkAction } from "../app/routes/connect.stores.link.$token";
import { action as connectEmailTapAction } from "../app/routes/verify.connect-email.$token";
import { consentTapCsrf } from "../app/services/consent-email.server";
import {
  getStoreLinkRequest,
  startStoreLink,
} from "../app/services/store-link.server";

const dbUrl = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(dbUrl.hostname) &&
    dbUrl.pathname === "/refund_ci",
  "OAuth integration tests must use the isolated local refund_ci database",
);
process.env.SHOPIFY_APP_URL = "https://refund.test";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_API_KEY ||= "test-key";

test("direct assistant OAuth works through SDK HTTP handlers and PostgreSQL", async (t) => {
  const shop = `oauth-ci-${randomUUID().slice(0, 8)}.myshopify.com`;
  const resource = `https://refund.test/mcp/${shop}`;
  const app = express();
  app.use(createOAuthRouter());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const clientIds: string[] = [];
  const sessionRaw = randomToken();
  const customerCookie = (
    await createCookie("__Host-refund_customer").serialize(sessionRaw)
  ).split(";")[0];
  const sessionId = digest(sessionRaw);
  await prisma.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: "ci",
      isOnline: false,
      accessToken: "ci-only",
    },
  });
  await prisma.customerReturnSession.create({
    data: {
      id: sessionId,
      shop,
      csrfToken: randomToken(),
      customerSubjectHash: "test-customer",
      accessToken: seal("upstream-private-token", `${sessionId}:${shop}`),
      expiresAt: new Date(Date.now() + 4 * 3600_000),
    },
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await prisma.$transaction([
      prisma.customerReturnSession.deleteMany({ where: { shop } }),
      prisma.agentConnection.deleteMany({ where: { clientId: { in: clientIds } } }),
      prisma.agentOAuthRequest.deleteMany({ where: { clientId: { in: clientIds } } }),
      prisma.agentOAuthClient.deleteMany({ where: { id: { in: clientIds } } }),
      prisma.session.deleteMany({ where: { shop } }),
    ]);
    await prisma.$disconnect();
  });

  const post = (path: string, body: Record<string, string>) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  async function register(
    callback: string,
    method = "none",
    extra: Record<string, unknown> = {},
  ) {
    const response = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Untrusted label",
        redirect_uris: [callback],
        token_endpoint_auth_method: method,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...extra,
      }),
    });
    const value = await response.json();
    if (value.client_id) clientIds.push(value.client_id);
    return { response, value };
  }
  const callback = "https://claude.ai/api/mcp/auth_callback";
  const { value: client, response: registration } = await register(callback);
  assert.equal(registration.status, 201);
  assert.equal(client.client_name, "Claude");

  async function start(
    scopes = "returns:read returns:quote returns:submit",
    overrides: Record<string, string> = {},
  ) {
    const verifier = randomToken();
    const query = new URLSearchParams({
      client_id: client.client_id,
      response_type: "code",
      redirect_uri: callback,
      resource,
      scope: scopes,
      code_challenge: digest(verifier),
      code_challenge_method: "S256",
      state: "host-state",
      ...overrides,
    });
    const response = await fetch(`${base}/authorize?${query}`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("Location")!);
    const rawId = target.pathname.split("/").at(-1)!;
    const flow = await prisma.agentOAuthRequest.findUniqueOrThrow({
      where: { id: digest(rawId) },
    });
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    return { verifier, rawId, flow, cookie, target };
  }
  type Flow = Awaited<ReturnType<typeof start>>;
  async function consent(
    flow: Flow,
    decision = "allow",
    options: {
      cookie?: string;
      csrf?: string;
      origin?: string;
      noCustomer?: boolean;
    } = {},
  ) {
    const url = `https://refund.test/agent/authorize/${flow.rawId}`;
    const cookie =
      options.cookie ??
      `${flow.cookie}${options.noCustomer ? "" : `; ${customerCookie}`}`;
    // Allow and Cancel always answer with a redirect response.
    return (await consentAction({
      request: new Request(url, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: options.origin || "https://refund.test",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          decision,
          csrf: options.csrf ?? flow.flow.csrfToken,
        }),
      }),
      params: { requestId: flow.rawId },
      context: {},
      url: new URL(url),
      pattern: "/agent/authorize/:requestId",
    })) as Response;
  }
  const exchange = (
    flow: Flow,
    code: string,
    extra: Record<string, string> = {},
  ) =>
    post("/token", {
      client_id: client.client_id,
      grant_type: "authorization_code",
      code,
      code_verifier: flow.verifier,
      redirect_uri: callback,
      resource,
      ...extra,
    });
  const refresh = (refreshToken: string, extra: Record<string, string> = {}) =>
    post("/token", {
      client_id: client.client_id,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource,
      ...extra,
    });
  const responseStatus = (status: number) => (error: unknown) =>
    error instanceof Response && error.status === status;

  await t.test(
    "discovery advertises the implemented code, refresh, PKCE and DCR capabilities",
    async () => {
      const metadata = await (
        await fetch(`${base}/.well-known/oauth-authorization-server`)
      ).json();
      assert.equal(metadata.issuer, "https://refund.test");
      assert.equal(
        metadata.authorization_response_iss_parameter_supported,
        true,
      );
      assert.equal(metadata.client_id_metadata_document_supported, false);
      assert.deepEqual(metadata.grant_types_supported, [
        "authorization_code",
        "refresh_token",
      ]);
      assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    },
  );
  await t.test(
    "both host callbacks register; arbitrary callbacks fail; clients survive provider restart",
    async () => {
      assert.equal(
        (
          await register(
            "https://chatgpt.com/connector_platform_oauth_redirect",
          )
        ).response.status,
        201,
      );
      const confidential = await register(
        "https://chatgpt.com/connector/oauth/test-callback",
        "client_secret_post",
      );
      assert.equal(confidential.response.status, 201);
      assert.ok(confidential.value.client_secret);
      const stored = await prisma.agentOAuthClient.findUniqueOrThrow({
        where: { id: confidential.value.client_id },
      });
      assert.ok(
        !stored.sealedInformation.includes(confidential.value.client_secret),
      );
      assert.equal(
        (
          await createAgentOAuthProvider().clientsStore.getClient(
            confidential.value.client_id,
          )
        )?.client_secret,
        confidential.value.client_secret,
      );
      for (const value of [
        "https://evil.test/callback",
        "https://claude.ai.evil.test/api/mcp/auth_callback",
        "https://claude.ai/api/mcp/auth_callback?next=evil",
        "http://localhost/callback",
      ]) {
        assert.equal((await register(value)).response.status, 400);
      }
    },
  );
  await t.test(
    "registration HTTP errors distinguish auth, grant and storage failures",
    async () => {
      const method = await register(callback, "client_secret_basic");
      assert.equal(method.response.status, 400);
      assert.equal(method.value.error, "invalid_client_metadata");
      assert.match(
        method.value.error_description,
        /\[registration_auth_method\]/,
      );
      const grant = await register(callback, "none", {
        grant_types: ["authorization_code", "client_credentials"],
      });
      assert.equal(grant.response.status, 400);
      assert.match(
        grant.value.error_description,
        /\[registration_grant_type\]/,
      );
      const originalCount = prisma.agentOAuthClient.count;
      Reflect.set(prisma.agentOAuthClient, "count", async () => {
        throw new Error("private-database-error");
      });
      try {
        const storage = await register(callback);
        assert.equal(storage.response.status, 500);
        assert.equal(storage.value.error, "server_error");
        assert.match(
          storage.value.error_description,
          /\[registration_storage\]/,
        );
        assert.ok(
          !JSON.stringify(storage.value).includes("private-database-error"),
        );
      } finally {
        Reflect.set(prisma.agentOAuthClient, "count", originalCount);
      }
    },
  );
  await t.test(
    "invalid authorization redirects include issuer, while unregistered redirects are not followed",
    async () => {
      const params = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: callback,
        response_type: "code",
        code_challenge: digest(randomToken()),
        code_challenge_method: "plain",
        resource,
      });
      const failed = await fetch(`${base}/authorize?${params}`, {
        redirect: "manual",
      });
      const target = new URL(failed.headers.get("Location")!);
      assert.equal(target.searchParams.get("iss"), "https://refund.test");
      assert.equal(target.searchParams.get("error"), "invalid_request");
      params.set("redirect_uri", "https://evil.test/");
      const rejected = await fetch(`${base}/authorize?${params}`, {
        redirect: "manual",
      });
      assert.equal(rejected.status, 400);
      assert.equal(rejected.headers.get("Location"), null);
    },
  );
  await t.test(
    "consent rejects the wrong browser, CSRF and origin; denial issues no code",
    async () => {
      const flow = await start();
      await assert.rejects(
        consent(flow, "allow", {
          cookie: `__Host-refund_agent_flow=${randomToken()}`,
        }),
        responseStatus(400),
      );
      await assert.rejects(
        consent(flow, "allow", { csrf: "wrong" }),
        responseStatus(403),
      );
      await assert.rejects(
        consent(flow, "allow", { origin: "https://evil.test" }),
        responseStatus(403),
      );
      const denied = new URL(
        (await consent(flow, "deny", { noCustomer: true })).headers.get(
          "Location",
        )!,
      );
      assert.equal(denied.searchParams.get("error"), "access_denied");
      assert.equal(denied.searchParams.get("iss"), "https://refund.test");
      assert.equal(denied.searchParams.get("state"), "host-state");
      assert.equal(denied.searchParams.get("code"), null);
      assert.equal(
        await prisma.agentAccessGrant.count({ where: { clientId: client.client_id } }),
        0,
      );
    },
  );
  await t.test(
    "a store's own address connects every store; PKCE, resource and redirect mismatches fail before the code is used",
    async () => {
      const flow = await start("returns:read");
      // Addresses saved from store-specific setup pages open the same
      // connection to every Refund store, with no merchant sign-in.
      assert.equal(flow.flow.shop, null);
      const approved = new URL(
        (await consent(flow, "allow", { noCustomer: true })).headers.get("Location")!,
      );
      const code = approved.searchParams.get("code")!;
      assert.equal(approved.searchParams.get("iss"), "https://refund.test");
      assert.equal(approved.searchParams.get("state"), "host-state");
      const invalidExchanges: Record<string, string>[] = [
        { code_verifier: randomToken() },
        { resource: "https://evil.test/mcp" },
        { resource: "https://refund.test/mcp/stores" },
        { redirect_uri: "https://evil.test/callback" },
        { client_id: clientIds[1] },
      ];
      for (const patch of invalidExchanges) {
        assert.equal((await exchange(flow, code, patch)).status, 400);
      }
      const result = await exchange(flow, code);
      assert.equal(result.status, 200);
      const tokens = await result.json();
      assert.equal(tokens.scope, "returns:read");
      assert.ok(tokens.expires_in > 0 && tokens.expires_in <= 3600);
      assert.match(tokens.refresh_token, /^rfr_[A-Za-z0-9_-]{43}$/);
      assert.ok(
        (await authorizeConnection(`Bearer ${tokens.access_token}`, "returns:read"))
          .connectionId,
      );
      const call = (body: Record<string, unknown>) =>
        mcpAction({
          request: new Request(resource, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: `Bearer ${tokens.access_token}`,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
          }),
          params: { shop },
          context: {},
          url: new URL(resource),
          pattern: "/mcp/:shop",
        });
      // The store's address serves the network tools, including submitting.
      const listed = await call({ method: "tools/list" });
      assert.equal(listed.status, 200);
      const names = ((await listed.json()).result.tools as Array<{ name: string }>).map(
        (tool) => tool.name,
      );
      for (const name of ["find_store", "link_store", "quote_return", "confirm_return"])
        assert.ok(names.includes(name), name);
      const forbidden = await call({
        method: "tools/call",
        params: {
          name: "confirm_return",
          arguments: { shop, customerConfirmed: true, quoteToken: "unused" },
        },
      });
      assert.equal(forbidden.status, 403);
      assert.match(
        forbidden.headers.get("WWW-Authenticate")!,
        /returns:submit/,
      );
      assert.equal((await exchange(flow, code)).status, 400);
      await assert.rejects(authorizeConnection(`Bearer ${tokens.access_token}`));
    },
  );
  await t.test("concurrent exchanges cannot mint two grants", async () => {
    const flow = await start("returns:read");
    const code = new URL(
      (await consent(flow)).headers.get("Location")!,
    ).searchParams.get("code")!;
    const results = await Promise.all([
      exchange(flow, code),
      exchange(flow, code),
    ]);
    assert.deepEqual(results.map((value) => value.status).sort(), [200, 400]);
    const issued = await prisma.agentOAuthRequest.findUniqueOrThrow({
      where: { id: flow.flow.id },
    });
    const grant = await prisma.agentAccessGrant.findUniqueOrThrow({
      where: { tokenHash: issued.grantHash! },
    });
    assert.ok(grant.revokedAt);
  });
  await t.test(
    "refresh tokens rotate, can narrow scopes, and replay revokes the rotated token family",
    async () => {
      const flow = await start();
      const code = new URL(
        (await consent(flow)).headers.get("Location")!,
      ).searchParams.get("code")!;
      const first = await (await exchange(flow, code)).json();
      assert.equal(
        (
          await refresh(first.refresh_token, {
            scope: "returns:read returns:quote returns:submit unknown",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await refresh(first.refresh_token, {
            resource: "https://evil.test/mcp",
          })
        ).status,
        400,
      );
      const rotatedResponse = await refresh(first.refresh_token, {
        scope: "returns:read returns:quote",
      });
      assert.equal(rotatedResponse.status, 200);
      const rotated = await rotatedResponse.json();
      assert.match(rotated.access_token, /^rfa_[A-Za-z0-9_-]{43}$/);
      assert.match(rotated.refresh_token, /^rfr_[A-Za-z0-9_-]{43}$/);
      assert.notEqual(rotated.access_token, first.access_token);
      assert.notEqual(rotated.refresh_token, first.refresh_token);
      assert.equal(rotated.scope, "returns:read returns:quote");
      await assert.rejects(authorizeConnection(`Bearer ${first.access_token}`));
      await authorizeConnection(`Bearer ${rotated.access_token}`, "returns:quote");
      await assert.rejects(
        authorizeConnection(`Bearer ${rotated.access_token}`, "returns:submit"),
      );
      assert.equal((await refresh(first.refresh_token)).status, 400);
      await assert.rejects(authorizeConnection(`Bearer ${rotated.access_token}`));
      assert.equal((await refresh(rotated.refresh_token)).status, 400);
    },
  );
  await t.test(
    "expired requests and codes, and revocation, fail closed",
    async () => {
      const expired = await start();
      await prisma.agentOAuthRequest.update({
        where: { id: expired.flow.id },
        data: { expiresAt: new Date(0) },
      });
      await assert.rejects(
        getAgentAuthorizationRequest(
          new Request(expired.target, { headers: { Cookie: expired.cookie } }),
          expired.rawId,
        ),
        responseStatus(400),
      );
      const flow = await start();
      const code = new URL(
        (await consent(flow)).headers.get("Location")!,
      ).searchParams.get("code")!;
      await prisma.agentOAuthRequest.update({
        where: { id: flow.flow.id },
        data: { codeExpiresAt: new Date(0) },
      });
      assert.equal((await exchange(flow, code)).status, 400);
      const next = await start();
      const nextCode = new URL(
        (await consent(next)).headers.get("Location")!,
      ).searchParams.get("code")!;
      const tokens = await (await exchange(next, nextCode)).json();
      assert.equal(
        (
          await post("/revoke", {
            client_id: client.client_id,
            token: tokens.refresh_token,
          })
        ).status,
        200,
      );
      await assert.rejects(authorizeConnection(`Bearer ${tokens.access_token}`));
      assert.equal(
        (
          await post("/token", {
            client_id: client.client_id,
            grant_type: "refresh_token",
            refresh_token: "unused",
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "one all-stores connection links each store with that store's own sign-in",
    async (ctx) => {
      const allStores = "https://refund.test/mcp/stores";
      await prisma.merchantDirectory.create({
        data: {
          shop,
          primaryDomain: `${shop.split(".")[0]}.example.test`,
          name: "OAuth CI Store",
        },
      });
      const linkRaw = randomToken();
      const linkSessionId = digest(linkRaw);
      const linkedCustomerId = "gid://shopify/Customer/777";
      await prisma.customerReturnSession.create({
        data: {
          id: linkSessionId,
          shop,
          csrfToken: randomToken(),
          customerSubjectHash: customerIdentityHash(linkedCustomerId),
          accessToken: seal("linked-private-token", `${linkSessionId}:${shop}`),
          expiresAt: new Date(Date.now() + 4 * 3600_000),
        },
      });
      const linkCustomerCookie = (
        await createCookie("__Host-refund_customer").serialize(linkRaw)
      ).split(";")[0];
      ctx.after(async () => {
        await prisma.$transaction([
          prisma.agentConnection.deleteMany({
            where: { clientId: client.client_id },
          }),
          prisma.agentOAuthRequest.deleteMany({
            where: { resource: allStores, clientId: client.client_id },
          }),
          prisma.merchantDirectory.deleteMany({ where: { shop } }),
          prisma.storePolicy.deleteMany({ where: { shop } }),
        ]);
      });

      // Approving the connection needs no store sign-in and reaches no store,
      // but first the customer confirms the email they shop with.
      const savedEmailEnv = {
        RESEND_API_KEY: process.env.RESEND_API_KEY,
        REFUND_EMAIL_FROM: process.env.REFUND_EMAIL_FROM,
      };
      process.env.RESEND_API_KEY = "re_ci";
      process.env.REFUND_EMAIL_FROM = "Refund <returns@refund.test>";
      ctx.after(() => {
        for (const [name, value] of Object.entries(savedEmailEnv))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      });
      const realFetch = globalThis.fetch.bind(globalThis);
      const emails: Array<{ subject: string; text: string }> = [];
      const resend = ctx.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).startsWith("https://api.resend.com/")) {
            emails.push(JSON.parse(String(init?.body)));
            return Response.json({ id: "ci" });
          }
          return realFetch(input, init);
        },
      );
      const emailStep = async (flow: Flow, body: Record<string, string>) => {
        const url = `https://refund.test/agent/authorize/${flow.rawId}`;
        const result = await consentAction({
          request: new Request(url, {
            method: "POST",
            headers: {
              Cookie: flow.cookie,
              Origin: "https://refund.test",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ csrf: flow.flow.csrfToken, ...body }),
          }),
          params: { requestId: flow.rawId },
          context: {},
          url: new URL(url),
          pattern: "/agent/authorize/:requestId",
        });
        return (result as unknown as { data: { ok: boolean; message: string } }).data;
      };
      const pendingCheck = (flow: Flow) =>
        prisma.consentEmailCheck.findFirstOrThrow({
          where: { requestId: flow.flow.id, status: "PENDING" },
          orderBy: { createdAt: "desc" },
        });
      const confirmByCode = async (flow: Flow, address: string) => {
        assert.equal((await emailStep(flow, { intent: "send", email: address })).ok, true);
        const code = emails.at(-1)!.subject.slice(0, 6);
        const check = await pendingCheck(flow);
        const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
        assert.equal(
          (await emailStep(flow, { intent: "verify", checkId: check.id, code: wrong })).ok,
          false,
        );
        assert.equal(
          (await emailStep(flow, { intent: "verify", checkId: check.id, code })).ok,
          true,
        );
      };

      const flow = await start("returns:read returns:quote", {
        resource: allStores,
      });
      assert.equal(flow.flow.shop, null);
      await assert.rejects(
        consent(flow, "allow", { noCustomer: true }),
        responseStatus(400),
      );
      await confirmByCode(flow, "Pat@Example.com");
      // A second email, confirmed on another device with the number shown on
      // the page. Asking for another code straight away waits a moment.
      assert.equal(
        (await emailStep(flow, { intent: "send", email: "second@example.com" })).ok,
        true,
      );
      const tapCheck = await pendingCheck(flow);
      assert.match(
        (await emailStep(flow, { intent: "resend", checkId: tapCheck.id })).message,
        /just sent/,
      );
      const tapToken = emails.at(-1)!.text.match(/\/verify\/connect-email\/([\w-]{43})/)![1];
      const tapUrl = `https://refund.test/verify/connect-email/${tapToken}`;
      const tapped = await connectEmailTapAction({
        request: new Request(tapUrl, {
          method: "POST",
          headers: {
            Origin: "https://refund.test",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            csrf: consentTapCsrf(tapCheck.id),
            choice: String(tapCheck.matchNumber),
          }),
        }),
        params: { token: tapToken },
        context: {},
        url: new URL(tapUrl),
        pattern: "/verify/connect-email/:token",
      });
      assert.match(tapped.headers.get("Location")!, /outcome=confirmed/);
      const approved = await consent(flow, "allow", { noCustomer: true });
      const connectionCookie = approved.headers
        .get("Set-Cookie")!
        .split(";")[0];
      assert.match(connectionCookie, /^__Host-refund_connection=/);
      const code = new URL(approved.headers.get("Location")!).searchParams.get(
        "code",
      )!;
      assert.equal(
        (await exchange(flow, code, { resource: resource })).status,
        400,
      );
      const flow2 = await start("returns:read returns:quote", {
        resource: allStores,
      });
      await confirmByCode(flow2, "pat@example.com");
      const code2 = new URL(
        (
          await consent(flow2, "allow", {
            cookie: `${flow2.cookie}; ${connectionCookie}`,
          })
        ).headers.get("Location")!,
      ).searchParams.get("code")!;
      const tokenResponse = await exchange(flow2, code2, {
        resource: allStores,
      });
      assert.equal(tokenResponse.status, 200);
      const tokens = await tokenResponse.json();
      assert.match(tokens.refresh_token, /^rfr_/);
      const { connectionId } = await authorizeConnection(
        `Bearer ${tokens.access_token}`,
        "returns:quote",
      );
      // Emails confirmed on the consent page belong to the connection,
      // encrypted, and the codes are cleared.
      const confirmedEmails = await prisma.connectionEmail.findMany({
        where: { connectionId },
      });
      assert.deepEqual(
        confirmedEmails.map((row) => row.source),
        ["ONBOARDING"],
      );
      assert.ok(!confirmedEmails[0].sealedEmail.includes("pat@example.com"));
      assert.equal(
        await prisma.consentEmailCheck.count({ where: { requestId: flow2.flow.id } }),
        0,
      );
      const firstConnection = (
        await prisma.agentOAuthRequest.findUniqueOrThrow({ where: { id: flow.flow.id } })
      ).connectionId!;
      assert.equal(
        await prisma.connectionEmail.count({ where: { connectionId: firstConnection } }),
        2,
      );
      // Reusing this browser's connection cookie binds both connections to it.
      const connections = await prisma.agentConnection.findMany({
        where: { id: { in: [firstConnection, connectionId] } },
      });
      assert.equal(connections.length, 2);
      assert.equal(new Set(connections.map((value) => value.browserHash)).size, 1);

      const callTool = (
        authorization: string,
        name: string,
        args: Record<string, unknown>,
      ) =>
        mcpStoresAction({
          request: new Request(allStores, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: authorization,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          }),
          params: {},
          context: {},
          url: new URL(allStores),
          pattern: "/mcp/stores",
        });
      assert.equal(
        (await callTool(`Bearer rfa_${randomToken()}`, "get_return_session", { shop }))
          .status,
        401,
      );
      assert.equal(
        (
          await callTool(`Bearer ${tokens.access_token}`, "confirm_return", {
            shop,
            quoteToken: "unused",
            customerConfirmed: true,
          })
        ).status,
        403,
      );
      const unlinked = await callTool(
        `Bearer ${tokens.access_token}`,
        "get_return_session",
        { shop },
      );
      assert.equal(unlinked.status, 200);
      const unlinkedBody = await unlinked.json();
      assert.equal(unlinkedBody.result.structuredContent.linkRequired, true);
      assert.equal(unlinkedBody.result.structuredContent.reason, "not_linked");

      const started = await startStoreLink(connectionId, shop);
      assert.equal(started.status, "sign_in_required");
      const linkUrl = started.linkUrl!;
      const rawLink = new URL(linkUrl).pathname.split("/").at(-1)!;
      const pending = await prisma.agentStoreLinkRequest.findUniqueOrThrow({
        where: { id: digest(rawLink) },
      });
      // A link opened in any other browser is refused, signed in or not.
      await assert.rejects(
        getStoreLinkRequest(
          new Request(linkUrl, { headers: { Cookie: linkCustomerCookie } }),
          rawLink,
        ),
        responseStatus(400),
      );
      const linkAction = (cookie: string) =>
        storeLinkAction({
          request: new Request(linkUrl, {
            method: "POST",
            headers: {
              Cookie: cookie,
              Origin: "https://refund.test",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              decision: "allow",
              csrf: pending.csrfToken,
            }),
          }),
          params: { token: rawLink },
          context: {},
          url: new URL(linkUrl),
          pattern: "/connect/stores/link/:token",
        });
      resend.mock.restore();
      await assert.rejects(linkAction(connectionCookie), responseStatus(401));
      // Linking verifies the signed-in customer with Shopify once.
      const upstream = ctx.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request) =>
          String(input).includes("/.well-known/customer-account-api")
            ? Response.json({
                graphql_api:
                  "https://shopify.com/1/account/customer/api/2026-07/graphql",
              })
            : Response.json({ data: { customer: { id: linkedCustomerId } } }),
      );
      const linked = await linkAction(`${connectionCookie}; ${linkCustomerCookie}`);
      assert.equal(linked.status, 302);
      assert.match(linked.headers.get("Location")!, /\/connect\/stores\/linked\?shop=/);
      await assert.rejects(
        linkAction(`${connectionCookie}; ${linkCustomerCookie}`),
        responseStatus(400),
      );
      upstream.mock.restore();

      assert.equal(
        (await connectionStore(connectionId, shop)).customerToken,
        "linked-private-token",
      );
      assert.deepEqual(
        (await listConnectionStores(connectionId)).map((value) => [
          value.shop,
          value.name,
          value.active,
        ]),
        [[shop, "OAuth CI Store", true]],
      );
      assert.equal((await startStoreLink(connectionId, shop)).status, "already_linked");

      const refreshed = await post("/token", {
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        resource: allStores,
      });
      assert.equal(refreshed.status, 200);
      const next = await refreshed.json();
      await authorizeConnection(`Bearer ${next.access_token}`);
      await assert.rejects(authorizeConnection(`Bearer ${tokens.access_token}`));

      // After the Shopify session ends, the link keeps working only where the
      // store has confirmed its return rules and allows it.
      await prisma.customerReturnSession.update({
        where: { id: linkSessionId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      await assert.rejects(
        connectionStore(connectionId, shop),
        StoreLinkRequiredError,
      );
      await prisma.storePolicy.create({
        data: { shop, returnRulesConfirmedAt: new Date() },
      });
      assert.deepEqual((await connectionStore(connectionId, shop)).customerToken, {
        customerId: linkedCustomerId,
      });
      assert.equal(
        (await listConnectionStores(connectionId))[0].staysLinkedWithoutSignIn,
        true,
      );
      await prisma.storePolicy.update({
        where: { shop },
        data: { verifiedStoreLinks: false },
      });
      await assert.rejects(
        connectionStore(connectionId, shop),
        StoreLinkRequiredError,
      );

      // The customer removes the link from that store's return portal.
      const listed = (await listAgentGrants(linkSessionId)).find((value) =>
        value.name.includes("all-stores connection"),
      );
      assert.ok(listed);
      assert.equal((await revokeAgentGrant(listed.id, linkSessionId)).count, 1);
      await assert.rejects(
        connectionStore(connectionId, shop),
        StoreLinkRequiredError,
      );

      // Removing Refund from the assistant revokes its token, which ends the
      // whole connection and deletes everything it still held.
      assert.equal(
        await prisma.agentStoreLinkRequest.count({ where: { connectionId } }),
        1,
      );
      assert.equal(
        (
          await post("/revoke", {
            client_id: client.client_id,
            token: next.refresh_token,
          })
        ).status,
        200,
      );
      await assert.rejects(authorizeConnection(`Bearer ${next.access_token}`));
      assert.ok(
        (
          await prisma.agentConnection.findUniqueOrThrow({
            where: { id: connectionId },
          })
        ).revokedAt,
      );
      assert.equal(
        await prisma.agentStoreLinkRequest.count({ where: { connectionId } }),
        0,
      );
      assert.equal(await prisma.connectionEmail.count({ where: { connectionId } }), 0);

      // Maintenance deletes a link unused for a year and an ended connection,
      // and keeps a connection that is still in use.
      const inUse = await prisma.agentConnection.create({
        data: {
          clientId: client.client_id,
          scopes: ["returns:read"],
          browserHash: "ci",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await prisma.agentStoreLink.create({
        data: {
          connectionId: inUse.id,
          shop,
          customerSubjectHash: "idle-customer",
          lastUsedAt: new Date(Date.now() - 366 * 86_400_000),
        },
      });
      const ended = await prisma.agentConnection.create({
        data: {
          clientId: client.client_id,
          scopes: ["returns:read"],
          browserHash: "ci",
          expiresAt: new Date(Date.now() - 1_000),
        },
      });
      await pruneExpiredCustomerAccess();
      assert.equal(
        await prisma.agentStoreLink.count({ where: { connectionId: inUse.id } }),
        0,
      );
      assert.ok(
        await prisma.agentConnection.findUnique({ where: { id: inUse.id } }),
      );
      assert.equal(
        await prisma.agentConnection.findUnique({ where: { id: ended.id } }),
        null,
      );
    },
  );
  assert.equal(await prisma.agentReturn.count({ where: { shop } }), 0);
});
