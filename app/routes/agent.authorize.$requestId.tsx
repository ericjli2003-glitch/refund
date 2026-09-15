import { useEffect, useState } from "react";
import {
  Form,
  data,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
} from "react-router";
import { ConnectionError } from "../components/ConnectionError";
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
  const finished = await finishAgentConsent(request, rawId);
  const location = finished.headers.get("Location");
  const callback = location ? new URL(location) : null;
  // Cancelling goes straight back. Allowing shows one last step first: setting
  // Gooper.io to Always allow, while the assistant's settings are a tap away.
  if (!callback?.searchParams.has("code")) return finished;
  const assistant = assistantForRedirect(flow.redirectUri);
  const setCookie = finished.headers.get("Set-Cookie");
  return data(
    {
      connected: {
        assistant,
        continueUrl: callback.href,
        settingsUrl: connectorSettingsUrl(assistant),
      },
    },
    { headers: { ...headers(), ...(setCookie ? { "Set-Cookie": setCookie } : {}) } },
  );
}

// Allow uses up the request, so reloading this page's data afterwards would
// fail; the last-step screen needs nothing more from the server.
export const shouldRevalidate: ShouldRevalidateFunction = ({
  actionResult,
  defaultShouldRevalidate,
}) =>
  actionResult && typeof actionResult === "object" && "connected" in actionResult
    ? false
    : defaultShouldRevalidate;

export function ErrorBoundary() {
  return <ConnectionError />;
}

// A picture of the setting to choose in the assistant, not a working control:
// the toggle itself lives in the assistant's own settings.
function AlwaysAllowPreview({ assistant }: { assistant: string }) {
  return (
    <figure className="setting-preview">
      <div className="setting-preview-row" aria-hidden="true">
        <span>Gooper.io tools</span>
        <span className="setting-preview-pill">✓ Always allow</span>
      </div>
      <figcaption>What to choose for Gooper.io in {assistant}’s connector settings</figcaption>
    </figure>
  );
}

const connectorSettingsUrl = (assistant: string) =>
  assistant === "ChatGPT"
    ? "https://chatgpt.com/#settings/Connectors"
    : "https://claude.ai/settings/connectors";

const AUTO_CONTINUE_SECONDS = 10;

function ConnectedStep({
  assistant,
  continueUrl,
  settingsUrl,
}: {
  assistant: string;
  continueUrl: string;
  settingsUrl: string;
}) {
  const [seconds, setSeconds] = useState(AUTO_CONTINUE_SECONDS);
  useEffect(() => {
    if (seconds <= 0) {
      window.location.assign(continueUrl);
      return;
    }
    const timer = window.setTimeout(() => setSeconds((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds, continueUrl]);
  return (
    <main className="customer-returns connection-page">
      <header>
        <span>GOOPER.IO</span>
        <span>STEP 3 OF 3</span>
      </header>
      <h1>You’re connected — one last step</h1>
      <p className="lead">
        Set Gooper.io to <strong>Always allow</strong> in {assistant}’s connector
        settings, so {assistant} can finish your returns without stopping to ask
        before each step.
      </p>
      <AlwaysAllowPreview assistant={assistant} />
      <div className="button-row">
        <a
          className="return-button"
          href={settingsUrl}
          target="_blank"
          rel="noopener noreferrer"
          // Finish connecting here, so Gooper.io is listed in the new tab.
          onClick={() => window.setTimeout(() => window.location.assign(continueUrl), 300)}
        >
          Open {assistant} connector settings ↗
        </a>
        <a className="return-button secondary" href={continueUrl}>
          Back to {assistant}
        </a>
      </div>
      <p className="consent-email-hint" role="status" aria-live="polite">
        {seconds > 0
          ? `Taking you back to ${assistant} in ${seconds} second${seconds === 1 ? "" : "s"}.`
          : `Taking you back to ${assistant}.`}{" "}
        If Gooper.io isn’t listed in settings yet, refresh that tab in a moment.
      </p>
      <details>
        <summary>What happens if I leave it on “Ask for approval”?</summary>
        <p>
          {assistant} stops and waits for you to tap Allow before each step:
          finding the store, looking up your order, working out your refund and
          submitting the return. One return can take four or more extra taps,
          and it pauses whenever you step away. Either way, Gooper.io only
          submits returns you ask for, and checks with you first if a fee
          applies.
        </p>
      </details>
    </main>
  );
}

const descriptions: Record<string, string> = {
  "returns:read": "Find your orders at stores that use Gooper.io, and what can be returned.",
  "returns:quote": "Work out the exact refund for the items you choose, including any fees.",
  "returns:submit":
    "Submit returns and refunds to your original payment method when you ask for them, checking with you first if a fee applies.",
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
  const result = useActionData<typeof action>();
  const connected = result && "connected" in result ? result.connected : null;
  const busy = useNavigation().state !== "idle";
  const needsEmail = info.emailStep && !info.emails.some((entry) => entry.confirmed);
  if (connected) return <ConnectedStep {...connected} />;
  const emailDone = !needsEmail;
  return (
    <main className="customer-returns connection-page">
      <header>
        <span>GOOPER.IO</span>
        <span>CONNECT {info.assistant.toUpperCase()}</span>
      </header>
      <h1>Connect {info.assistant} to Gooper.io</h1>
      <p className="lead">
        One connection works with every store that uses Gooper.io, so you can
        return things right in your chat.
      </p>
      <ol className="connect-steps">
        {info.emailStep && (
          <li className={emailDone ? "done" : "current"}>
            <EmailStep emails={info.emails} csrf={info.csrf} />
          </li>
        )}
        <li className={emailDone ? "current" : "upcoming"}>
          <section aria-labelledby="allow-step">
            <h2 id="allow-step">Allow {info.assistant}</h2>
            <p>
              {info.assistant} can find your orders and submit the returns you ask
              for. It checks with you first only if a fee would come out of your
              refund, and refunds go back to your original payment method.
            </p>
            <Form method="post">
              <input type="hidden" name="csrf" value={info.csrf} />
              <div className="button-row">
                <button name="decision" value="allow" disabled={busy || needsEmail}>
                  Allow {info.assistant} access
                </button>
                <button
                  name="decision"
                  value="deny"
                  className="secondary"
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
              {needsEmail && (
                <p className="consent-email-hint">Confirm your email first.</p>
              )}
            </Form>
          </section>
        </li>
        <li className="upcoming">
          <section aria-labelledby="always-allow">
            <h2 id="always-allow">Turn on Always allow</h2>
            <p>
              Right after you allow, one tap opens {info.assistant}’s connector
              settings. Set Gooper.io to <strong>Always allow</strong> so returns
              finish without stopping.
            </p>
            {emailDone && <AlwaysAllowPreview assistant={info.assistant} />}
            <details>
              <summary>What happens if I leave it on “Ask for approval”?</summary>
              <p>
                {info.assistant} stops and waits for you to tap Allow before each
                step: finding the store, looking up your order, working out your
                refund and submitting the return. One return can take four or more
                extra taps, and it pauses whenever you step away.
              </p>
            </details>
          </section>
        </li>
      </ol>
      <details className="fine-print">
        <summary>What {info.assistant} can do, and how your data is used</summary>
        <ul>
          {info.scopes.map((scope) => (
            <li key={scope}>{descriptions[scope]}</li>
          ))}
        </ul>
        <p>
          {info.emailStep
            ? "Gooper.io finds your order at a store using the emails you confirm here. If you used a different email, your assistant asks and sends a quick confirmation."
            : "When you ask about a return, your assistant asks for the email you used at that store and sends a quick confirmation."}{" "}
          Each store’s return rules still apply. Stores stay connected while you
          keep using them, and the connection ends after a year without use.
        </p>
        <p>
          See and remove your confirmed emails and stores at{" "}
          <a href="/connect/manage">your connection page</a> in this browser, or
          remove Gooper.io from your assistant at any time. Gooper.io sends the
          connection back to <strong>{info.callbackHost}</strong>.
        </p>
      </details>
    </main>
  );
}
