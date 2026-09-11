import source from "../../extensions/refund-site-tools/assets/refund-site-tools.js?raw";

// The public merchant profile uses exactly the same top-level registration as
// the theme embed. Installing the app is sufficient for the hosted surface.
export const loader = () =>
  new Response(source, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
