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
  privateHeaders,
  unseal,
} from "../services/customer-security.server";
import {
  completeEmailVerification,
  getEmailVerification,
  maskEmail,
  numberChoices,
  verificationEmailContext,
} from "../services/email-verification.server";
import "../styles/customer-returns.css";

export const headers = () => ({
  ...privateHeaders,
  "Content-Security-Policy":
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
});

// Opening the link changes nothing, so email security scanners that follow
// links can't confirm on the customer's behalf; only the form does.
export async function loader({ params }: LoaderFunctionArgs) {
  const check = await getEmailVerification(params.token || "");
  const merchant = await prisma.merchantDirectory.findUnique({
    where: { shop: check.shop },
    select: { name: true },
  });
  return data(
    {
      storeName: merchant?.name ?? check.shop,
      assistant: await assistantName(check.connection.clientId),
      sentTo: maskEmail(unseal(check.sealedEmail, verificationEmailContext(check.id))),
      choices: numberChoices(check.matchNumber),
      csrf: check.csrfToken,
    },
    { headers: headers() },
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  const result = await completeEmailVerification(request, params.token || "");
  return redirect(
    `/verify/email/done?${new URLSearchParams({ outcome: result.outcome })}`,
    { headers: headers() },
  );
}

export default function ConfirmEmail() {
  const info = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";
  return (
    <main className="customer-returns">
      <h1>One quick check</h1>
      <p>
        You asked {info.assistant} to help with a return from{" "}
        <strong>{info.storeName}</strong>, using {info.sentTo}.
      </p>
      <p>Which number is {info.assistant} showing you?</p>
      <Form method="post">
        <input type="hidden" name="csrf" value={info.csrf} />
        <div role="group" aria-label="Number shown in your chat">
          {info.choices.map((choice) => (
            <button key={choice} name="choice" value={choice} disabled={busy}>
              {choice}
            </button>
          ))}
        </div>
        <p>
          <button name="choice" value="deny" disabled={busy}>
            I didn’t ask for this
          </button>
        </p>
      </Form>
      <p>
        This lets {info.assistant} find your orders at {info.storeName} and
        submit returns and refunds for you, each one after you say yes in your
        chat.
      </p>
    </main>
  );
}
