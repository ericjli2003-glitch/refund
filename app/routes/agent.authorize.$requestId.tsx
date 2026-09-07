import {
  Form,
  data,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import {
  assistantForRedirect,
  finishAgentConsent,
  getAgentAuthorizationRequest,
} from "../services/agent-oauth-flow.server";
import {
  getCustomerSession,
  requireInstalledShop,
} from "../services/customer-session.server";
import { privateHeaders } from "../services/customer-security.server";
import "../styles/customer-returns.css";

export const headers = () => ({
  ...privateHeaders,
  "Content-Security-Policy":
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const rawId = params.requestId || "";
  const flow = await getAgentAuthorizationRequest(request, rawId);
  await requireInstalledShop(flow.shop);
  const session = await getCustomerSession(request, flow.shop);
  return data(
    {
      shop: flow.shop,
      assistant: assistantForRedirect(flow.redirectUri),
      callbackHost: new URL(flow.redirectUri).hostname,
      scopes: flow.scopes,
      authenticated: Boolean(session),
      csrf: flow.csrfToken,
      loginUrl: `/customer/login?${new URLSearchParams({ shop: flow.shop, agentRequest: rawId })}`,
      loginError: new URL(request.url).searchParams.has("loginError"),
    },
    { headers: headers() },
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const rawId = params.requestId || "";
  const flow = await getAgentAuthorizationRequest(request, rawId);
  const session = await getCustomerSession(request, flow.shop);
  return finishAgentConsent(request, rawId, session);
}

const descriptions: Record<string, string> = {
  "returns:read": "Find your purchased items and whether they can be returned.",
  "returns:quote": "Calculate the exact refund amount for items you select.",
  "returns:submit":
    "Submit a return and refund only after you explicitly confirm the exact items and amount in your chat.",
};

export default function AgentConsent() {
  const info = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";
  return (
    <main className="customer-returns">
      <h1>Connect {info.assistant} to your returns</h1>
      <p>
        Merchant: <strong>{info.shop}</strong>
      </p>
      <p>
        Refund will send the connection back to{" "}
        <strong>{info.callbackHost}</strong>.
      </p>
      {info.loginError && (
        <p role="alert">
          Sign-in wasn’t completed. You can try again or cancel this connection.
        </p>
      )}
      <h2>What this assistant is requesting</h2>
      <ul>
        {info.scopes.map((scope) => (
          <li key={scope}>{descriptions[scope]}</li>
        ))}
      </ul>
      <p>
        Access lasts up to one hour, or until your customer session ends. Your
        Shopify sign-in credentials stay private. You can disconnect this
        assistant from the return portal.
      </p>
      <p>
        <strong>Connecting does not submit a return or refund.</strong> The
        merchant’s return rules still apply.
      </p>
      {!info.authenticated && (
        <p>
          <a href={info.loginUrl}>
            Sign in with the email used for this purchase
          </a>
        </p>
      )}
      {info.authenticated && (
        <p>
          Using your verified customer session for this merchant.{" "}
          <a href={info.loginUrl}>Sign in as a different customer</a>
        </p>
      )}
      <Form method="post">
        <input type="hidden" name="csrf" value={info.csrf} />
        {info.authenticated && (
          <button name="decision" value="allow" disabled={busy}>
            Allow {info.assistant} access
          </button>
        )}
        <button name="decision" value="deny" disabled={busy}>
          Cancel connection
        </button>
      </Form>
    </main>
  );
}
