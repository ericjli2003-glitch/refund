import {
  Form,
  data,
  redirect,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import prisma from "../db.server";
import { assistantName } from "../services/agent-access.server";
import {
  getCustomerSession,
  requireInstalledShop,
} from "../services/customer-session.server";
import { privateHeaders } from "../services/customer-security.server";
import {
  completeStoreLink,
  getStoreLinkRequest,
} from "../services/store-link.server";
import "../styles/customer-returns.css";

export const headers = () => ({
  ...privateHeaders,
  "Content-Security-Policy":
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const raw = params.token || "";
  const link = await getStoreLinkRequest(request, raw);
  const shop = await requireInstalledShop(link.shop);
  const session = await getCustomerSession(request, shop);
  const url = new URL(request.url);
  const loginQuery = new URLSearchParams({ shop, linkRequest: raw });
  // Reuse the customer's live Shopify session silently when there is one, so
  // relinking an expired store is usually a single approval.
  if (
    !session &&
    !url.searchParams.has("silentTried") &&
    !url.searchParams.has("loginError")
  )
    throw redirect(`/customer/login?${loginQuery}&silent=1`, {
      headers: headers(),
    });
  const merchant = await prisma.merchantDirectory.findUnique({
    where: { shop },
    select: { name: true },
  });
  return data(
    {
      shop,
      storeName: merchant?.name ?? shop,
      assistant: await assistantName(link.connection.clientId),
      authenticated: Boolean(session),
      csrf: link.csrfToken,
      loginUrl: `/customer/login?${loginQuery}`,
      loginError: url.searchParams.has("loginError"),
    },
    { headers: headers() },
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const raw = params.token || "";
  const link = await getStoreLinkRequest(request, raw);
  const result = await completeStoreLink(
    request,
    raw,
    await getCustomerSession(request, link.shop),
  );
  return redirect(
    `/connect/stores/linked?${new URLSearchParams(
      result.linked ? { shop: result.shop } : { cancelled: "1" },
    )}`,
    { headers: headers() },
  );
}

export default function LinkStore() {
  const info = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";
  return (
    <main className="customer-returns">
      <h1>Link {info.storeName} to {info.assistant}</h1>
      <p>
        Store: <strong>{info.shop}</strong>
      </p>
      {info.loginError && (
        <p role="alert">Sign-in wasn’t completed. You can try again.</p>
      )}
      <p>
        Linking lets {info.assistant} find your purchases at this store, quote
        returns, and submit a return only after you confirm it in your chat. The
        link lasts up to four hours; after that your assistant sends a new link.
      </p>
      <p>
        <strong>Linking does not submit a return or refund.</strong> The store’s
        return rules still apply.
      </p>
      {info.authenticated ? (
        <p>
          Signed in to this store.{" "}
          <a href={info.loginUrl}>Sign in as a different customer</a>
        </p>
      ) : (
        <p>
          <a href={info.loginUrl}>Sign in with the email used for this purchase</a>
        </p>
      )}
      <Form method="post">
        <input type="hidden" name="csrf" value={info.csrf} />
        {info.authenticated && (
          <button name="decision" value="allow" disabled={busy}>
            Link {info.storeName}
          </button>
        )}
        <button name="decision" value="deny" disabled={busy}>
          Cancel
        </button>
      </Form>
    </main>
  );
}
