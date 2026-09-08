import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";

const database = new URL(process.env.DATABASE_URL || "");
assert.ok(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    database.pathname === "/refund_ci",
  "Production smoke test requires the isolated refund_ci database",
);
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
  const metadata = await fetch(
    "http://127.0.0.1:3037/.well-known/oauth-authorization-server",
  );
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).issuer, "https://refund.test");
  for (const path of ["/api/return-intake", "/mcp"]) {
    const preflight = await fetch(`http://127.0.0.1:3037${path}`, {
      method: "OPTIONS",
      headers: { Origin: "https://testing-bl7vdfur.myshopify.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    assert.equal(preflight.status, 204, `${path} must accept browser preflight`);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
    assert.match(preflight.headers.get("access-control-allow-headers"), /Content-Type/i);
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
  console.log(
    "Production HTTP startup, database health, OAuth discovery and MCP challenge passed.",
  );
} finally {
  server.kill("SIGTERM");
  await closed;
}
