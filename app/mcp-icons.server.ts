import { appOrigin } from "./services/customer-security.server";

// The icon assistants show beside Gooper.io's MCP servers, advertised in each
// server's initialize response. Icons must be absolute URLs, so they are built
// from the app origin; the files live in public/.
//
// PNG comes first because MCP clients that render icons must support PNG,
// while SVG support is optional.
export function gooperMcpIcons() {
  let origin: string;
  try {
    origin = appOrigin();
  } catch {
    // No HTTPS origin configured. An icon is cosmetic, so the server starts
    // without one rather than failing.
    return undefined;
  }
  return [
    {
      src: `${origin}/gooper-icon.png`,
      mimeType: "image/png",
      sizes: ["512x512"],
    },
    {
      src: `${origin}/gooper-icon.svg`,
      mimeType: "image/svg+xml",
      sizes: ["any"],
    },
  ];
}
