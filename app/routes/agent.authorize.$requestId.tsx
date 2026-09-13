import {
  Form,
  data,
  redirect,
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
  const url = new URL(request.url);
  const common = {
    assistant: assistantForRedirect(flow.redirectUri),
    callbackHost: new URL(flow.redirectUri).hostname,
    scopes: flow.scopes,
    csrf: flow.csrfToken,
    loginError: url.searchParams.has("loginError"),
  };
  // The all-stores connection is approved without any store sign-in.
  if (flow.shop === null)
    return data(
      {
        ...common,
        allStores: true,
        shop: null,
        authenticated: false,
        loginUrl: "",
      },
      { headers: headers() },
    );
  const shop = await requireInstalledShop(flow.shop);
  const session = await getCustomerSession(request, shop);
  const loginQuery = new URLSearchParams({ shop, agentRequest: rawId });
  // Try the customer's live Shopify session once, silently, so reconnecting an
  // expired assistant usually needs no code. The consent click still follows.
  if (
    !session &&
    !url.searchParams.has("silentTried") &&
    !url.searchParams.has("loginError")
  )
    throw redirect(`/customer/login?${loginQuery}&silent=1`, {
      headers: headers(),
    });
  return data(
    {
      ...common,
      allStores: false,
      shop,
      authenticated: Boolean(session),
      loginUrl: `/customer/login?${loginQuery}`,
    },
    { headers: headers() },
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const rawId = params.requestId || "";
  const flow = await getAgentAuthorizationRequest(request, rawId);
  const session = flow.shop
    ? await getCustomerSession(request, flow.shop)
    : null;
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
      <h1>
        {info.allStores
          ? `Connect ${info.assistant} to Refund for every store`
          : `Connect ${info.assistant} to your returns`}
      </h1>
      {info.allStores ? (
        <p>This connection works with every store that uses Refund.</p>
      ) : (
        <p>
          Merchant: <strong>{info.shop}</strong>
        </p>
      )}
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
      {info.allStores ? (
        <>
          <p>
            Approving this doesn’t give access to any purchases yet. When you
            ask about a return, your assistant asks for the email you used at
            that store, and Refund sends you a one-tap confirmation. A few
            stores ask you to sign in with Shopify instead; open those links in
            this browser.
          </p>
          <p>
            Most stores stay linked while you keep using them; a store can ask
            you to sign in again after four hours. The connection ends after a
            year without use. You can unlink a store from that store’s return
            portal, or remove Refund from your assistant at any time.
          </p>
        </>
      ) : (
        <p>
          The assistant receives short-lived access that may refresh only while
          your verified customer session remains active, for up to four hours.
          Your Shopify sign-in credentials stay private. You can disconnect this
          assistant from the return portal at any time.
        </p>
      )}
      <p>
        <strong>Connecting does not submit a return or refund.</strong> The
        merchant’s return rules still apply.
      </p>
      {!info.allStores && !info.authenticated && (
        <p>
          <a href={info.loginUrl}>Sign in with the email used for this purchase</a>
        </p>
      )}
      {!info.allStores && info.authenticated && (
        <p>
          Using your verified customer session for this merchant.{" "}
          <a href={info.loginUrl}>Sign in as a different customer</a>
        </p>
      )}
      <Form method="post">
        <input type="hidden" name="csrf" value={info.csrf} />
        {(info.allStores || info.authenticated) && (
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
