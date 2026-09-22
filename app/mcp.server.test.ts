import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

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

  // Assistants show this name beside the connector. It names Gooper.io, not
  // Shopify, so the tool isn't mistaken for one of Shopify's own.
  assert.equal(client.getServerVersion()?.name, "Gooper.io returns");

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
  )?.inputSchema as
    | { required?: string[]; properties?: Record<string, unknown> }
    | undefined;
  assert.equal(
    confirmationSchema?.required?.includes("customerConfirmed"),
    true,
  );
  // The dialog the customer approves names the quote by its short id, not by
  // a two-thousand-character signed token.
  assert.equal(confirmationSchema?.required?.includes("quoteToken"), false);
  assert.ok(confirmationSchema?.properties?.quoteId);
  assert.ok(confirmationSchema?.properties?.quoteToken);
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
  // Titles are the dialog's heading, so they read as the customer's own words.
  assert.deepEqual(
    tools.map((tool) => tool.title),
    [
      "Pick up where you left off",
      "Check on your return",
      "Find what you can return",
      "Check your refund amount",
      "Submit your return and refund",
      "Add your tracking number",
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
        return { status: "email_needed" };
      },
      list: async () => [],
      emails: {
        list: async () => [],
        remove: async () => ({ removed: true }),
      },
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
      "list_confirmed_emails",
      "remove_confirmed_email",
      "get_return_session",
      "check_return_status",
      "find_returnable_items",
      "quote_return",
      "confirm_return",
      "add_return_tracking",
    ],
  );
  for (const tool of tools.slice(5)) {
    const schema = tool.inputSchema as { required?: string[] };
    assert.equal(schema.required?.includes("store"), true, tool.name);
  }
  assert.deepEqual(
    tools.slice(0, 5).map((tool) => tool.title),
    [
      "Find the store",
      "See which stores are connected",
      "Connect the store to this chat",
      "See the emails you've confirmed",
      "Forget one of your emails",
    ],
  );
  assert.equal(
    tools.find((tool) => tool.name === "link_store")?.annotations
      ?.destructiveHint,
    false,
  );
  const linkSchema = tools.find((tool) => tool.name === "link_store")
    ?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  assert.ok(linkSchema.properties?.email);
  assert.deepEqual(linkSchema.required, ["merchant"]);
  // Hosts receive the shared conversation style with the tools.
  assert.match(client.getInstructions() ?? "", /store associate/);

  const missingStore = await client.callTool({
    name: "find_returnable_items",
    arguments: {},
  });
  assert.equal(missingStore.isError, true);
  assert.equal(authorized.length, 0);

  // A store's own domain names it without a directory lookup.
  const result = await client.callTool({
    name: "find_returnable_items",
    arguments: { store: "example.myshopify.com" },
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

// Two orders, one of them holding two line items with the same title, so a
// product name alone can be unambiguous, wrong, or ambiguous.
const returnableOrders = (t: TestContext) =>
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, options?: RequestInit) => {
      if (!options?.body)
        return Response.json({
          graphql_api: "https://shopify.com/customer/api/2026-07/graphql",
        });
      const item = (id: string, title: string) => ({
        quantity: 2,
        lineItem: {
          id: `gid://shopify/LineItem/${id}`,
          presentmentTitle: title,
          currentTotalPrice: { amount: "14.00", currencyCode: "CAD" },
        },
      });
      return Response.json({
        data: {
          customer: {
            id: "gid://shopify/Customer/1",
            orders: {
              nodes: [
                {
                  id: "gid://shopify/Order/1",
                  name: "#1001",
                  processedAt: "2026-09-01T00:00:00Z",
                  returnInformation: {
                    nonReturnableSummary: null,
                    returnableLineItems: {
                      nodes: [
                        item("11", "Twin Candle"),
                        item("12", "Twin Candle"),
                      ],
                    },
                  },
                },
                {
                  id: "gid://shopify/Order/2",
                  name: "#1002",
                  processedAt: "2026-09-02T00:00:00Z",
                  returnInformation: {
                    nonReturnableSummary: null,
                    returnableLineItems: { nodes: [item("21", "Blue Mug")] },
                  },
                },
              ],
            },
          },
        },
      });
    },
  );

test("a quote asked for in words refuses every reading but the only one", async (t) => {
  const { createCustomerReturnsMcpServer } = await import("./mcp.server");
  returnableOrders(t);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createCustomerReturnsMcpServer({
    authorize: async () => ({
      shop: "words.myshopify.com",
      customerToken: "customer-token",
    }),
    resourceMetadataUrl:
      "https://refund.test/oauth/resource/words.myshopify.com",
  });
  const client = new Client({ name: "words-test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const quote = async (returning: unknown) =>
    client.callTool({ name: "quote_return", arguments: { returning } });

  // Two line items on the same order share a title.
  const duplicate = await quote([{ product: "Twin Candle" }]);
  assert.equal(duplicate.isError, true);
  assert.match(
    JSON.stringify(duplicate.content),
    /More than one returnable item matches .*Twin Candle/,
  );

  const unknownOrder = await quote([
    { order: "#9999", product: "Blue Mug", quantity: 1 },
  ]);
  assert.equal(unknownOrder.isError, true);
  assert.match(
    JSON.stringify(unknownOrder.content),
    /no returnable order #9999 at this store/,
  );

  const otherOrder = await quote([{ order: "#1001", product: "Blue Mug" }]);
  assert.equal(otherOrder.isError, true);
  assert.match(
    JSON.stringify(otherOrder.content),
    /isn.{0,3}t on order #1001.*order #1002/,
  );
});

test("confirming by quote id never reaches another customer's quote", async (t) => {
  const { createCustomerReturnsMcpServer } = await import("./mcp.server");
  const prisma = (await import("./db.server")).default;
  const QUOTE_ID = "11111111-1111-4111-8111-111111111111";
  const drafts = [
    {
      id: "draft-a",
      shop: "shared.myshopify.com",
      customerSubjectHash: "customer-a",
      quoteId: QUOTE_ID,
      sealedQuoteToken: "sealed",
    },
  ];
  const lookups: unknown[] = [];
  const original = prisma.returnDraft.findFirst;
  Reflect.set(
    prisma.returnDraft,
    "findFirst",
    async ({ where }: { where: Record<string, string> }) => {
      lookups.push(where);
      return (
        drafts.find((draft) =>
          Object.entries(where).every(
            ([field, value]) => Reflect.get(draft, field) === value,
          ),
        ) ?? null
      );
    },
  );
  t.after(() => Reflect.set(prisma.returnDraft, "findFirst", original));
  const upstream = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No upstream request is allowed");
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createCustomerReturnsMcpServer({
    authorize: async () => ({
      shop: "shared.myshopify.com",
      customerToken: "customer-token",
      customerSubjectHash: "customer-b",
    }),
    resourceMetadataUrl:
      "https://refund.test/oauth/resource/shared.myshopify.com",
  });
  const client = new Client({ name: "quote-id-test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "confirm_return",
    arguments: { quoteId: QUOTE_ID, customerConfirmed: true },
  });
  assert.equal(result.isError, true);
  assert.match(
    JSON.stringify(result.content),
    /isn.t one of this customer's/,
  );
  // The lookup is scoped to the confirming customer and store, which is why
  // customer A's quote is simply not there.
  assert.deepEqual(lookups, [
    {
      shop: "shared.myshopify.com",
      customerSubjectHash: "customer-b",
      quoteId: QUOTE_ID,
    },
  ]);
  assert.equal(upstream.mock.callCount(), 0);

  const withoutAQuote = await client.callTool({
    name: "confirm_return",
    arguments: { customerConfirmed: true },
  });
  assert.equal(withoutAQuote.isError, true);
  assert.match(JSON.stringify(withoutAQuote.content), /Name the quote/);
});
