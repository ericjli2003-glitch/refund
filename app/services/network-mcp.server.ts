import { createCustomerReturnsMcpServer } from "../mcp.server";
import {
  authorizeConnection,
  connectionStore,
  listConnectionStores,
  type AgentScope,
} from "./agent-access.server";
import { handleAgentMcp, returnToolScopes } from "./agent-mcp-http.server";
import {
  listConnectionEmails,
  removeConnectionEmail,
} from "./connection-email.server";
import { appOrigin } from "./customer-security.server";
import { maskEmail } from "./email-address.server";
import { linkStore } from "./email-verification.server";
import { findStore } from "./merchant-lookup.server";

const scopesByTool: Record<string, AgentScope> = {
  ...returnToolScopes,
  find_store: "returns:read",
  list_linked_stores: "returns:read",
  link_store: "returns:read",
  list_confirmed_emails: "returns:read",
  remove_confirmed_email: "returns:read",
};

// The one connection to every Refund store, served at /mcp/stores and at every
// store's /mcp/<shop> address. Each address advertises its own resource
// metadata, because hosts check that it matches the URL they connected to.
export const handleNetworkMcp = (request: Request, resourceMetadataPath: string) =>
  handleAgentMcp(request, () => {
    const resourceMetadataUrl = new URL(resourceMetadataPath, appOrigin()).href;
    return {
      resourceMetadataUrl,
      continueUrl: new URL("/connect", appOrigin()).href,
      note: "Connect Refund in your assistant to start returns and refunds at any store that uses Refund.",
      scopesByTool,
      authorize: (authorization, scope) => authorizeConnection(authorization, scope),
      createServer: (authorization) => {
        const connection = () => authorizeConnection(authorization, "returns:read");
        return createCustomerReturnsMcpServer({
          resourceMetadataUrl,
          // Each call re-checks the connection, then that store's access.
          authorize: async (scope, shop) =>
            connectionStore(
              (await authorizeConnection(authorization, scope)).connectionId,
              shop ?? "",
            ),
          stores: {
            find: async (merchant) => {
              await connection();
              return findStore(merchant);
            },
            list: async () => listConnectionStores((await connection()).connectionId),
            link: async (merchant, email) =>
              linkStore((await connection()).connectionId, merchant, email),
            emails: {
              list: async () =>
                (await listConnectionEmails((await connection()).connectionId)).map(
                  (entry) => ({
                    id: entry.id,
                    email: maskEmail(entry.email),
                    confirmedAt: entry.confirmedAt.toISOString(),
                  }),
                ),
              remove: async (emailId) =>
                removeConnectionEmail((await connection()).connectionId, emailId),
            },
          },
        });
      },
    };
  });
