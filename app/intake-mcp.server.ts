import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { returnsChatStyle } from "./services/chat-style.server";
import { findStore } from "./services/merchant-lookup.server";
import {
  intakeSchema,
  startReturnIntake,
} from "./services/return-intake.server";
import { gooperMcpIcons } from "./mcp-icons.server";

// Only the authenticated app-proxy handler may supply a bound shop. Never take
// this value from JSON-RPC arguments or an unsigned query parameter.
export function createIntakeMcpServer(shop?: string) {
  const server = new McpServer(
    { name: "Gooper.io merchant return intake", version: "0.3.0", icons: gooperMcpIcons() },
    { instructions: returnsChatStyle },
  );
  // A merchant-bound proxy endpoint already knows its store; only the global
  // endpoint searches across stores.
  if (!shop)
    server.registerTool(
      "find_store",
      {
        title: "Find the store",
        description:
          "Search Gooper.io's directory of listed Shopify stores by business name or website. If exactly one store matches, go ahead with it without asking and mention its name naturally. If several match, ask which one they bought from in one short, friendly question listing each name and website. If none match, let the customer know kindly and stop. Send only a business name or domain, never customer, order, item, payment or sign-in details. Doesn't read purchases, start a return, or refund money.",
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
                text: "Store search isn't available right now. Let the customer know kindly and suggest trying again shortly. Don't start a return; nothing was submitted.",
              },
            ],
          };
        }
      },
    );
  server.registerTool(
    "start_return",
    {
      title: "Start your return",
      description:
        "Find a connected merchant and prepare a secure purchase-verification link. If the merchant cannot be uniquely resolved, stop; Gooper.io records only the business name/domain privately for its operator. Do not request a URL fallback, substitute another store/item, or contact the merchant. Does not read purchases, create a return, or refund money. No Gooper.io account is required.",
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
              text: "Gooper.io couldn't find that store. Let the customer know kindly that it may not offer returns through Gooper.io yet, and stop without starting a return, substituting another store or item, asking for a URL, or contacting the store yourself. Nothing was submitted.",
            },
          ],
        };
      }
    },
  );
  return server;
}
