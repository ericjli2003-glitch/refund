import { useEffect, useState } from "react";
import {
  Form,
  data,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import {
  assistantForRedirect,
  finishAgentConsent,
  getAgentAuthorizationRequest,
} from "../services/agent-oauth-flow.server";
import {
  consentEmailState,
  removeConsentEmail,
  resendConsentCode,
  sendConsentCode,
  verifyConsentCode,
} from "../services/consent-email.server";
import {
  appOrigin,
  privateHeaders,
  safeEqual,
} from "../services/customer-security.server";
import { emailConfigured } from "../services/email.server";
import "../styles/customer-returns.css";

export const headers = () => ({
  ...privateHeaders,
  "Content-Security-Policy":
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
});

type EmailEntry = Awaited<ReturnType<typeof consentEmailState>>[number];
type StepResult = { ok: boolean; message: string };

// One connection for every store in the Gooper.io network. It needs no store
// sign-in; once email is set up, the customer confirms the email they shop
// with before allowing it.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const flow = await getAgentAuthorizationRequest(request, params.requestId || "");
  const emailStep = emailConfigured();
  return data(
    {
      assistant: assistantForRedirect(flow.redirectUri),
      callbackHost: new URL(flow.redirectUri).hostname,
      scopes: flow.scopes,
      csrf: flow.csrfToken,
      emailStep,
      emails: emailStep ? await consentEmailState(flow.id) : ([] as EmailEntry[]),
    },
    { headers: headers() },
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const rawId = params.requestId || "";
  const flow = await getAgentAuthorizationRequest(request, rawId);
  const text = await request.clone().text();
  if (text.length > 8192)
    throw new Response("Request too large.", { status: 413, headers: privateHeaders });
  const form = new URLSearchParams(text);
  // Email-step actions stay on this page; Allow and Cancel finish consent.
  if (form.has("intent")) {
    if (
      request.headers.get("Origin") !== appOrigin() ||
      request.headers.get("Content-Type")?.split(";")[0] !==
        "application/x-www-form-urlencoded" ||
      form.getAll("csrf").length !== 1 ||
      !safeEqual(form.get("csrf") || "", flow.csrfToken)
    )
      throw new Response("Invalid request.", { status: 403, headers: privateHeaders });
    const checkId = form.get("checkId") || "";
    const respond = (result: StepResult) => data(result, { headers: headers() });
    switch (form.get("intent")) {
      case "send":
        return respond(await sendConsentCode(flow, form.get("email") || ""));
      case "resend":
        return respond(await resendConsentCode(flow, checkId));
      case "verify":
        return respond(await verifyConsentCode(flow.id, checkId, form.get("code") || ""));
      case "remove":
        return respond(await removeConsentEmail(flow.id, checkId));
    }
    throw new Response("Unknown request.", { status: 400, headers: privateHeaders });
  }
  return finishAgentConsent(request, rawId);
}

const descriptions: Record<string, string> = {
  "returns:read": "Find your orders at stores that use Gooper.io, and what can be returned.",
  "returns:quote": "Work out the exact refund for the items you choose, including any fees.",
  "returns:submit":
    "Submit returns and refunds to your original payment method, each one after you confirm it in your chat.",
};

function Note({ result }: { result?: StepResult }) {
  if (!result) return null;
  return (
    <p role={result.ok ? "status" : "alert"} className="consent-email-note">
      {result.message}
    </p>
  );
}

function PendingEmail({ entry, csrf }: { entry: EmailEntry; csrf: string }) {
  const verify = useFetcher<StepResult>();
  const resend = useFetcher<StepResult>();
  const busy = verify.state !== "idle" || resend.state !== "idle";
  return (
    <div className="consent-email-pending">
      <verify.Form method="post">
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="intent" value="verify" />
        <input type="hidden" name="checkId" value={entry.id} />
        <label>
          Enter the 6-digit code we sent to {entry.email}
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
          />
        </label>
        <button disabled={busy}>Confirm</button>
      </verify.Form>
      <Note result={verify.data} />
      <p className="consent-email-hint">
        Opened the email on another device? Tap the button there and choose{" "}
        <strong>{entry.matchNumber}</strong>. This page will update on its own.
      </p>
      <resend.Form method="post">
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="intent" value="resend" />
        <input type="hidden" name="checkId" value={entry.id} />
        <button className="return-link" disabled={busy}>
          Didn’t get it? Resend code
        </button>
      </resend.Form>
      <Note result={resend.data} />
    </div>
  );
}

function ConfirmedEmail({ entry, csrf }: { entry: EmailEntry; csrf: string }) {
  const remove = useFetcher<StepResult>();
  return (
    <li>
      <span>✓ {entry.email}</span>
      <remove.Form method="post">
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="intent" value="remove" />
        <input type="hidden" name="checkId" value={entry.id} />
        <button className="return-link" disabled={remove.state !== "idle"}>
          Remove
        </button>
      </remove.Form>
    </li>
  );
}

function EmailStep({ emails, csrf }: { emails: EmailEntry[]; csrf: string }) {
  const add = useFetcher<StepResult>();
  const revalidator = useRevalidator();
  const [adding, setAdding] = useState(false);
  const confirmed = emails.filter((entry) => entry.confirmed);
  const pending = emails.filter((entry) => !entry.confirmed);
  // Picks up a tap on the email's button from another device.
  useEffect(() => {
    if (!pending.length) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle")
        void revalidator.revalidate();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [pending.length, revalidator]);
  useEffect(() => {
    if (add.state === "idle" && add.data?.ok) setAdding(false);
  }, [add.state, add.data]);
  const showForm = emails.length === 0 || adding;
  return (
    <section className="consent-email" aria-labelledby="confirm-email">
      <h2 id="confirm-email">Confirm your email</h2>
      <p>
        Gooper.io uses it to find your orders at any store that uses Gooper.io, so
        returns in your chat just work. We never use it for marketing.
      </p>
      {confirmed.length > 0 && (
        <ul className="consent-email-list">
          {confirmed.map((entry) => (
            <ConfirmedEmail key={entry.id} entry={entry} csrf={csrf} />
          ))}
        </ul>
      )}
      {pending.map((entry) => (
        <PendingEmail key={entry.id} entry={entry} csrf={csrf} />
      ))}
      {showForm ? (
        <add.Form method="post">
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="intent" value="send" />
          <label>
            What email do you use when you shop online?
            <input type="email" name="email" autoComplete="email" required />
          </label>
          <button disabled={add.state !== "idle"}>Send code</button>
          {add.data && !add.data.ok && <Note result={add.data} />}
        </add.Form>
      ) : (
        <button type="button" className="return-link" onClick={() => setAdding(true)}>
          + Add another email
        </button>
      )}
    </section>
  );
}

export default function AgentConsent() {
  const info = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";
  const needsEmail = info.emailStep && !info.emails.some((entry) => entry.confirmed);
  return (
    <main className="customer-returns">
      <h1>Connect {info.assistant} to Gooper.io</h1>
      <p>
        One connection works with every store that uses Gooper.io, so you can start
        a return with any of them right in your chat.
      </p>
      <p>
        Gooper.io will send the connection back to{" "}
        <strong>{info.callbackHost}</strong>.
      </p>
      {info.emailStep && <EmailStep emails={info.emails} csrf={info.csrf} />}
      <h2>What {info.assistant} can do</h2>
      <ul>
        {info.scopes.map((scope) => (
          <li key={scope}>{descriptions[scope]}</li>
        ))}
      </ul>
      <p>
        <strong>
          {info.assistant} can submit returns and refunds for you.
        </strong>{" "}
        It always shows you the exact items, any fees and your refund first, and
        only goes ahead when you say yes. Refunds go back to your original
        payment method, and each store’s return rules still apply.
      </p>
      <p>
        {info.emailStep
          ? "When you ask about a return, Gooper.io finds your order at that store using the emails you confirm here, so there’s usually nothing else to do. If you used a different email, your assistant asks and sends a quick confirmation."
          : "When you ask about a return, your assistant asks for the email you used at that store and sends a quick confirmation."}
      </p>
      <p>
        Stores stay connected while you keep using them, and the connection ends
        after a year without use. See and remove your confirmed emails and stores
        at <a href="/connect/manage">your connection page</a> in this browser, or
        remove Gooper.io from your assistant at any time.
      </p>
      <Form method="post">
        <input type="hidden" name="csrf" value={info.csrf} />
        <button name="decision" value="allow" disabled={busy || needsEmail}>
          Allow {info.assistant} access
        </button>
        <button name="decision" value="deny" disabled={busy}>
          Cancel connection
        </button>
        {needsEmail && (
          <p className="consent-email-hint">Confirm an email above to continue.</p>
        )}
      </Form>
    </main>
  );
}
