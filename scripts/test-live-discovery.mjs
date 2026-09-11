import assert from "node:assert/strict";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const app = new URL(process.env.REFUND_TEST_APP_URL || "");
const shop = process.env.REFUND_TEST_SHOP || "";
assert.equal(app.protocol, "https:", "REFUND_TEST_APP_URL must be HTTPS");
assert.ok(
  !app.username &&
    !app.password &&
    !app.search &&
    !app.hash &&
    app.pathname === "/",
  "Use an app origin without credentials or paths",
);
assert.match(
  shop,
  /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/,
  "REFUND_TEST_SHOP must name the installed merchant",
);
const request = (path, options = {}) =>
  fetch(new URL(path, app), {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
const rpc = async (method, params = {}) => {
  const response = await request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200, `${method} HTTP status`);
  const body = await response.json();
  assert.ok(!body.error, `${method} returned a protocol error`);
  return body.result;
};

assert.equal((await request("/health")).status, 200);
const metadata = await request("/.well-known/oauth-authorization-server");
assert.equal(metadata.status, 200);
const issuer = await metadata.json();
assert.equal(issuer.issuer, app.origin);
assert.equal(issuer.authorization_endpoint, `${app.origin}/authorize`);
assert.ok(issuer.code_challenge_methods_supported.includes("S256"));
const resource = await request(`/oauth/resource/${shop}`);
assert.equal(resource.status, 200);
const resourceInfo = await resource.json();
assert.equal(resourceInfo.resource, `${app.origin}/mcp/${shop}`);
assert.deepEqual(resourceInfo.authorization_servers, [app.origin]);
const denied = await request(`/mcp/${shop}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(denied.status, 401);
assert.match(
  denied.headers.get("WWW-Authenticate") || "",
  /resource_metadata=/,
);
const preflight = await request("/api/return-intake", {
  method: "OPTIONS",
  headers: {
    Origin: `https://${shop}`,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
  },
});
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
await rpc("initialize", {
  protocolVersion: LATEST_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "refund-discovery-check", version: "1.0.0" },
});
const list = await rpc("tools/list");
assert.deepEqual(
  list.tools.map((tool) => tool.name),
  ["start_return"],
);
console.log(
  "Live health, OAuth metadata, protected MCP challenge, browser preflight and anonymous tool discovery passed.",
);
console.log(
  "No tool was invoked, client registered, customer signed in, draft created or return/refund submitted. Host sign-in and quote acceptance remain separate.",
);
