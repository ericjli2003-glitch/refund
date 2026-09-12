import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  abstractFetch,
  setAbstractFetchFunc,
} from "@shopify/shopify-api/runtime";
import prisma from "../app/db.server";
import { handleMerchantProxy } from "../app/services/merchant-proxy-http.server";
import { action as returnAction } from "../app/routes/api.returns.$shop";
import { action as refundWebhookAction } from "../app/routes/webhooks.refunds";
import {
  finishCustomerLogin,
  getCustomerSession,
  startCustomerLogin,
} from "../app/services/customer-session.server";
import { readContinuation } from "../app/services/return-intake.server";
import { publicRatePolicy } from "../server/public-rate-limit";
import {
  digest,
  signQuote,
  verifyQuoteSignature,
} from "../app/services/customer-security.server";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Requires isolated local refund_ci PostgreSQL",
);
process.env.SHOPIFY_APP_URL = "https://refund.test";
const secret = process.env.SHOPIFY_API_SECRET!;
assert.ok(secret);

test("merchant proxy → MCP intake → customer verification → quote → existing Shopify execution", async (t) => {
  const shop = `proxy-ci-${randomUUID().slice(0, 8)}.myshopify.com`;
  const missingShop = `absent-${randomUUID().slice(0, 8)}.myshopify.com`;
  const proxyPath = "/apps/refund";
  const realFetch = globalThis.fetch;
  const realShopifyFetch = abstractFetch;
  const customerId = "gid://shopify/Customer/71";
  const orderId = "gid://shopify/Order/72";
  const lineItemId = "gid://shopify/LineItem/73";
  const returnId = "gid://shopify/Return/74";
  const refundId = "gid://shopify/Refund/75";
  let nonce = "";
  let challenge = "";
  let amount = "25.00";
  let approvalFails = false;
  let paymentStatus = "PENDING";
  const mutations: string[] = [];
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "fixture-key",
    alg: "RS256",
    use: "sig",
  };
  const issuer = `https://${shop}`;
  const orders = {
    customer: {
      id: customerId,
      orders: {
        nodes: [
          {
            id: orderId,
            name: "#1072",
            processedAt: new Date().toISOString(),
            returnInformation: {
              nonReturnableSummary: null,
              returnableLineItems: {
                nodes: [
                  {
                    quantity: 2,
                    lineItem: {
                      id: lineItemId,
                      presentmentTitle: "Test snowboard",
                      currentTotalPrice: {
                        amount: "50.00",
                        currencyCode: "CAD",
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };

  // Only Shopify boundaries are simulated. No app auth, quote, draft, MCP,
  // database or execution code is mocked, and no network call can reach Shopify.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (["127.0.0.1", "localhost"].includes(url.hostname))
      return realFetch(input, init);
    assert.equal(
      url.hostname,
      shop,
      `Unexpected external request: ${url.origin}`,
    );
    if (url.pathname === "/.well-known/openid-configuration")
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get("code"), "fixture-code");
      assert.equal(digest(form.get("code_verifier")!), challenge);
      return Response.json({
        access_token: "fixture-customer-token",
        expires_in: 3600,
        id_token: await new SignJWT({ nonce })
          .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
          .setIssuer(issuer)
          .setAudience(process.env.SHOPIFY_API_KEY!)
          .setSubject("customer-71")
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey),
      });
    }
    if (url.pathname === "/.well-known/customer-account-api")
      return Response.json({
        graphql_api: `${issuer}/customer/api/2026-07/graphql`,
      });
    const { query, variables } = (await request.json()) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (url.pathname === "/customer/api/2026-07/graphql") {
      assert.equal(
        request.headers.get("Authorization"),
        "fixture-customer-token",
      );
      if (query.includes("VerifyCustomerAccess"))
        return Response.json({ data: { customer: { id: customerId } } });
      if (query.includes("CustomerReturnableOrders"))
        return Response.json({ data: orders });
      if (query.includes("CalculateCustomerReturn"))
        return Response.json({
          data: {
            returnCalculate: {
              financialSummary: {
                returnTotalSet: {
                  presentmentMoney: {
                    amount: `-${amount}`,
                    currencyCode: "CAD",
                  },
                  shopMoney: { amount: `-${amount}`, currencyCode: "CAD" },
                },
              },
              returnLineItems: {
                nodes: [{ lineItem: { id: lineItemId }, quantity: 1 }],
              },
            },
          },
        });
      if (query.includes("RequestCustomerReturn")) {
        assert.equal(variables.orderId, orderId);
        mutations.push("orderRequestReturn");
        return Response.json({
          data: {
            orderRequestReturn: {
              return: { id: returnId, status: "REQUESTED" },
              userErrors: [],
            },
          },
        });
      }
    }
    if (url.pathname === "/admin/api/2026-07/graphql.json") {
      assert.equal(
        request.headers.get("X-Shopify-Access-Token"),
        "fixture-admin-token",
      );
      if (query.includes("ApproveReturnRequest")) {
        mutations.push("returnApproveRequest");
        return Response.json({
          data: {
            returnApproveRequest: {
              return: approvalFails
                ? null
                : { id: returnId, status: "OPEN", order: { id: orderId } },
              userErrors: approvalFails
                ? [{ message: "Fixture approval failure" }]
                : [],
            },
          },
        });
      }
      if (query.includes("SuggestedRefund"))
        return Response.json({
          data: {
            order: {
              suggestedRefund: {
                amountSet: {
                  presentmentMoney: { amount, currencyCode: "CAD" },
                },
                suggestedTransactions: [
                  {
                    amountSet: {
                      presentmentMoney: { amount, currencyCode: "CAD" },
                    },
                    gateway: "bogus",
                    parentTransaction: {
                      id: "gid://shopify/OrderTransaction/76",
                      gateway: "bogus",
                      manualPaymentGateway: false,
                    },
                  },
                ],
              },
            },
          },
        });
      if (query.includes("CreateAutomaticRefund")) {
        assert.match(query, /@idempotent/);
        assert.ok(variables.idempotencyKey);
        const refund = variables.input as {
          orderId: string;
          transactions: { parentId: string; amount: string }[];
        };
        assert.equal(refund.orderId, orderId);
        assert.equal(refund.transactions[0].amount, amount);
        assert.equal(
          refund.transactions[0].parentId,
          "gid://shopify/OrderTransaction/76",
        );
        mutations.push("refundCreate");
        return Response.json({
          data: { refundCreate: { refund: {
            id: refundId,
            transactions: { nodes: [{ kind: "REFUND", status: paymentStatus }], pageInfo: { hasNextPage: false } },
          }, userErrors: [] } },
        });
      }
    }
    throw new Error(`Unexpected Shopify fixture operation: ${url.pathname}`);
  };

  // The Shopify Node adapter captures fetch at import time, separately from the
  // Customer Account API. Intercept that boundary as well, before any request.
  setAbstractFetchFunc(globalThis.fetch);

  function signedRequest(
    path: string,
    body?: unknown,
    overrides: Record<string, string> = {},
  ) {
    const url = new URL(`/proxy/refund/${path}`, "https://refund.test");
    const params = {
      shop,
      logged_in_customer_id: "",
      path_prefix: proxyPath,
      timestamp: String(Math.floor(Date.now() / 1000)),
      ...overrides,
    };
    const message = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("");
    url.search = new URLSearchParams({
      ...params,
      signature: createHmac("sha256", secret).update(message).digest("hex"),
    }).toString();
    return new Request(
      url,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(body),
          },
    );
  }

  // The fixture models the merchant's root redirect and Shopify's signing hop.
  // It is not evidence that a live merchant installed either configuration.
  const app = express();
  app.get("/agents.md", (_req, res) =>
    res.redirect(301, `${proxyPath}/agents.md`),
  );
  app.use(express.json());
  app.all(`${proxyPath}/*`, (req, res, next) => {
    const path = req.path.slice(proxyPath.length + 1);
    void handleMerchantProxy(
      signedRequest(path, req.method === "POST" ? req.body : undefined),
      path,
    )
      .then(async (response) => {
        res.status(response.status);
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.send(await response.text());
      })
      .catch(next);
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  await prisma.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: "fixture",
      isOnline: false,
      accessToken: "fixture-admin-token",
      scope:
        "read_orders,write_orders,read_returns,write_returns,write_app_proxy",
    },
  });
  await prisma.storePolicy.create({
    data: {
      shop,
      automaticRefundsEnabled: true,
      currencyCode: "CAD",
      maxAutoRefundAmount: "100.00",
      returnWindowDays: 30,
    },
  });
  t.after(async () => {
    globalThis.fetch = realFetch;
    setAbstractFetchFunc(realShopifyFetch);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$transaction([
      prisma.customerReturnSession.deleteMany({ where: { shop } }),
      prisma.returnDraft.deleteMany({ where: { shop } }),
      prisma.agentReturn.deleteMany({ where: { shop } }),
      prisma.webhookReceipt.deleteMany({ where: { shop } }),
      prisma.storePolicy.deleteMany({ where: { shop } }),
      prisma.session.deleteMany({ where: { shop } }),
    ]);
    await prisma.$disconnect();
  });

  await t.test(
    "signed merchant discovery is tenant-bound, read-only, and works with a custom proxy prefix",
    async () => {
      const response = await fetch(`${base}/agents.md`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Content-Type")!, /text\/markdown/);
      const markdown = await response.text();
      assert.ok(markdown.includes(`https://${shop}${proxyPath}/mcp`));
      assert.ok(markdown.includes("No Refund plugin or connector required"));
      const manifest = await (
        await fetch(`${base}${proxyPath}/manifest.json`)
      ).json();
      assert.equal(manifest.merchant.shop, shop);
      assert.equal(manifest.browser.connectorRequired, false);
      assert.equal(manifest.ucp.standardizedReturnMutation, false);
      const schema = await (
        await fetch(`${base}${proxyPath}/schema.json`)
      ).json();
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.merchant, undefined);
      assert.equal(
        (
          await fetch(`${base}${proxyPath}/agents.md`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        405,
      );
      const custom = await handleMerchantProxy(
        signedRequest("manifest.json", undefined, {
          path_prefix: "/tools/returns",
        }),
        "manifest.json",
      );
      assert.equal(
        (await custom.json()).mcp.endpoint,
        `https://${shop}/tools/returns/mcp`,
      );
      const html = await (
        await fetch(`${base}${proxyPath}/start-return`)
      ).text();
      assert.ok(html.includes(`href="https://refund.test/returns/${shop}"`));
      assert.ok(!html.includes("<iframe"));
      assert.equal(await prisma.returnDraft.count({ where: { shop } }), 0);
      assert.equal(mutations.length, 0);
      assert.deepEqual(
        publicRatePolicy("/proxy/refund/mcp.data"),
        publicRatePolicy("/mcp"),
      );
      assert.deepEqual(publicRatePolicy("/%70roxy/refund/mcp"), publicRatePolicy("/mcp"));
    },
  );

  await t.test(
    "forged, missing, stale, duplicated, uninstalled and cross-merchant inputs fail closed",
    async () => {
      const unsigned = await handleMerchantProxy(
        new Request(`https://refund.test/proxy/refund/agents.md?shop=${shop}`),
        "agents.md",
      );
      assert.equal(unsigned.status, 400);
      const invalidParameters: Record<string, string>[] = [
        { timestamp: "NaN" },
        { shop: "evil.test" },
        { timestamp: "1000000000" },
        { path_prefix: "//evil.test/path" },
      ];
      for (const overrides of invalidParameters) {
        assert.equal(
          (
            await handleMerchantProxy(
              signedRequest("agents.md", undefined, overrides),
              "agents.md",
            )
          ).status,
          400,
        );
      }
      const forged = new URL(signedRequest("agents.md").url);
      forged.searchParams.set("shop", missingShop);
      assert.equal(
        (await handleMerchantProxy(new Request(forged), "agents.md")).status,
        400,
      );
      const duplicate = new URL(signedRequest("agents.md").url);
      duplicate.searchParams.append("shop", missingShop);
      assert.equal(
        (await handleMerchantProxy(new Request(duplicate), "agents.md")).status,
        400,
      );
      assert.equal(
        (
          await handleMerchantProxy(
            signedRequest("agents.md", undefined, { shop: missingShop }),
            "agents.md",
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await handleMerchantProxy(
            signedRequest("start-return", { merchant: missingShop }),
            "start-return",
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await handleMerchantProxy(
            signedRequest(
              "confirm",
              { customerConfirmed: true },
              { logged_in_customer_id: "71" },
            ),
            "confirm",
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await handleMerchantProxy(
            signedRequest("start-return", { itemName: "x".repeat(17000) }),
            "start-return",
          )
        ).status,
        413,
      );
      assert.equal(mutations.length, 0);
    },
  );

  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${base}${proxyPath}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  let continuationUrl = "";
  let draftId = "";
  await t.test(
    "real MCP transport discovers shop-bound intake and reuses one idempotent draft",
    async () => {
      assert.ok(
        (
          await rpc("initialize", {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "local-proof", version: "1" },
          })
        ).result,
      );
      const tools = (await rpc("tools/list")).result.tools;
      assert.deepEqual(
        tools.map((tool: { name: string }) => tool.name),
        ["start_return"],
      );
      assert.equal(tools[0].inputSchema.properties.merchant, undefined);
      assert.equal(tools[0].inputSchema.additionalProperties, false);
      const bad = await rpc("tools/call", {
        name: "start_return",
        arguments: { merchant: missingShop },
      });
      assert.ok(bad.error || bad.result?.isError);
      const input = {
        itemName: "Test snowboard",
        idempotencyKey: randomUUID(),
      };
      const first = (
        await rpc("tools/call", { name: "start_return", arguments: input })
      ).result.structuredContent;
      const again = (
        await rpc("tools/call", { name: "start_return", arguments: input })
      ).result.structuredContent;
      assert.equal(first.merchant.shop, shop);
      assert.equal(first.correlationId, again.correlationId);
      const rest = await fetch(`${base}${proxyPath}/start-return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      assert.equal(rest.status, 200);
      assert.equal((await rest.json()).correlationId, first.correlationId);
      const conflict = await fetch(`${base}${proxyPath}/start-return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, itemName: "Different item" }),
      });
      assert.equal(conflict.status, 409);
      assert.equal(first.returnSubmitted, false);
      continuationUrl = first.continueUrl;
      draftId = readContinuation(
        new URL(continuationUrl).searchParams.get("continuation")!,
        shop,
      ).draftId!;
      assert.equal(await prisma.returnDraft.count({ where: { shop } }), 1);
      assert.equal(mutations.length, 0);
    },
  );

  let cookie = "";
  let csrf = "";
  await t.test(
    "customer OIDC state, PKCE, nonce and signature establish the existing browser session",
    async () => {
      const login = new URL("https://refund.test/customer/login");
      login.searchParams.set("shop", shop);
      login.searchParams.set(
        "continuation",
        new URL(continuationUrl).searchParams.get("continuation")!,
      );
      const pending = await startCustomerLogin(new Request(login));
      const authUrl = new URL(pending.headers.get("Location")!);
      nonce = authUrl.searchParams.get("nonce")!;
      challenge = authUrl.searchParams.get("code_challenge")!;
      const pendingCookie = pending.headers.get("Set-Cookie")!.split(";")[0];
      const callback = new URL("https://refund.test/customer/callback");
      callback.searchParams.set("state", "wrong-state");
      callback.searchParams.set("code", "fixture-code");
      await assert.rejects(
        () =>
          finishCustomerLogin(
            new Request(callback, { headers: { Cookie: pendingCookie } }),
          ),
        (error) => error instanceof Response && error.status === 400,
      );
      callback.searchParams.set("state", authUrl.searchParams.get("state")!);
      const finished = await finishCustomerLogin(
        new Request(callback, { headers: { Cookie: pendingCookie } }),
      );
      assert.equal(finished.status, 302);
      cookie = finished.headers.get("Set-Cookie")!.split(";")[0];
      const session = await getCustomerSession(
        new Request("https://refund.test", { headers: { Cookie: cookie } }),
        shop,
      );
      assert.ok(session);
      assert.equal(session.draftId, draftId);
      csrf = session.csrfToken;
      await assert.rejects(
        () =>
          finishCustomerLogin(
            new Request(callback, { headers: { Cookie: pendingCookie } }),
          ),
        (error) => error instanceof Response && error.status === 400,
      );
      assert.equal(mutations.length, 0);
    },
  );
  const portal = (
    operation: string,
    input: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) =>
    returnAction({
      request: new Request(`https://refund.test/api/returns/${shop}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://refund.test",
          Cookie: cookie,
          "X-Return-CSRF": csrf,
          ...headers,
        },
        body: JSON.stringify({ operation, ...input }),
      }),
      params: { shop },
      context: {},
      url: new URL(`https://refund.test/api/returns/${shop}`),
      pattern: "/api/returns/:shop",
    });
  let quoteToken = "";
  await t.test(
    "ownership, CSRF, quote binding, expiry and exact consent guard execution",
    async () => {
      assert.equal((await portal("list", {}, { Cookie: "" })).status, 401);
      await assert.rejects(
        () => portal("list", {}, { "X-Return-CSRF": "bad" }),
        (error) => error instanceof Response && error.status === 403,
      );
      await assert.rejects(
        () => portal("list", {}, { Origin: "https://evil.test" }),
        (error) => error instanceof Response && error.status === 403,
      );
      assert.equal(
        (
          await portal("quote", {
            orderId: "gid://shopify/Order/999",
            items: [{ lineItemId, quantity: 1 }],
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await portal("quote", {
            orderId,
            items: [{ lineItemId, quantity: 3 }],
          })
        ).status,
        400,
      );
      const quoted = await portal("quote", {
        orderId,
        items: [{ lineItemId, quantity: 1 }],
      });
      assert.equal(quoted.status, 200);
      const { quote } = await quoted.json();
      quoteToken = quote.quoteToken;
      assert.deepEqual(quote.expectedRefund, {
        amount: "25.00",
        currencyCode: "CAD",
      });
      assert.equal(
        (await portal("confirm", { quoteToken, customerConfirmed: false }))
          .status,
        400,
      );
      assert.equal(
        (
          await portal("confirm", {
            quoteToken: `${quoteToken}x`,
            customerConfirmed: true,
          })
        ).status,
        400,
      );
      const signed = verifyQuoteSignature(quoteToken) as Record<
        string,
        unknown
      >;
      for (const changes of [
        { subject: "another-customer" },
        { shop: missingShop },
        { expiresAt: Date.now() - 1 },
      ]) {
        assert.equal(
          (
            await portal("confirm", {
              quoteToken: signQuote({ ...signed, ...changes }),
              customerConfirmed: true,
            })
          ).status,
          400,
        );
      }
      amount = "26.00";
      assert.equal(
        (await portal("confirm", { quoteToken, customerConfirmed: true }))
          .status,
        400,
      );
      amount = "25.00";
      assert.equal(mutations.length, 0);
    },
  );
  await t.test(
    "explicit confirmation reaches Customer and Admin APIs once; retry/status never duplicates payment",
    async () => {
      const confirmed = await portal("confirm", {
        quoteToken,
        customerConfirmed: true,
      });
      assert.equal(confirmed.status, 200, await confirmed.clone().text());
      const { result } = await confirmed.json();
      assert.equal(result.status, "REFUND_SUBMITTED");
      assert.equal(result.refundStatus, "PENDING");
      assert.equal(result.paymentMethod, "Original payment method");
      assert.match(result.message, /not yet confirmed/);
      assert.equal(result.returnId, returnId);
      assert.equal(result.refundId, refundId);
      assert.deepEqual(mutations, [
        "orderRequestReturn",
        "returnApproveRequest",
        "refundCreate",
      ]);
      const retry = await portal("confirm", {
        quoteToken,
        customerConfirmed: true,
      });
      assert.equal(retry.status, 200, await retry.clone().text());
      const status = await (await portal("status")).json();
      assert.ok(JSON.stringify(status).includes("REFUND_SUBMITTED"));
      assert.equal(status.session.submissions[0].refundStatus, "PENDING");
      assert.match(status.session.submissions[0].message, /not yet confirmed/);
      assert.equal(mutations.length, 3);
      assert.equal(await prisma.agentReturn.count({ where: { shop } }), 1);
      assert.equal(
        await prisma.agentAccessGrant.count({ where: { shop } }),
        0,
        "No Refund connector/agent grant was needed",
      );
    },
  );
  await t.test(
    "merchant policy remains authoritative; partial upstream failure is recorded and not blindly retried",
    async () => {
      await prisma.storePolicy.update({
        where: { shop },
        data: { automaticRefundsEnabled: false },
      });
      const { quote } = await (
        await portal("quote", { orderId, items: [{ lineItemId, quantity: 1 }] })
      ).json();
      assert.equal(quote.submissionAvailable, false);
      assert.equal(
        (
          await portal("confirm", {
            quoteToken: quote.quoteToken,
            customerConfirmed: true,
          })
        ).status,
        400,
      );
      assert.equal(mutations.length, 3);
      await prisma.storePolicy.update({
        where: { shop },
        data: { automaticRefundsEnabled: true },
      });
      const next = await (
        await portal("quote", { orderId, items: [{ lineItemId, quantity: 1 }] })
      ).json();
      approvalFails = true;
      assert.equal(
        (
          await portal("confirm", {
            quoteToken: next.quote.quoteToken,
            customerConfirmed: true,
          })
        ).status,
        400,
      );
      assert.deepEqual(mutations.slice(3), [
        "orderRequestReturn",
        "returnApproveRequest",
      ]);
      const retry = await portal("confirm", {
        quoteToken: next.quote.quoteToken,
        customerConfirmed: true,
      });
      assert.equal(retry.status, 200, await retry.clone().text());
      assert.equal(mutations.length, 5);
      assert.equal(
        await prisma.agentReturn.count({
          where: { shop, status: "NEEDS_ATTENTION" },
        }),
        1,
      );
    },
  );
  await t.test("processor failure retains the refund ID and blocks a second payment on retry", async () => {
    approvalFails = false;
    paymentStatus = "FAILURE";
    const next = await (await portal("quote", { orderId, items: [{ lineItemId, quantity: 2 }] })).json();
    const before = mutations.length;
    const request = { quoteToken: next.quote.quoteToken, customerConfirmed: true };
    const response = await portal("confirm", request);
    assert.equal(response.status, 200, await response.clone().text());
    const { result } = await response.json();
    assert.equal(result.status, "NEEDS_ATTENTION");
    assert.equal(result.refundStatus, "FAILED");
    assert.equal(result.refundId, refundId);
    assert.match(result.message, /do not submit another/);
    assert.equal(mutations.length, before + 3);
    await portal("confirm", request);
    assert.equal(mutations.length, before + 3);
  });
  await t.test("refund webhooks preserve failures and never downgrade successful processor evidence", async () => {
    async function webhook(status: string, webhookId = randomUUID()) {
      const body = JSON.stringify({
        admin_graphql_api_id: refundId,
        transactions: [{ kind: "refund", status }],
      });
      return refundWebhookAction({
        url: new URL("https://refund.test/webhooks/refunds"),
        pattern: "/webhooks/refunds",
        request: new Request("https://refund.test/webhooks/refunds", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Shop-Domain": shop,
            "X-Shopify-Topic": "refunds/create",
            "X-Shopify-Webhook-Id": webhookId,
            "X-Shopify-API-Version": "2026-07",
            "X-Shopify-Hmac-Sha256": createHmac("sha256", secret).update(body).digest("base64"),
          },
          body,
        }),
        params: {},
        context: {},
      });
    }
    const event = randomUUID();
    assert.equal((await webhook("success", event)).status, 200);
    assert.equal((await webhook("success", event)).status, 200);
    await webhook("pending");
    const records = await prisma.agentReturn.findMany({ where: { shop, refundId } });
    assert.equal(records.filter((record) => record.refundStatus === "SUCCESS").length, 1);
    assert.equal(records.filter((record) => record.status === "NEEDS_ATTENTION" && record.refundStatus === "FAILED").length, 1);
    assert.equal(await prisma.webhookReceipt.count({ where: { id: event } }), 1);
    const status = await (await portal("status")).json();
    assert.ok(status.session.submissions.some((record: { message: string }) => /bank may still take time/.test(record.message)));
  });
});
