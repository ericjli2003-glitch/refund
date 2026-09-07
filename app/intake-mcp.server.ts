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
        "Find a connected merchant and prepare a secure purchase-verification link when the customer asks to return or refund a purchase. Provide their store website and optional order/item hints. Does not read purchases, create a return, or refund money. No Refund account is required for this step.",
      inputSchema: intakeSchema,
      annotations: {
        readOnlyHint: true,
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
              text: "Could not prepare verification. Check the merchant website address and try again.",
            },
          ],
        };
      }
    },
  );
  return server;
}
