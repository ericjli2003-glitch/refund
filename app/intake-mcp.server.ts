import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { findStore } from "./services/merchant-lookup.server";
import {
  intakeSchema,
  startReturnIntake,
} from "./services/return-intake.server";

// Only the authenticated app-proxy handler may supply a bound shop. Never take
// this value from JSON-RPC arguments or an unsigned query parameter.
export function createIntakeMcpServer(shop?: string) {
  const server = new McpServer({
    name: "Refund merchant return intake",
    version: "0.2.0",
  });
  // A merchant-bound proxy endpoint already knows its store; only the global
  // endpoint searches across stores.
  if (!shop)
    server.registerTool(
      "find_store",
      {
        title: "Find a store that uses Refund",
        description:
          "Search Refund's directory of listed Shopify stores by business name or website. Returns matching stores with their websites and return pages. If several match, show them and ask the customer which one they bought from; never pick for them. If none match, stop. Send only a business name or domain, never customer, order, item, payment or sign-in details. Does not read purchases, start a return, or refund money.",
        inputSchema: {
          merchant: z
            .string()
            .min(1)
            .max(120)
            .describe("Only the store's business name or website."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        _meta: { securitySchemes: [{ type: "noauth" }] },
      },
      async ({ merchant }) => {
        try {
          const result = await findStore(merchant);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Store search is unavailable. Stop without starting a return; nothing was submitted.",
              },
            ],
          };
        }
      },
    );
  server.registerTool(
    "start_return",
    {
      title: "Start a return with a merchant",
      description:
        "Find a connected merchant and prepare a secure purchase-verification link. If the merchant cannot be uniquely resolved, stop; Refund records only the business name/domain privately for its operator. Do not request a URL fallback, substitute another store/item, or contact the merchant. Does not read purchases, create a return, or refund money. No Refund account is required.",
      inputSchema: shop ? intakeSchema.omit({ merchant: true }) : intakeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: { securitySchemes: [{ type: "noauth" }] },
    },
    async (input) => {
      try {
        const result = await startReturnIntake(shop ? { ...input, merchant: shop } : input);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Could not identify the merchant. Stop without starting a return, substituting an item/store, requesting a URL fallback, or contacting the merchant. Nothing was submitted.",
            },
          ],
        };
      }
    },
  );
  return server;
}
