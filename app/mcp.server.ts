import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { getReturnableOrders } from "./services/automatic-return.server";
import { CustomerAccountApiError } from "./services/customer-account.server";
import {
  createReturnQuote,
  submitReturnQuote,
  readBoundQuote,
} from "./services/return-quote.server";
import {
  AgentAccessError,
  StoreLinkRequiredError,
  agentChallenge,
  type AgentScope,
} from "./services/agent-access.server";
import {
  getReturnSession,
  markDraftSubmitted,
  notePurchaseLookup,
  saveReturnQuote,
} from "./services/return-draft.server";
import {
  addReturnTracking,
  returnShippingFor,
} from "./services/return-shipping.server";

const itemSchema = z.object({
  lineItemId: z
    .string()
    .min(1)
    .describe("The Shopify line-item ID returned by find_returnable_items"),
  quantity: z.number().int().positive().describe("Quantity to return"),
});

const itemsSchema = z
  .array(itemSchema)
  .min(1)
  .max(50)
  .refine(
    (items) =>
      new Set(items.map((item) => item.lineItemId)).size === items.length,
    "Each line item can appear only once",
  );

const securitySchemes = (scope: AgentScope) => [
  { type: "oauth2", scopes: [scope] },
];

function toolError(error: unknown, resourceMetadataUrl: string) {
  if (error instanceof AgentAccessError) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: error.message }],
      _meta: {
        "mcp/www_authenticate": [agentChallenge(resourceMetadataUrl, error)],
      },
    };
  }
  if (error instanceof StoreLinkRequiredError) {
    const detail = {
      linkRequired: true,
      shop: error.shop,
      reason: error.reason,
      nextTool: "link_store",
      returnSubmitted: false,
      refundSubmitted: false,
    };
    return {
      isError: true as const,
      content: [
        { type: "text" as const, text: `${error.message} ${JSON.stringify(detail)}` },
      ],
      structuredContent: detail,
    };
  }
  const message =
    error instanceof Error ? error.message : "The return action failed.";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
    ...(error instanceof CustomerAccountApiError && error.status === 401
      ? {
          _meta: {
            "mcp/www_authenticate": [
              `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="The Shopify customer session expired"`,
            ],
          },
        }
      : {}),
  };
}

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export type StoreDirectoryTools = {
  find: (merchant: string) => Promise<unknown>;
  link: (merchant: string) => Promise<unknown>;
  list: () => Promise<unknown>;
};

// One server serves both a single store's connection and the all-stores
// connection. With `stores`, every store tool also takes a `shop` argument,
// and `authorize` checks that the connection has linked that store.
export function createCustomerReturnsMcpServer({
  authorize,
  resourceMetadataUrl,
  stores,
}: {
  authorize: (
    scope: AgentScope,
    shop?: string,
  ) => Promise<{
    shop: string;
    customerToken: string;
    customerSubjectHash?: string;
    draftId?: string | null;
  }>;
  resourceMetadataUrl: string;
  stores?: StoreDirectoryTools;
}) {
  const server = new McpServer({
    name: "Shopify customer returns",
    version: "0.4.0",
  });
  const shopSchema = z
    .string()
    .min(1)
    .max(255)
    .describe(
      "The store's myshopify.com domain, from find_store or list_linked_stores",
    );
  const withShop = <T extends z.ZodRawShape>(shape: T) =>
    (stores ? { ...shape, shop: shopSchema } : shape) as T & {
      shop?: typeof shopSchema;
    };

  if (stores) {
    server.registerTool(
      "find_store",
      {
        title: "Find a store that uses Refund",
        description:
          "Search Refund's directory of stores by business name or website. If several match, show them and ask the customer which one they bought from; never pick for them. Each result's shop is what link_store and the other tools take.",
        inputSchema: {
          merchant: z
            .string()
            .min(1)
            .max(120)
            .describe("Only the store's business name or website"),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: { securitySchemes: securitySchemes("returns:read") },
      },
      async ({ merchant }) => {
        try {
          return json(await stores.find(merchant));
        } catch (error) {
          return toolError(error, resourceMetadataUrl);
        }
      },
    );
    server.registerTool(
      "list_linked_stores",
      {
        title: "List linked stores",
        description:
          "Lists the stores this connection is linked to and whether each link is still active. A store link lasts up to four hours after the customer signs in to that store; renew an inactive one with link_store.",
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { securitySchemes: securitySchemes("returns:read") },
      },
      async () => {
        try {
          return json({ stores: await stores.list() });
        } catch (error) {
          return toolError(error, resourceMetadataUrl);
        }
      },
    );
    server.registerTool(
      "link_store",
      {
        title: "Link a store to this connection",
        description:
          "Starts linking a store so this connection can find the customer's purchases there. Returns a link the customer opens to sign in to that store with Shopify and approve, in the same browser they used to connect Refund; if they are still signed in there, no code is needed. Says so if the store is already linked. Never ask for sign-in codes in chat. Linking does not submit a return or refund.",
        inputSchema: {
          merchant: z
            .string()
            .min(1)
            .max(2048)
            .describe("The store's myshopify.com domain or website from find_store"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: { securitySchemes: securitySchemes("returns:read") },
      },
      async ({ merchant }) => {
        try {
          return json(await stores.link(merchant));
        } catch (error) {
          return toolError(error, resourceMetadataUrl);
        }
      },
    );
  }

  for (const name of ["get_return_session", "check_return_status"] as const) {
    server.registerTool(
      name,
      {
        title:
          name === "get_return_session"
            ? "Resume a customer return draft"
            : "Check a customer return status",
        description:
          "Reads only the authenticated customer's latest Refund draft, any known submission status, and each approved return's shipping: the store's return label link and tracking, and whether the customer can add their own tracking. Use after interruption or an uncertain retry. Never creates a return or refund.",
        inputSchema: withShop({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { securitySchemes: securitySchemes("returns:read") },
      },
      async (input) => {
        try {
          const context = await authorize("returns:read", input.shop);
          if (!context.customerSubjectHash)
            throw new Error("This customer session cannot resume drafts.");
          const customer = {
            shop: context.shop,
            customerSubjectHash: context.customerSubjectHash,
            draftId: context.draftId,
          };
          const result = {
            ...(await getReturnSession(customer)),
            shipping: await returnShippingFor(customer),
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        } catch (error) {
          return toolError(error, resourceMetadataUrl);
        }
      },
    );
  }

  server.registerTool(
    "find_returnable_items",
    {
      title: "Find a customer's returnable purchases",
      description:
        "Lists returnable items from the authenticated customer's own recent Shopify orders. Use this before quoting or confirming a return. Never ask the customer for card details.",
      inputSchema: withShop({
        query: z
          .string()
          .max(120)
          .optional()
          .describe("Optional product name or order-name search"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: securitySchemes("returns:read") },
    },
    async (input) => {
      try {
        const { shop, customerToken, customerSubjectHash, draftId } =
          await authorize("returns:read", input.shop);
        const { orders } = await getReturnableOrders(shop, customerToken);
        if (customerSubjectHash)
          await notePurchaseLookup({ shop, customerSubjectHash, draftId });
        const normalizedQuery = input.query?.trim().toLowerCase();
        const matches = orders
          .map((order) => ({
            orderId: order.id,
            orderName: order.name,
            processedAt: order.processedAt,
            items: order.returnInformation.returnableLineItems.nodes.map(
              (entry) => ({
                lineItemId: entry.lineItem.id,
                title: entry.lineItem.presentmentTitle,
                returnableQuantity: entry.quantity,
                currentTotalPrice: entry.lineItem.currentTotalPrice,
              }),
            ),
            nonReturnableReasons:
              order.returnInformation.nonReturnableSummary
                ?.nonReturnableReasons ?? [],
          }))
          .filter(
            (order) =>
              order.items.length > 0 &&
              (!normalizedQuery ||
                order.orderName.toLowerCase().includes(normalizedQuery) ||
                order.items.some((item) =>
                  item.title.toLowerCase().includes(normalizedQuery),
                )),
          );

        return {
          content: [
            {
              type: "text",
              text: matches.length
                ? JSON.stringify({ orders: matches }, null, 2)
                : "No matching returnable purchases were found for this customer.",
            },
          ],
        };
      } catch (error) {
        return toolError(error, resourceMetadataUrl);
      }
    },
  );

  server.registerTool(
    "quote_return",
    {
      title: "Quote a customer return",
      description:
        "Revalidates selected Shopify line items, calculates the expected return total net of any fees from the merchant's Shopify return rules, and persists a resumable quote. Show the result to the customer, including returnFees and the returnShipping instructions. If submissionAvailable is false, explain that merchant approval is needed and stop. Otherwise, stop for explicit customer confirmation.",
      inputSchema: withShop({
        orderId: z.string().min(1),
        items: itemsSchema,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: securitySchemes("returns:quote") },
    },
    async (input) => {
      try {
        const { shop, customerToken, customerSubjectHash, draftId } =
          await authorize("returns:quote", input.shop);
        const quote = await createReturnQuote(shop, customerToken, {
          orderId: input.orderId,
          items: input.items,
        });
        const draft = customerSubjectHash
          ? await saveReturnQuote({ shop, customerSubjectHash, draftId }, quote)
          : null;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...(draft?.quote || quote),
                  correlationId: draft?.id,
                  nextStep:
                    "Ask the customer to explicitly confirm this exact return and amount before using confirm_return.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return toolError(error, resourceMetadataUrl);
      }
    },
  );

  server.registerTool(
    "confirm_return",
    {
      title: "Confirm and submit a customer return",
      description:
        "After the authenticated customer explicitly confirms the exact items and quoted amount, requests and opens the Shopify return and refunds the original payment method, either immediately or after the store receives the item, as the quote's refundTiming states. This is consequential and must never be called speculatively.",
      inputSchema: withShop({
        quoteToken: z
          .string()
          .min(1)
          .max(32_000)
          .describe(
            "The unmodified quoteToken returned by quote_return; reuse it for retries",
          ),
        customerNote: z.string().max(300).optional(),
        customerConfirmed: z
          .literal(true)
          .describe("Must be true only after explicit customer confirmation"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: securitySchemes("returns:submit") },
    },
    async (input) => {
      try {
        const { shop, customerToken, customerSubjectHash } = await authorize(
          "returns:submit",
          input.shop,
        );
        const result = await submitReturnQuote(shop, customerToken, {
          quoteToken: input.quoteToken,
          customerNote: input.customerNote,
          customerConfirmed: input.customerConfirmed,
        });
        if (customerSubjectHash)
          await markDraftSubmitted({ shop, customerSubjectHash }, result,
            readBoundQuote(input.quoteToken, shop, customerSubjectHash).id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: result.status,
                  orderId: result.orderId,
                  returnId: result.returnId,
                  refundId: result.refundId,
                  submittedRefund: result.amount
                    ? {
                        amount: result.amount,
                        currencyCode: result.currencyCode,
                      }
                    : null,
                  refundStatus: result.refundStatus,
                  paymentMethod: result.paymentMethod,
                  message: result.message,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return toolError(error, resourceMetadataUrl);
      }
    },
  );

  server.registerTool(
    "add_return_tracking",
    {
      title: "Add return tracking",
      description:
        "Records the tracking number for a return the authenticated customer is shipping back themselves. Use an agentReturnId from get_return_session or check_return_status shipping entries where canAddTracking is true, and only a tracking number the customer gave you; never invent one. Never overwrites tracking from the store's label and does not change the refund.",
      inputSchema: withShop({
        agentReturnId: z.string().min(1).max(64),
        trackingNumber: z
          .string()
          .min(4)
          .max(40)
          .describe("The carrier tracking number the customer provided"),
        trackingUrl: z
          .string()
          .max(500)
          .optional()
          .describe("Optional https tracking link from the carrier"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: securitySchemes("returns:submit") },
    },
    async (input) => {
      try {
        const { shop, customerSubjectHash } = await authorize(
          "returns:submit",
          input.shop,
        );
        if (!customerSubjectHash)
          throw new Error("This customer session cannot update returns.");
        const shipping = await addReturnTracking(
          { shop, customerSubjectHash },
          {
            agentReturnId: input.agentReturnId,
            trackingNumber: input.trackingNumber,
            trackingUrl: input.trackingUrl,
          },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(shipping, null, 2) }],
          structuredContent: shipping,
        };
      } catch (error) {
        return toolError(error, resourceMetadataUrl);
      }
    },
  );

  return server;
}
