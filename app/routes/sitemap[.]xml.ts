import {
  findPublishedMerchants,
  merchantProfilePath,
} from "../services/merchant-directory.server";
import { appOrigin } from "../services/customer-security.server";
export async function loader() {
  const profiles = await findPublishedMerchants();
  const escape = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  const urls = [
    appOrigin() + "/stores",
    ...profiles.map(
      (profile) => appOrigin() + merchantProfilePath(profile.shop),
    ),
  ];
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${escape(url)}</loc></url>`).join("")}</urlset>`,
    {
      headers: {
        "Content-Type": "application/xml",
        "Cache-Control": "public, max-age=60",
      },
    },
  );
}
