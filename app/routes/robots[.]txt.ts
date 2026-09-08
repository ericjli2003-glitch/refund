import { appOrigin } from "../services/customer-security.server";
export const loader = () =>
  new Response(
    `User-agent: *\nAllow: /stores\nDisallow: /app\nDisallow: /returns/\nDisallow: /customer/\nDisallow: /start-return\nDisallow: /api/\nDisallow: /agent/\nDisallow: /authorize\nDisallow: /token\nDisallow: /mcp\nSitemap: ${appOrigin()}/sitemap.xml\n`,
    {
      headers: {
        "Content-Type": "text/plain",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
