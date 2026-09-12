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
  agentChallenge,
  type AgentScope,
} from "./services/agent-access.server";
import {
  getReturnSession,
  markDraftSubmitted,
  notePurchaseLookup,
  saveReturnQuote,
} from "./services/return-draft.server";

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

export function createCustomerReturnsMcpServer({
  authorize,
  resourceMetadataUrl,
}: {
  authorize: (
    scope: AgentScope,
  ) => Promise<{
    shop: string;
    customerToken: string;
    customerSubjectHash?: string;
    draftId?: string | null;
  }>;
  resourceMetadataUrl: string;
}) {
  const server = new McpServer({
    name: "Shopify customer returns",
    version: "0.3.0",
  });

  for (const name of ["get_return_session", "check_return_status"] as const) {
    server.registerTool(
      name,
      {
        title:
          name === "get_return_session"
            ? "Resume a customer return draft"
            : "Check a customer return status",
        description:
          "Reads only the authenticated customer's latest Refund draft and any known submission status. Use after interruption or an uncertain retry. Never creates a return or refund.",
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
          const context = await authorize("returns:read");
          if (!context.customerSubjectHash)
            throw new Error("This customer session cannot resume drafts.");
          const result = await getReturnSession({
            shop: context.shop,
            customerSubjectHash: context.customerSubjectHash,
            draftId: context.draftId,
          });
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
      inputSchema: {
        query: z
          .string()
          .max(120)
          .optional()
          .describe("Optional product name or order-name search"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: securitySchemes("returns:read") },
    },
    async ({ query }) => {
      try {
        const { shop, customerToken, customerSubjectHash, draftId } =
          await authorize("returns:read");
        const { orders } = await getReturnableOrders(shop, customerToken);
        if (customerSubjectHash)
          await notePurchaseLookup({ shop, customerSubjectHash, draftId });
        const normalizedQuery = query?.trim().toLowerCase();
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
      inputSchema: {
        orderId: z.string().min(1),
        items: itemsSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: securitySchemes("returns:quote") },
    },
    async ({ orderId, items }) => {
      try {
        const { shop, customerToken, customerSubjectHash, draftId } =
          await authorize("returns:quote");
        const quote = await createReturnQuote(shop, customerToken, {
          orderId,
          items,
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
        "After the authenticated customer explicitly confirms the exact items and quoted amount, requests and opens the Shopify return and submits an idempotent refund to the original payment method. This is consequential and must never be called speculatively.",
      inputSchema: {
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
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: securitySchemes("returns:submit") },
    },
    async ({ quoteToken, customerNote, customerConfirmed }) => {
      try {
        const { shop, customerToken, customerSubjectHash } =
          await authorize("returns:submit");
        const result = await submitReturnQuote(shop, customerToken, {
          quoteToken,
          customerNote,
          customerConfirmed,
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

  return server;
}
