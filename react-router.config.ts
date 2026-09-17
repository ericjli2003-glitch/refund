import type { Config } from "@react-router/dev/config";

// `shopify app dev` serves actions through a tunnel, so the browser's Origin is
// the tunnel host while the local server sees localhost. Allow only the app's
// own dev URL, and only in development; production origins are listed above it.
function developmentAppHost() {
  if (process.env.NODE_ENV !== "development") return [];
  const url = process.env.SHOPIFY_APP_URL || process.env.HOST;
  try {
    return url ? [new URL(url).host] : [];
  } catch {
    return [];
  }
}

export default {
  allowedActionOrigins: [
    "gooper.io",
    "refund-ztxz.onrender.com",
    ...developmentAppHost(),
  ],
} satisfies Config;
