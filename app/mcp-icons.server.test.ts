import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { gooperMcpIcons } from "./mcp-icons.server";

// Other test files depend on SHOPIFY_APP_URL, so each test restores the value
// it found exactly once, however many times it changes it.
function restoreAppUrlAfter(t: TestContext) {
  const original = process.env.SHOPIFY_APP_URL;
  t.after(() => {
    if (original === undefined) delete process.env.SHOPIFY_APP_URL;
    else process.env.SHOPIFY_APP_URL = original;
  });
}

function setAppUrl(value: string | undefined) {
  if (value === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = value;
}

// What a connecting assistant is actually told.
async function advertisedIcons(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "icon-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const icons = client.getServerVersion()?.icons;
  await client.close();
  return icons;
}

test("the icon is served from the app's own origin, PNG first", (t) => {
  restoreAppUrlAfter(t);
  setAppUrl("https://gooper.io");
  assert.deepEqual(gooperMcpIcons(), [
    { src: "https://gooper.io/gooper-icon.png", mimeType: "image/png", sizes: ["512x512"] },
    { src: "https://gooper.io/gooper-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
  ]);
});

test("without an HTTPS origin the servers start with no icon instead of failing", (t) => {
  restoreAppUrlAfter(t);
  for (const value of [undefined, "", "http://gooper.io", "not a url"]) {
    setAppUrl(value);
    assert.equal(gooperMcpIcons(), undefined);
  }
});

test("both MCP servers advertise the icon to connecting assistants", async (t) => {
  process.env.SHOPIFY_API_KEY ||= "test-key";
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  restoreAppUrlAfter(t);
  setAppUrl("https://gooper.io");
  const expected = gooperMcpIcons();

  const { createCustomerReturnsMcpServer } = await import("./mcp.server");
  const { createIntakeMcpServer } = await import("./intake-mcp.server");

  assert.deepEqual(
    await advertisedIcons(
      createCustomerReturnsMcpServer({
        authorize: async () => ({
          shop: "example.myshopify.com",
          customerToken: "customer-token",
        }),
        resourceMetadataUrl: "https://gooper.io/oauth/resource/example.myshopify.com",
      }),
    ),
    expected,
  );
  assert.deepEqual(await advertisedIcons(createIntakeMcpServer()), expected);
});
