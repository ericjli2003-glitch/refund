import { isRouteErrorResponse, useRouteError } from "react-router";
import "../styles/customer-returns.css";

// A friendly page for expired or reused connection and confirmation links,
// instead of a bare status code.
export function ConnectionError() {
  const error = useRouteError();
  const response = isRouteErrorResponse(error) ? error : null;
  const message =
    response && typeof response.data === "string" && response.data.length < 300
      ? response.data
      : "Something went wrong on our side. Please try again in a moment.";
  const linkProblem = response !== null && response.status < 500;
  return (
    <main className="customer-returns connection-page">
      <header>
        <a href="/connect">← Gooper.io</a>
        <span>GOOPER.IO</span>
      </header>
      <h1>{linkProblem ? "This link can’t be used anymore" : "Something went wrong"}</h1>
      <p className="lead">{message}</p>
      <div className="button-row">
        <a className="return-button" href="/connect">
          How to connect Gooper.io
        </a>
      </div>
      <p className="consent-email-hint">
        Nothing was submitted and no refund was issued. Starting again from your
        assistant only takes a moment.
      </p>
    </main>
  );
}
