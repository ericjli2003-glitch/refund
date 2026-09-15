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
import type { CustomerAccess } from "./services/verified-customer-returns.server";
import { returnsChatStyle } from "./services/chat-style.server";

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
      nextTool: error.reason === "store_not_ready" ? null : "link_store",
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
  link: (merchant: string, email?: string) => Promise<unknown>;
  emails: {
    list: () => Promise<unknown>;
    remove: (emailId: string) => Promise<unknown>;
  };
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
    // A live Shopify customer session, or a store link's verified customer.
    customerToken: CustomerAccess;
    customerSubjectHash?: string;
    draftId?: string | null;
  }>;
  resourceMetadataUrl: string;
  stores?: StoreDirectoryTools;
}) {
  const server = new McpServer(
    { name: "Shopify customer returns", version: "0.5.0" },
    { instructions: returnsChatStyle },
  );
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
          "Search Refund's directory of stores by business name or website. If exactly one store matches, go ahead with it without asking, and mention its name naturally so the customer can correct you. If several match, ask which one they bought from in one short, friendly question listing each name and website. Each result's shop is what link_store and the other tools take.",
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
          "Lists the stores this connection is linked to and whether each link is still active. Reconnect an inactive link with link_store.",
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
          "Connects a store so this connection can see the customer's orders there. If an email the customer already confirmed has orders at the store, it connects right away with nothing for them to do. With a different email they used at checkout, Refund emails them a one-tap confirmation, no Shopify sign-in and no account needed, and returns a number for them to pick on the confirmation page. Without an email, it asks you to get one. Says so if the store is already connected, or if the store hasn't set up returns through assistants yet; there's no Shopify sign-in to offer instead. Never ask for passwords or sign-in codes in chat.",
        inputSchema: {
          merchant: z
            .string()
            .min(1)
            .max(2048)
            .describe("The store's myshopify.com domain or website from find_store"),
          email: z
            .string()
            .max(254)
            .optional()
            .describe("The email the customer used for their order at this store"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: { securitySchemes: securitySchemes("returns:read") },
      },
      async ({ merchant, email }) => {
        try {
          return json(await stores.link(merchant, email));
        } catch (error) {
          return toolError(error, resourceMetadataUrl);
        }
      },
    );
    server.registerTool(
      "list_confirmed_emails",
      {
        title: "List confirmed emails",
        description:
          "Shows the emails the customer confirmed for this connection, partly hidden. Refund uses them only to find the customer's orders at stores that use Refund, never for marketing. Use when the customer asks which emails Refund has, or wants to remove one.",
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
          return json({ emails: await stores.emails.list() });
        } catch (error) {
          return toolError(error, resourceMetadataUrl);
        }
      },
    );
    server.registerTool(
      "remove_confirmed_email",
      {
        title: "Remove a confirmed email",
        description:
          "Removes one confirmed email from this connection, along with any store it connected. Only when the customer asks to remove it. Use an id from list_confirmed_emails.",
        inputSchema: {
          emailId: z.string().min(1).max(64).describe("The id from list_confirmed_emails"),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: { securitySchemes: securitySchemes("returns:read") },
      },
      async ({ emailId }) => {
        try {
          return json(await stores.emails.remove(emailId));
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
        "Checks the selected items, calculates the exact refund after any return fees, and saves a resumable quote. Share it warmly in plain words: what's going back, any fees, the refund amount, when it arrives, and how to send the item back. If submissionAvailable is false, explain kindly that the store reviews these returns itself, and stop. Otherwise ask whether they'd like to go ahead, and wait for a clear yes.",
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
                    "Summarize this for the customer in a friendly way, then ask something like \"Want me to go ahead with this return?\" Only call confirm_return after a clear yes to this exact return and amount.",
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
