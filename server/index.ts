import express from "express";
import { createRequestHandler } from "@react-router/express";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOAuthRouter } from "./oauth";

const app = express();
app.disable("x-powered-by");
// Render terminates HTTPS at its reverse proxy; URLs come from SHOPIFY_APP_URL,
// never from Host/forwarded headers. One trusted hop is used for rate limiting.
app.set("trust proxy", 1);
app.use(createOAuthRouter());
process.env.REFUND_OAUTH_HTTP_READY = "1";
app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);
app.use(express.static("build/client", { maxAge: "1h" }));
const buildUrl = pathToFileURL(resolve("build/server/index.js")).href;
app.all(
  "*",
  createRequestHandler({
    build: () => import(buildUrl),
    mode: process.env.NODE_ENV,
  }),
);
app.use(((error, _req, res, _next) => {
  void _next; // Express identifies error handlers by their four-argument signature.
  const status = error?.status === 413 ? 413 : 500;
  res
    .status(status)
    .set("Cache-Control", "no-store")
    .json({ error: status === 413 ? "request_too_large" : "server_error" });
}) as express.ErrorRequestHandler);
app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
  console.log("Refund HTTP server ready"),
);
