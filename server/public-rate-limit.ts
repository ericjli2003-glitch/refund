import type { RequestHandler } from "express";
import {
  consumePublicRateLimit,
  type RatePolicy,
} from "../app/services/public-rate-limit.server";

export function publicRatePolicy(path: string): RatePolicy | null {
  // React Router's single-fetch .data URL invokes the same loader as the HTML
  // entry point. Navigation must share its quota with direct page requests.
  const normalized = path.toLowerCase().replace(/\/+$/, "").replace(/\.data$/, "");
  if (normalized === "/register")
    return { bucket: "register", limit: 20, seconds: 3600 };
  if (normalized === "/authorize")
    return { bucket: "authorize", limit: 60, seconds: 600 };
  if (normalized === "/token" || normalized === "/revoke")
    return { bucket: "oauth-token", limit: 120, seconds: 60 };
  if (["/mcp", "/api/return-intake", "/start-return"].includes(normalized))
    return { bucket: "intake", limit: 120, seconds: 60 };
  if (
    [
      "/api/merchant-readiness",
      "/api/merchants",
      "/api/merchant-discovery-failure",
    ].includes(normalized)
  )
    return { bucket: "discovery", limit: 60, seconds: 60 };
  return null;
}

export function trustedProxyHops(
  value = process.env.REFUND_TRUST_PROXY_HOPS ?? "1",
) {
  if (!/^[0-5]$/.test(value))
    throw new Error("REFUND_TRUST_PROXY_HOPS must be an integer from 0 to 5.");
  return Number(value);
}

export function createPublicRateLimiter(
  consume = consumePublicRateLimit,
): RequestHandler {
  return (req, res, next) => {
    const policy = publicRatePolicy(req.path);
    if (!policy || req.method === "OPTIONS") return next();
    // req.ip is resolved by Express using the deployment's trusted proxy count.
    // Never read the first X-Forwarded-For entry supplied by a caller.
    void consume(req.ip || req.socket.remoteAddress || "unknown", policy)
      .then((result) => {
        if (result.allowed) return next();
        res
          .set({
            "Cache-Control": "no-store",
            "Retry-After": String(result.retryAfter),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Retry-After",
          })
          .status(429)
          .json({
            error: "too_many_requests",
            message: "Please retry after the indicated delay.",
          });
      })
      .catch(() => {
        res
          .set({
            "Cache-Control": "no-store",
            "Retry-After": "5",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Retry-After",
          })
          .status(503)
          .json({ error: "temporarily_unavailable" });
      });
  };
}
