import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { createHmac, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Production smoke test requires the isolated refund_ci database",
);
const prisma = new PrismaClient();
const shop = `http-${randomUUID()}.myshopify.com`;
const merchantName = `Smoke ${randomUUID()}`;
const server = spawn(process.execPath, ["build/http/index.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: "3037",
    SHOPIFY_APP_URL: "https://refund.test",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (chunk) => {
    output = (output + chunk).slice(-8000);
  });
const closed = once(server, "close");
try {
  let health;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try {
      health = await fetch("http://127.0.0.1:3037/health", {
        signal: AbortSignal.timeout(1000),
      });
      if (health.ok) break;
    } catch {
      /* Startup may still be loading the application. */
    }
    await setTimeout(250);
  }
  assert.equal(health?.status, 200, output);
  await prisma.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: "test",
      isOnline: false,
      accessToken: "private-smoke-token-never-sent",
    },
  });
  await prisma.merchantDirectory.create({
    data: {
      shop,
      primaryDomain: shop,
      name: merchantName,
      aliases: [merchantName.toLowerCase()],
      discoveryPublished: false,
    },
  });
  // Customer connector onboarding is public metadata only, not authorization.
  const connectPage = await fetch(`http://127.0.0.1:3037/connect/${shop}`);
  assert.equal(connectPage.status, 200);
  assert.match(connectPage.headers.get("Cache-Control") || "", /no-store/);
  assert.match(
    connectPage.headers.get("Content-Security-Policy") || "",
    /frame-ancestors 'none'/,
  );
  const connectHtml = await connectPage.text();
  // Store setup pages lead to the one connection for every store.
  assert.ok(connectHtml.includes("https://refund.test/mcp/stores"));
  assert.ok(
    connectHtml.includes("Connect your assistant to Gooper.io for every store."),
  );
  assert.ok(!connectHtml.includes(`https://refund.test/mcp/${shop}`));
  assert.ok(!connectHtml.includes("private-smoke-token-never-sent"));
  // Any store setup address, even a malformed or uninstalled one, sends the
  // customer to the connection for every store rather than an error.
  for (const path of [
    "/connect/not-a-shop",
    `/connect/missing-${randomUUID()}.myshopify.com`,
  ]) {
    const moved = await fetch(`http://127.0.0.1:3037${path}`, {
      redirect: "manual",
    });
    assert.equal(moved.status, 302, path);
    assert.equal(new URL(moved.headers.get("Location"), "http://x").pathname, "/connect");
  }
  assert.equal(await prisma.agentAccessGrant.count({ where: { shop } }), 0);
  assert.equal(await prisma.agentOAuthRequest.count({ where: { shop } }), 0);

  // Exercise the built React Router splat route, not only imported handlers.
  const proxyParams = {
    shop,
    logged_in_customer_id: "",
    path_prefix: "/apps/refund",
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const signature = createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(
      Object.entries(proxyParams)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join(""),
    )
    .digest("hex");
  const proxyQuery = new URLSearchParams({ ...proxyParams, signature });
  const proxyUrl = `http://127.0.0.1:3037/proxy/refund/agents.md?${proxyQuery}`;
  const agentGuide = await fetch(proxyUrl);
  assert.equal(agentGuide.status, 200);
  assert.match(agentGuide.headers.get("Content-Type"), /text\/markdown/);
  assert.ok(
    (await agentGuide.text()).includes(`https://${shop}/apps/refund/mcp`),
  );
  assert.equal(
    (await fetch("http://127.0.0.1:3037/proxy/refund/agents.md")).status,
    400,
  );
  const proxyManifest = await (
    await fetch(
      `http://127.0.0.1:3037/proxy/refund/manifest.json?${proxyQuery}`,
    )
  ).json();
  assert.equal(proxyManifest.merchant.shop, shop);
  assert.equal(proxyManifest.browser.connectorRequired, false);
  const proxyMcp = await fetch(
    `http://127.0.0.1:3037/proxy/refund/mcp?${proxyQuery}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    },
  );
  assert.equal(proxyMcp.status, 200);
  assert.deepEqual(
    (await proxyMcp.json()).result.tools.map((tool) => tool.name),
    ["start_return"],
  );
  const profileUrl = `http://127.0.0.1:3037/stores/${shop}`;
  assert.equal(
    (await fetch(profileUrl)).status,
    404,
    "Unpublished profiles must not be public",
  );
  await prisma.merchantDirectory.update({
    where: { shop },
    data: { discoveryPublished: true },
  });
  const profile = await fetch(profileUrl);
  assert.equal(profile.status, 200);
  const html = await profile.text();
  assert.ok(html.includes(`${merchantName} returns`));
  assert.ok(html.includes("data-refund-site-tools"));
  assert.ok(html.includes("/store-tools.js"));
  assert.ok(!html.includes("private-smoke-token-never-sent"));
  const directory = await fetch(
    `http://127.0.0.1:3037/stores?q=${encodeURIComponent(merchantName)}`,
  );
  assert.equal(directory.status, 200);
  assert.ok((await directory.text()).includes(`/stores/${shop}`));
  const lookupUrl = `http://127.0.0.1:3037/api/merchants?query=${encodeURIComponent(merchantName.toUpperCase())}`;
  const lookup = await (await fetch(lookupUrl)).json();
  assert.equal(lookup.status, "matched");
  assert.equal(
    lookup.merchants[0].returnPage,
    `https://refund.test/stores/${shop}`,
  );
  const reportingUrl = "http://127.0.0.1:3037/api/merchant-discovery-failure";
  const beforeDrafts = await prisma.returnDraft.count();
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = await fetch(reportingUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchant: merchantName }),
    });
    assert.equal(report.status, 202);
    const stopped = await report.json();
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.returnSubmitted, false);
    assert.equal(stopped.refundSubmitted, false);
    assert.doesNotMatch(
      JSON.stringify(stopped),
      /merchantLabel|knownShop|opportunity|continueUrl/i,
    );
  }
  const opportunities = await prisma.merchantOpportunity.findMany({
    where: { merchantLabel: merchantName },
  });
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].kind, "DISCOVERY_GAP");
  assert.equal(opportunities[0].knownShop, shop);
  assert.equal(await prisma.returnDraft.count(), beforeDrafts);
  assert.equal((await fetch(reportingUrl)).status, 405);
  const invalidReport = await fetch(reportingUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      merchant: merchantName,
      email: "private@example.com",
    }),
  });
  assert.equal(invalidReport.status, 400);
  const formLookup = await fetch("http://127.0.0.1:3037/stores", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "http://127.0.0.1:3037",
    },
    body: new URLSearchParams({ q: merchantName }).toString(),
  });
  assert.equal(formLookup.status, 200);
  assert.ok((await formLookup.text()).includes(`/stores/${shop}`));
  const script = await fetch("http://127.0.0.1:3037/store-tools.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.match(await script.text(), /start_return/);
  assert.ok(
    (await (await fetch("http://127.0.0.1:3037/sitemap.xml")).text()).includes(
      `/stores/${shop}`,
    ),
  );
  assert.match(
    await (await fetch("http://127.0.0.1:3037/robots.txt")).text(),
    /Disallow: \/returns\//,
  );
  await prisma.session.deleteMany({ where: { shop } });
  assert.equal(
    (await fetch(proxyUrl)).status,
    404,
    "Uninstalled proxies must not advertise capability",
  );
  assert.equal(
    (await fetch(profileUrl)).status,
    404,
    "Uninstalled profiles must not be public",
  );
  assert.equal((await (await fetch(lookupUrl)).json()).status, "not_found");
  assert.ok(
    !(await (await fetch("http://127.0.0.1:3037/sitemap.xml")).text()).includes(
      `/stores/${shop}`,
    ),
  );
  const metadata = await fetch(
    "http://127.0.0.1:3037/.well-known/oauth-authorization-server",
  );
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).issuer, "https://refund.test");
  for (const path of [
    "/api/return-intake",
    "/mcp",
    "/api/merchant-discovery-failure",
  ]) {
    const preflight = await fetch(`http://127.0.0.1:3037${path}`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://testing-bl7vdfur.myshopify.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(
      preflight.status,
      204,
      `${path} must accept browser preflight`,
    );
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
    assert.match(
      preflight.headers.get("access-control-allow-headers"),
      /Content-Type/i,
    );
    assert.equal((await fetch(`http://127.0.0.1:3037${path}`)).status, 405);
  }
  const protectedResponse = await fetch(
    "http://127.0.0.1:3037/mcp/unconnected.myshopify.com",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    },
  );
  assert.equal(protectedResponse.status, 401);
  assert.match(
    protectedResponse.headers.get("WWW-Authenticate"),
    /resource_metadata=/,
  );
  let limited;
  for (let attempt = 0; attempt < 121; attempt++) {
    limited = await fetch("http://127.0.0.1:3037/api/return-intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}", // Invalid input: no draft, customer lookup, or Shopify action.
    });
    if (limited.status === 429) break;
    assert.equal(limited.status, 400);
    await limited.arrayBuffer();
  }
  assert.equal(limited.status, 429, "Production must mount the shared limiter");
  assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  assert.equal(
    (
      await fetch("http://127.0.0.1:3037/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    429,
    "Switching intake transports must not reset the quota",
  );
  assert.equal(
    (
      await fetch("http://127.0.0.1:3037/api/return-intake", {
        method: "OPTIONS",
      })
    ).status,
    204,
    "An exhausted quota must not block browser preflight",
  );
  assert.equal(
    (await fetch("http://127.0.0.1:3037/start-return.data")).status,
    429,
    "Single-fetch navigation must share the browser intake quota",
  );
  assert.equal(
    (await fetch(proxyUrl)).status,
    429,
    "Proxy traffic must share the intake quota",
  );
  assert.equal(
    (await fetch("http://127.0.0.1:3037/%70roxy/refund/agents.md")).status,
    429,
    "Encoded route characters must not bypass the proxy quota",
  );
  console.log(
    "Production HTTP startup, discovery, MCP challenge, shared intake rate limits and browser preflight passed.",
  );
} finally {
  server.kill("SIGTERM");
  await closed;
  await prisma.merchantOpportunity.deleteMany({
    where: { merchantLabel: merchantName },
  });
  await prisma.merchantDirectory.deleteMany({ where: { shop } });
  await prisma.session.deleteMany({ where: { shop } });
  await prisma.$disconnect();
}
