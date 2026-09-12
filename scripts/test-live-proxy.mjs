import assert from "node:assert/strict";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const shop = process.env.REFUND_TEST_SHOP || "";
assert.match(shop, /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);
function origin(value) {
  const url = new URL(value);
  assert.ok(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "Use HTTPS origins without paths or credentials",
  );
  return url.origin;
}
const storefront = origin(
  process.env.REFUND_TEST_STOREFRONT_URL || `https://${shop}`,
);
const app = origin(process.env.REFUND_TEST_APP_URL || "");
const prefix = process.env.REFUND_TEST_PROXY_PATH || "/apps/refund";
assert.match(prefix, /^\/(apps|a|community|tools)\/[a-zA-Z0-9_-]+$/);
const allowedOrigins = new Set([storefront, `https://${shop}`]);
async function request(url, options = {}) {
  // Follow only same-merchant GET redirects, never arbitrary manifest URLs.
  for (let count = 0; count < 5; count++) {
    assert.ok(allowedOrigins.has(new URL(url).origin));
    assert.notEqual(
      new URL(url).pathname,
      "/password",
      "The storefront password wall blocks public agent discovery. Leave it unchanged unless the merchant authorizes changing access.",
    );
    const response = await fetch(url, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    assert.ok(
      !options.method || options.method === "GET",
      "MCP endpoint must not redirect POST",
    );
    assert.ok(response.headers.get("Location"));
    url = new URL(response.headers.get("Location"), url).href;
  }
  throw new Error("Too many merchant redirects");
}

const root = await request(`${storefront}/agents.md`);
assert.equal(
  root.status,
  200,
  "Publish the merchant /agents.md guide or redirect first",
);
const guide = await root.text();
assert.ok(
  guide.includes(`${prefix}/manifest.json`),
  "Root guide must link to Refund's merchant proxy manifest",
);
const manifestResponse = await request(`${storefront}${prefix}/manifest.json`);
assert.equal(
  manifestResponse.status,
  200,
  "Deploy the Refund backend and Shopify app proxy; approve write_app_proxy",
);
assert.match(
  manifestResponse.headers.get("Content-Type") || "",
  /application\/json/,
);
const manifest = await manifestResponse.json();
assert.equal(manifest.kind, "refund_merchant_return_handoff");
assert.equal(manifest.merchant.shop, shop);
assert.equal(manifest.browser.connectorRequired, false);
assert.equal(manifest.browser.portalUrl, `${app}/returns/${shop}`);
assert.equal(manifest.mcp.endpoint, `https://${shop}${prefix}/mcp`);
assert.equal(manifest.ucp.standardizedReturnMutation, false);
const page = await request(`${storefront}${prefix}/start-return`);
assert.equal(page.status, 200);
assert.ok(
  (await page.text()).includes(`href="${app}/returns/${shop}"`),
  "Proxy must link out to the top-level portal, not proxy its cookies",
);
const rpc = async (method, params = {}) => {
  const response = await request(manifest.mcp.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(
    response.status,
    200,
    `${method} must work through the real Shopify forwarding hop`,
  );
  const payload = await response.json();
  assert.ok(!payload.error);
  return payload.result;
};
await rpc("initialize", {
  protocolVersion: LATEST_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "refund-read-only-proxy-check", version: "1" },
});
const { tools } = await rpc("tools/list");
assert.deepEqual(
  tools.map((tool) => tool.name),
  ["start_return"],
);
assert.equal(tools[0].inputSchema.properties.merchant, undefined);
console.log(
  "PASS: merchant /agents.md → real Shopify App Proxy → Refund manifest, browser handoff and shop-bound MCP discovery.",
);
console.log(
  "No intake tool, login, return or refund was executed. This verifies deployment, not automatic ChatGPT/Claude discovery or customer-authorized execution.",
);
