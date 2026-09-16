import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { getReturnableOrders } from "./services/automatic-return.server";
import { CustomerAccountApiError } from "./services/customer-account.server";
import {
  chatQuoteNextStep,
  createReturnQuote,
  readBoundQuote,
  submitReturnQuote,
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
  sealedQuoteFor,
} from "./services/return-draft.server";
import {
  addReturnTracking,
  returnShippingFor,
} from "./services/return-shipping.server";
import { resolveStore, returningSchema } from "./services/return-wording.server";
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

// The signed token authorizes a submission and is thousands of characters
// long; the assistant works with the short quote id instead, and the sealed
// token stays in the customer's own draft.
const withoutToken = <T extends { quoteToken?: string }>(
  value: T,
): Omit<T, "quoteToken"> => {
  const shown = { ...value };
  delete (shown as { quoteToken?: string }).quoteToken;
  return shown;
};

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
// connection. With `stores`, every store tool also takes a `store` argument,
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
  // Assistants show these arguments to the customer before they approve a
  // tool, so they are the words the customer used, not Shopify's IDs.
  const storeSchema = z
    .string()
    .min(1)
    .max(255)
    .describe(
      'The store, in the customer\'s own words: its name or website, like "Testing" or "testing.com". Its myshopify.com domain works too.',
    );
  const withStore = <T extends z.ZodRawShape>(shape: T) =>
    (stores ? { store: storeSchema, ...shape } : shape) as T & {
      store?: typeof storeSchema;
    };
  // A store name that fits no store, or more than one, stops here rather than
  // reaching a store the customer never named.
  const storeAccess = async (scope: AgentScope, input: { store?: string }) =>
    authorize(scope, input.store ? await resolveStore(input.store) : undefined);

  if (stores) {
    server.registerTool(
      "find_store",
      {
        title: "Find the store",
        description:
          "Search Gooper.io's directory of stores by business name or website. If exactly one store matches, go ahead with it without asking, and mention its name naturally so the customer can correct you. If several match, ask which one they bought from in one short, friendly question listing each name and website. Pass the store's name or website to the other tools as store.",
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
        title: "See which stores are connected",
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
        title: "Connect the store to this chat",
        description:
          "Connects a store so this connection can see the customer's orders there. If an email the customer already confirmed has orders at the store, it connects right away with nothing for them to do. With a different email they used at checkout, Gooper.io emails them a one-tap confirmation, no Shopify sign-in and no account needed, and returns a number for them to pick on the confirmation page. Without an email, it asks you to get one. Says so if the store is already connected, or if the store hasn't set up returns through assistants yet; there's no Shopify sign-in to offer instead. Never ask for passwords or sign-in codes in chat.",
        inputSchema: {
          merchant: z
            .string()
            .min(1)
            .max(2048)
            .describe("The store's name or website from find_store"),
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
        title: "See the emails you've confirmed",
        description:
          "Shows the emails the customer confirmed for this connection, partly hidden. Gooper.io uses them only to find the customer's orders at stores that use Gooper.io, never for marketing. Use when the customer asks which emails Gooper.io has, or wants to remove one.",
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
        title: "Forget one of your emails",
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
            ? "Pick up where you left off"
            : "Check on your return",
        description:
          "Reads only the authenticated customer's latest Gooper.io draft, any known submission status, and each approved return's shipping: the store's return label link and tracking, and whether the customer can add their own tracking. Use after interruption or an uncertain retry. Never creates a return or refund.",
        inputSchema: withStore({}),
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
          const context = await storeAccess("returns:read", input);
          if (!context.customerSubjectHash)
            throw new Error("This customer session cannot resume drafts.");
          const customer = {
            shop: context.shop,
            customerSubjectHash: context.customerSubjectHash,
            draftId: context.draftId,
          };
          const session = await getReturnSession(customer);
          const result = {
            ...withoutToken(session),
            quoteId: session.quote?.quoteId ?? null,
            quote: session.quote ? withoutToken(session.quote) : null,
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
      title: "Find what you can return",
      description:
        "Lists returnable items from the authenticated customer's own recent Shopify orders. Pick the item yourself: when one matches what the customer described, or it's their only returnable item, use it without asking. Ask one short question only when several items could match. Never ask for an order number, a reason or card details.",
      inputSchema: withStore({
        query: z
          .string()
          .max(120)
          .optional()
          .describe("Optional product name or order-number search"),
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
          await storeAccess("returns:read", input);
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
      title: "Check your refund amount",
      description:
        "Checks the selected items, calculates the exact refund after any return fees, and saves a resumable quote. Name each thing going back in returning, with the product as the customer called it and the order number only when they gave one; one quote can cover items from several of that store's orders. A product name that fits two items, or an order that isn't the customer's, stops rather than guessing — ask the customer instead. If submissionAvailable is false, explain kindly that the store reviews these returns itself, and stop. Otherwise show what's going back, any fees and the refund total, ask once, and call confirm_return with this quoteId after a clear yes.",
      inputSchema: withStore({
        returning: returningSchema
          .optional()
          .describe("Each thing going back, in the customer's own words"),
        // The portal and other ID-holding callers keep the exact form.
        orderId: z
          .string()
          .min(1)
          .optional()
          .describe("One order's Shopify ID, when you already have it"),
        items: itemsSchema
          .optional()
          .describe("That order's line items by Shopify ID"),
        orders: z
          .array(z.object({ orderId: z.string().min(1), items: itemsSchema }))
          .min(1)
          .max(5)
          .optional()
          .describe(
            "Items from up to five of this store's orders by Shopify ID, quoted as one refund",
          ),
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
          await storeAccess("returns:quote", input);
        const quote = await createReturnQuote(shop, customerToken, {
          returning: input.returning,
          orderId: input.orderId,
          items: input.items,
          orders: input.orders,
        });
        const draft = customerSubjectHash
          ? await saveReturnQuote({ shop, customerSubjectHash, draftId }, quote)
          : null;
        const view = draft?.quote || quote;
        return json({
          ...withoutToken(view),
          // Without a draft to hold the sealed token, it is the only way back
          // to this quote, so it stays in the reply.
          ...(draft ? {} : { quoteToken: view.quoteToken }),
          correlationId: draft?.id,
          ...chatQuoteNextStep(view),
        });
      } catch (error) {
        return toolError(error, resourceMetadataUrl);
      }
    },
  );

  server.registerTool(
    "confirm_return",
    {
      title: "Submit your return and refund",
      description:
        "Submits the quoted return: opens a Shopify return for each order in the quote and refunds the original payment method, either immediately or after the store receives the items, as the quote's refundTiming states. Pass the quoteId from quote_return. Call it only after the customer says yes to these exact items and this refund total. Each order reports its own result, so one order failing never undoes another.",
      inputSchema: withStore({
        quoteId: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            "The quoteId from quote_return; reuse it for retries of the same quote",
          ),
        quoteToken: z
          .string()
          .min(1)
          .max(32_000)
          .optional()
          .describe(
            "Only when quote_return returned a quoteToken instead of a quoteId",
          ),
        customerNote: z.string().max(300).optional(),
        customerConfirmed: z
          .literal(true)
          .describe(
            "True only after the customer says yes to these exact items and this refund total",
          ),
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
        const { shop, customerToken, customerSubjectHash } = await storeAccess(
          "returns:submit",
          input,
        );
        // The short id is only ever looked up inside this customer's own
        // drafts, so it can never reach another customer's quote.
        if (!input.quoteToken && !input.quoteId)
          throw new Error(
            "Name the quote to submit: pass the quoteId from quote_return.",
          );
        if (input.quoteId && !input.quoteToken && !customerSubjectHash)
          throw new Error(
            "This customer session keeps no saved quote, so confirm with the quoteToken quote_return returned.",
          );
        const quoteToken =
          input.quoteToken ??
          (await sealedQuoteFor(
            { shop, customerSubjectHash: customerSubjectHash! },
            input.quoteId!,
          ));
        const result = await submitReturnQuote(shop, customerToken, {
          quoteToken,
          customerNote: input.customerNote,
          customerConfirmed: input.customerConfirmed,
        });
        if (customerSubjectHash)
          await markDraftSubmitted({ shop, customerSubjectHash }, result,
            readBoundQuote(quoteToken, shop, customerSubjectHash).id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: result.status,
                  orders: result.orders,
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
      title: "Add your tracking number",
      description:
        "Records the tracking number for a return the authenticated customer is shipping back themselves. Use an agentReturnId from get_return_session or check_return_status shipping entries where canAddTracking is true, and only a tracking number the customer gave you; never invent one. Never overwrites tracking from the store's label and does not change the refund.",
      inputSchema: withStore({
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
        const { shop, customerSubjectHash } = await storeAccess(
          "returns:submit",
          input,
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
