import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  intakeSchema,
  startReturnIntake,
} from "./services/return-intake.server";

export function createIntakeMcpServer() {
  const server = new McpServer({
    name: "Refund merchant return intake",
    version: "0.1.0",
  });
  server.registerTool(
    "start_return",
    {
      title: "Start a return with a merchant",
      description:
        "Find a connected merchant and prepare a secure purchase-verification link. If the merchant cannot be uniquely resolved, stop; Refund records only the business name/domain privately for its operator. Do not request a URL fallback, substitute another store/item, or contact the merchant. Does not read purchases, create a return, or refund money. No Refund account is required.",
      inputSchema: intakeSchema,
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
        const result = await startReturnIntake(input);
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
