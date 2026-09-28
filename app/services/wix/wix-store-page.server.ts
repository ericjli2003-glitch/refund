import { data } from "react-router";
import prisma from "../../db.server";
import { appOrigin } from "../customer-security.server";
import { merchantProfilePath } from "../merchant-directory.server";
import { publicReturnGuidance } from "../return-guidance.server";
import { publicWebsite, requireInstalledWixSite } from "../store-platform.server";

// The public returns page for a Wix site, served at the same /stores/<shop>
// address as Shopify stores. Wix customers use the assistant connection only:
// there's no Shopify sign-in portal or in-page start-return tool to offer.
export async function wixStorePageData(shopParam: string) {
  const shop = await requireInstalledWixSite(shopParam);
  const merchant = await prisma.merchantDirectory.findUnique({
    where: { shop },
    select: { name: true, primaryDomain: true, discoveryPublished: true },
  });
  if (!merchant?.discoveryPublished)
    throw new Response("Store not published.", { status: 404 });
  const origin = appOrigin();
  return data(
    {
      wix: true as const,
      displayName: merchant.name,
      // Free Wix addresses aren't unique to one site, so those sites have no
      // website of their own on record.
      website: publicWebsite(merchant.primaryDomain),
      guidance: await publicReturnGuidance(shop),
      canonical: `${origin}${merchantProfilePath(shop)}`,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}
