import { createCookie } from "react-router";
import { CONNECTION_IDLE_MS } from "./agent-access.server";

// Identifies the browser that approved an all-stores connection. The
// connection page (/connect/manage) opens only in that browser.
export const connectionBrowserCookie = createCookie("__Host-refund_connection", {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: CONNECTION_IDLE_MS / 1000,
});

const OPAQUE_TOKEN = /^[\w-]{43}$/;

export async function readConnectionBrowser(request: Request) {
  const raw: unknown = await connectionBrowserCookie.parse(
    request.headers.get("Cookie"),
  );
  return typeof raw === "string" && OPAQUE_TOKEN.test(raw) ? raw : null;
}
