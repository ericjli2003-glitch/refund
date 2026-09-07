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
    authorize: async () => ({
      shop: "example.myshopify.com",
      customerToken: "customer-token",
    }),
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
  assert.equal(confirmationSchema?.required?.includes("quoteToken"), true);
  assert.deepEqual(
    tools.find((tool) => tool.name === "confirm_return")?._meta
      ?.securitySchemes,
    [
      {
        type: "oauth2",
        scopes: ["returns:submit"],
      },
    ],
  );

  await client.close();
  await server.close();
});

test("every private tool checks its own permission before any Shopify call", async (t) => {
  const { createCustomerReturnsMcpServer } = await import("./mcp.server");
  const { AgentAccessError } = await import("./services/agent-access.server");
  const calls: string[] = [];
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No upstream request is allowed");
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createCustomerReturnsMcpServer({
    authorize: async (scope) => {
      calls.push(scope);
      throw new AgentAccessError("insufficient_scope", scope);
    },
    resourceMetadataUrl:
      "https://refund.test/oauth/resource/example.myshopify.com",
  });
  const client = new Client({ name: "scope-test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  for (const [name, args, scope] of [
    ["find_returnable_items", {}, "returns:read"],
    [
      "quote_return",
      { orderId: "order", items: [{ lineItemId: "item", quantity: 1 }] },
      "returns:quote",
    ],
    [
      "confirm_return",
      { quoteToken: "unused", customerConfirmed: true },
      "returns:submit",
    ],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result._meta), /insufficient_scope/);
    assert.match(JSON.stringify(result._meta), new RegExp(scope));
  }
  assert.deepEqual(calls, ["returns:read", "returns:quote", "returns:submit"]);
  assert.equal(upstream.mock.callCount(), 0);
});

test("returnable order discovery accepts Shopify's null non-returnable summary", async (t) => {
  const { createCustomerReturnsMcpServer } = await import("./mcp.server");
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, options?: RequestInit) => {
      if (!options?.body)
        return Response.json({
          graphql_api: "https://shopify.com/customer/api/2026-07/graphql",
        });
      return Response.json({
        data: {
          customer: {
            id: "customer",
            orders: {
              nodes: [
                {
                  id: "order",
                  name: "#1001",
                  processedAt: "2026-09-01T00:00:00Z",
                  returnInformation: {
                    nonReturnableSummary: null,
                    returnableLineItems: {
                      nodes: [
                        {
                          quantity: 1,
                          lineItem: {
                            id: "item",
                            presentmentTitle: "Refund Test Product",
                            currentTotalPrice: {
                              amount: "14.00",
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
        },
      });
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createCustomerReturnsMcpServer({
    authorize: async () => ({
      shop: "null-summary.myshopify.com",
      customerToken: "test-token",
    }),
    resourceMetadataUrl:
      "https://refund.test/oauth/resource/null-summary.myshopify.com",
  });
  const client = new Client({ name: "null-test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({
    name: "find_returnable_items",
    arguments: { query: "#1001" },
  });
  assert.notEqual(result.isError, true);
  assert.match(JSON.stringify(result.content), /Refund Test Product/);
  assert.doesNotMatch(JSON.stringify(result.content), /test-token/);
  const content = result.content as Array<{ text: string }>;
  assert.deepEqual(
    JSON.parse(content[0].text).orders[0].nonReturnableReasons,
    [],
  );
});
