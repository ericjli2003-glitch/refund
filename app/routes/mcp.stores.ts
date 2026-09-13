import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createCustomerReturnsMcpServer } from "../mcp.server";
import {
  authorizeConnection,
  connectionStore,
  listConnectionStores,
  type AgentScope,
} from "../services/agent-access.server";
import { appOrigin } from "../services/customer-security.server";
import {
  handleAgentMcp,
  returnToolScopes,
} from "../services/agent-mcp-http.server";
import { findStore } from "../services/merchant-lookup.server";
import { linkStore } from "../services/email-verification.server";
import {
  listConnectionEmails,
  removeConnectionEmail,
} from "../services/connection-email.server";
import { maskEmail } from "../services/email-address.server";

const scopesByTool: Record<string, AgentScope> = {
  ...returnToolScopes,
  find_store: "returns:read",
  list_linked_stores: "returns:read",
  link_store: "returns:read",
  list_confirmed_emails: "returns:read",
  remove_confirmed_email: "returns:read",
};

// The all-stores connection. The resource path is static, so it never
// collides with a single store's /mcp/:shop connection.
const handle = (request: Request) =>
  handleAgentMcp(request, () => {
    const resourceMetadataUrl = new URL("/oauth/resource/stores", appOrigin()).href;
    return {
      resourceMetadataUrl,
      continueUrl: new URL("/connect", appOrigin()).href,
      note: "Connect Refund in your assistant with OAuth, then link each store you bought from. No return has been submitted.",
      scopesByTool,
      authorize: (authorization, scope) => authorizeConnection(authorization, scope),
      createServer: (authorization) => {
        const connection = () => authorizeConnection(authorization, "returns:read");
        return createCustomerReturnsMcpServer({
          resourceMetadataUrl,
          // Each call re-checks the connection, then that store's own link.
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

export const loader = ({ request }: LoaderFunctionArgs) => handle(request);
export const action = ({ request }: ActionFunctionArgs) => handle(request);
