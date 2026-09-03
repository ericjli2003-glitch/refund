import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import {
  calculateReturn,
  executeAutomaticReturn,
  getReturnableOrders,
} from "./services/automatic-return.server";
import { CustomerAccountApiError } from "./services/customer-account.server";

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

const oauthSecuritySchemes = [
  {
    type: "oauth2",
    scopes: ["openid", "email", "customer-account-api:full"],
  },
];

function toolError(error: unknown, resourceMetadataUrl: string) {
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
  shop,
  customerToken,
  resourceMetadataUrl,
}: {
  shop: string;
  customerToken: string;
  resourceMetadataUrl: string;
}) {
  const server = new McpServer({
    name: "Shopify customer returns",
    version: "0.2.0",
  });

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
      _meta: { securitySchemes: oauthSecuritySchemes },
    },
    async ({ query }) => {
      try {
        const { orders } = await getReturnableOrders(shop, customerToken);
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
              order.returnInformation.nonReturnableSummary.nonReturnableReasons,
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
        "Revalidates selected Shopify line items and calculates the exact expected return total. Show the result to the customer before calling confirm_return.",
      inputSchema: {
        orderId: z.string().min(1),
        items: itemsSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: oauthSecuritySchemes },
    },
    async ({ orderId, items }) => {
      try {
        const quote = await calculateReturn(
          shop,
          customerToken,
          orderId,
          items,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  orderId,
                  items: quote.returnLineItems.nodes,
                  expectedRefund:
                    quote.financialSummary.returnTotalSet.presentmentMoney,
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
        orderId: z.string().min(1),
        items: itemsSchema,
        customerNote: z.string().max(300).optional(),
        customerConfirmed: z
          .literal(true)
          .describe("Must be true only after explicit customer confirmation"),
        idempotencyKey: z
          .string()
          .uuid()
          .describe("A new UUID for this exact confirmed return"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: oauthSecuritySchemes },
    },
    async ({ orderId, items, customerNote, idempotencyKey }) => {
      try {
        const result = await executeAutomaticReturn({
          shop,
          customerToken,
          orderId,
          items,
          customerNote,
          idempotencyKey,
        });
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
                  message:
                    result.status === "REFUND_SUBMITTED"
                      ? "The return is open and Shopify submitted the refund to the original payment method. Bank posting time may vary."
                      : "This request already exists. Use its current status and do not submit it again.",
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
