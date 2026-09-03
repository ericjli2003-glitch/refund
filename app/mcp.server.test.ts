import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("the MCP server advertises a guarded discovery, quote, confirm flow", async () => {
  process.env.SHOPIFY_API_KEY ||= "test-key";
  process.env.SHOPIFY_API_SECRET ||= "test-secret";
  process.env.SHOPIFY_APP_URL ||= "https://refund.test";

  const { createCustomerReturnsMcpServer } = await import("./mcp.server");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createCustomerReturnsMcpServer({
    shop: "example.myshopify.com",
    customerToken: "customer-token",
    resourceMetadataUrl:
      "https://refund.test/oauth/resource/example.myshopify.com",
  });
  const client = new Client({ name: "refund-test", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["find_returnable_items", "quote_return", "confirm_return"],
  );
  assert.equal(
    tools.find((tool) => tool.name === "confirm_return")?.annotations
      ?.destructiveHint,
    true,
  );
  const confirmationSchema = tools.find(
    (tool) => tool.name === "confirm_return",
  )?.inputSchema as { required?: string[] } | undefined;
  assert.equal(
    confirmationSchema?.required?.includes("customerConfirmed"),
    true,
  );
  assert.equal(confirmationSchema?.required?.includes("idempotencyKey"), true);
  assert.deepEqual(
    tools.find((tool) => tool.name === "confirm_return")?._meta
      ?.securitySchemes,
    [
      {
        type: "oauth2",
        scopes: ["openid", "email", "customer-account-api:full"],
      },
    ],
  );

  await client.close();
  await server.close();
});
