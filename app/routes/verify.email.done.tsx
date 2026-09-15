import { data, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { privateHeaders } from "../services/customer-security.server";
import { ConnectionError } from "../components/ConnectionError";
import "../styles/customer-returns.css";

export const headers = () => privateHeaders;

const outcomes = {
  linked: {
    heading: "You’re all set",
    body: "Head back to your chat and your assistant will take it from here.",
  },
  mismatch: {
    heading: "That number didn’t match",
    body: "To keep your orders safe, we cancelled this request. Ask your assistant to send a new email and pick the number it shows you.",
  },
  denied: {
    heading: "Got it, nothing was connected",
    body: "No one can see your orders from this request. You can close this page.",
  },
  confirmed: {
    heading: "Email confirmed",
    body: "Go back to the Gooper.io page on your other device. It will update in a moment, and you can finish connecting there.",
  },
  connect_mismatch: {
    heading: "That number didn’t match",
    body: "To keep your orders safe, we cancelled this code. Send a new one from the Gooper.io page and pick the number it shows.",
  },
  connect_denied: {
    heading: "Got it, that email wasn’t added",
    body: "Nothing was confirmed. You can close this page.",
  },
};

export function loader({ request }: LoaderFunctionArgs) {
  const outcome = new URL(request.url).searchParams.get("outcome");
  return data(
    outcomes[outcome as keyof typeof outcomes] ?? outcomes.denied,
    { headers: privateHeaders },
  );
}

export default function EmailConfirmed() {
  const { heading, body } = useLoaderData<typeof loader>();
  return (
    <main className="customer-returns connection-page">
      <h1>{heading}</h1>
      <p>{body}</p>
    </main>
  );
}

export function ErrorBoundary() {
  return <ConnectionError />;
}
