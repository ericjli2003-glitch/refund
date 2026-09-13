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
    [
      "get_return_session",
      "check_return_status",
      "find_returnable_items",
      "quote_return",
      "confirm_return",
      "add_return_tracking",
    ],
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
  const trackingTool = tools.find((tool) => tool.name === "add_return_tracking");
  assert.equal(trackingTool?.annotations?.destructiveHint, false);
  assert.deepEqual(trackingTool?._meta?.securitySchemes, [
    { type: "oauth2", scopes: ["returns:submit"] },
  ]);

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
    ["get_return_session", {}, "returns:read"],
    ["check_return_status", {}, "returns:read"],
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
    [
      "add_return_tracking",
      { agentReturnId: "agent-return-1", trackingNumber: "1Z999AA1" },
      "returns:submit",
    ],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result._meta), /insufficient_scope/);
    assert.match(JSON.stringify(result._meta), new RegExp(scope));
  }
  assert.deepEqual(calls, [
    "returns:read",
    "returns:read",
    "returns:read",
    "returns:quote",
    "returns:submit",
    "returns:submit",
  ]);
  assert.equal(upstream.mock.callCount(), 0);
});

test("the all-stores server names the store on every private tool and asks to link unlinked stores", async (t) => {
  const { createCustomerReturnsMcpServer } = await import("./mcp.server");
  const { StoreLinkRequiredError } = await import(
    "./services/agent-access.server"
  );
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No upstream request is allowed");
  });
  const authorized: Array<[string, string | undefined]> = [];
  const linked: string[] = [];
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createCustomerReturnsMcpServer({
    authorize: async (scope, shop) => {
      authorized.push([scope, shop]);
      throw new StoreLinkRequiredError(shop!, "not_linked");
    },
    resourceMetadataUrl: "https://refund.test/oauth/resource/stores",
    stores: {
      find: async (merchant) => ({ status: "found", merchant }),
      link: async (merchant) => {
        linked.push(merchant);
        return { status: "sign_in_required", linkUrl: "https://refund.test/x" };
      },
      list: async () => [],
    },
  });
  const client = new Client({ name: "stores-test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "find_store",
      "list_linked_stores",
      "link_store",
      "get_return_session",
      "check_return_status",
      "find_returnable_items",
      "quote_return",
      "confirm_return",
      "add_return_tracking",
    ],
  );
  for (const tool of tools.slice(3)) {
    const schema = tool.inputSchema as { required?: string[] };
    assert.equal(schema.required?.includes("shop"), true, tool.name);
  }
  assert.equal(
    tools.find((tool) => tool.name === "link_store")?.annotations
      ?.destructiveHint,
    false,
  );

  const missingShop = await client.callTool({
    name: "find_returnable_items",
    arguments: {},
  });
  assert.equal(missingShop.isError, true);
  assert.equal(authorized.length, 0);

  const result = await client.callTool({
    name: "find_returnable_items",
    arguments: { shop: "example.myshopify.com" },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(authorized, [["returns:read", "example.myshopify.com"]]);
  assert.deepEqual(result.structuredContent, {
    linkRequired: true,
    shop: "example.myshopify.com",
    reason: "not_linked",
    nextTool: "link_store",
    returnSubmitted: false,
    refundSubmitted: false,
  });

  const link = await client.callTool({
    name: "link_store",
    arguments: { merchant: "example.myshopify.com" },
  });
  assert.notEqual(link.isError, true);
  assert.deepEqual(linked, ["example.myshopify.com"]);
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
