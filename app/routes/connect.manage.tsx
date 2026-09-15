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
import { assistantName, endConnection } from "../services/agent-access.server";
import {
  listConnectionEmails,
  removeConnectionEmail,
} from "../services/connection-email.server";
import {
  appOrigin,
  digest,
  keyedDigest,
  privateHeaders,
  safeEqual,
} from "../services/customer-security.server";
import { maskEmail } from "../services/email-address.server";
import { readConnectionBrowser } from "../services/connection-browser.server";
import { ConnectionError } from "../components/ConnectionError";
import "../styles/customer-returns.css";

export const headers = () => ({
  ...privateHeaders,
  "Content-Security-Policy":
    "frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
});

// Connections are managed from the browser that approved them, identified by
// the same HttpOnly cookie store links use; there's no Gooper.io account.
export async function loader({ request }: LoaderFunctionArgs) {
  const browser = await readConnectionBrowser(request);
  if (!browser)
    return data({ csrf: "", connections: [] }, { headers: headers() });
  const connections = await prisma.agentConnection.findMany({
    where: {
      browserHash: digest(browser),
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { stores: { select: { shop: true } } },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const names = await prisma.merchantDirectory.findMany({
    where: { shop: { in: connections.flatMap((entry) => entry.stores.map((store) => store.shop)) } },
    select: { shop: true, name: true },
  });
  return data(
    {
      csrf: keyedDigest("connection-manage", browser),
      connections: await Promise.all(
        connections.map(async (connection) => ({
          id: connection.id,
          assistant: await assistantName(connection.clientId),
          connectedOn: connection.createdAt.toISOString().slice(0, 10),
          emails: (await listConnectionEmails(connection.id)).map((entry) => ({
            id: entry.id,
            email: maskEmail(entry.email),
          })),
          stores: connection.stores.map(
            (store) => names.find((entry) => entry.shop === store.shop)?.name ?? store.shop,
          ),
        })),
      ),
    },
    { headers: headers() },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const browser = await readConnectionBrowser(request);
  const forbidden = new Response("Invalid request.", { status: 403, headers: privateHeaders });
  if (
    !browser ||
    request.headers.get("Origin") !== appOrigin() ||
    request.headers.get("Content-Type")?.split(";")[0] !==
      "application/x-www-form-urlencoded"
  )
    throw forbidden;
  const text = await request.text();
  if (text.length > 4096) throw forbidden;
  const form = new URLSearchParams(text);
  if (!safeEqual(form.get("csrf") || "", keyedDigest("connection-manage", browser)))
    throw forbidden;
  const connection = await prisma.agentConnection.findFirst({
    where: {
      id: form.get("connectionId") || "",
      browserHash: digest(browser),
      revokedAt: null,
    },
    select: { id: true },
  });
  if (!connection)
    throw new Response("That connection isn’t available.", {
      status: 404,
      headers: privateHeaders,
    });
  const intent = form.get("intent");
  if (intent === "remove_email")
    await removeConnectionEmail(connection.id, form.get("emailId") || "");
  else if (intent === "disconnect")
    await prisma.$transaction((tx) => endConnection(tx, connection.id));
  else throw new Response("Unknown request.", { status: 400, headers: privateHeaders });
  return redirect("/connect/manage", { headers: headers() });
}

export default function ManageConnection() {
  const { csrf, connections } = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";
  return (
    <main className="customer-returns connection-page">
      <header>
        <a href="/connect">← Gooper.io for every store</a>
        <span>GOOPER.IO · YOUR CONNECTION</span>
      </header>
      <h1>Your Gooper.io connection</h1>
      {connections.length === 0 ? (
        <p>
          There’s no Gooper.io connection in this browser. Connections are managed
          from the browser where you approved Gooper.io in your assistant.
        </p>
      ) : (
        connections.map((connection) => (
          <section key={connection.id} className="consent-email">
            <h2>{connection.assistant}</h2>
            <p className="consent-email-hint">Connected {connection.connectedOn}</p>
            <h3>Confirmed emails</h3>
            <p>
              Gooper.io uses these only to find your orders at stores that use
              Gooper.io. Never for marketing.
            </p>
            {connection.emails.length ? (
              <ul className="consent-email-list">
                {connection.emails.map((entry) => (
                  <li key={entry.id}>
                    <span>{entry.email}</span>
                    <Form method="post">
                      <input type="hidden" name="csrf" value={csrf} />
                      <input type="hidden" name="connectionId" value={connection.id} />
                      <input type="hidden" name="emailId" value={entry.id} />
                      <button
                        name="intent"
                        value="remove_email"
                        className="return-link"
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </Form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="consent-email-hint">No confirmed emails.</p>
            )}
            <h3>Connected stores</h3>
            {connection.stores.length ? (
              <ul>
                {connection.stores.map((store) => (
                  <li key={store}>{store}</li>
                ))}
              </ul>
            ) : (
              <p className="consent-email-hint">None yet.</p>
            )}
            <Form method="post">
              <input type="hidden" name="csrf" value={csrf} />
              <input type="hidden" name="connectionId" value={connection.id} />
              <p>
                Disconnecting removes Gooper.io from {connection.assistant}, deletes
                these emails and disconnects every store.
              </p>
              <button name="intent" value="disconnect" disabled={busy}>
                Disconnect {connection.assistant}
              </button>
            </Form>
          </section>
        ))
      )}
    </main>
  );
}

export function ErrorBoundary() {
  return <ConnectionError />;
}
