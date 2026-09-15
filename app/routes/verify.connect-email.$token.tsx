import {
  Form,
  data,
  redirect,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { assistantName } from "../services/agent-access.server";
import {
  completeConsentTap,
  consentEmailContext,
  consentTapCsrf,
  getConsentTap,
} from "../services/consent-email.server";
import { privateHeaders, unseal } from "../services/customer-security.server";
import { maskEmail, numberChoices } from "../services/email-address.server";
import { ConnectionError } from "../components/ConnectionError";
import "../styles/customer-returns.css";

export const headers = () => ({
  ...privateHeaders,
  "Content-Security-Policy":
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
});

// The one-tap button from the connect email, opened on any device. Opening it
// changes nothing, so email scanners can't confirm on the customer's behalf.
export async function loader({ params }: LoaderFunctionArgs) {
  const check = await getConsentTap(params.token || "");
  return data(
    {
      assistant: await assistantName(check.request.clientId),
      sentTo: maskEmail(unseal(check.sealedEmail, consentEmailContext(check.id))),
      choices: numberChoices(check.matchNumber),
      csrf: consentTapCsrf(check.id),
    },
    { headers: headers() },
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { outcome } = await completeConsentTap(request, params.token || "");
  const page = { confirmed: "confirmed", mismatch: "connect_mismatch", denied: "connect_denied" };
  return redirect(
    `/verify/email/done?${new URLSearchParams({ outcome: page[outcome] })}`,
    { headers: headers() },
  );
}

export default function ConfirmConnectEmail() {
  const info = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";
  return (
    <main className="customer-returns connection-page">
      <h1>Confirm your email</h1>
      <p>
        You’re connecting {info.assistant} to Gooper.io with {info.sentTo}. Which
        number is the Gooper.io page showing?
      </p>
      <Form method="post">
        <input type="hidden" name="csrf" value={info.csrf} />
        <div className="button-row choice-row" role="group" aria-label="Number shown on the Gooper.io page">
          {info.choices.map((choice) => (
            <button key={choice} name="choice" value={choice} disabled={busy}>
              {choice}
            </button>
          ))}
        </div>
        <div className="button-row">
          <button name="choice" value="deny" disabled={busy}>
            I didn’t ask for this
          </button>
        </div>
      </Form>
      <p>
        Gooper.io uses this email only to find your orders at stores that use
        Gooper.io. Never for marketing.
      </p>
    </main>
  );
}

export function ErrorBoundary() {
  return <ConnectionError />;
}
