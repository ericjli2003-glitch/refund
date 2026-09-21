import {
  data,
  useLoaderData,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { PublicShell } from "../components/PublicShell";
import prisma from "../db.server";
import { requireInstalledShop } from "../services/customer-session.server";
import { appOrigin } from "../services/customer-security.server";
import { merchantProfilePath } from "../services/merchant-directory.server";
import { publicReturnGuidance } from "../services/return-guidance.server";
import styles from "../styles/public.module.css";

export async function loader({ params }: LoaderFunctionArgs) {
  const shop = await requireInstalledShop(params.shop || "");
  const merchant = await prisma.merchantDirectory.findUnique({
    where: { shop },
    select: { shop: true, name: true, primaryDomain: true, discoveryPublished: true },
  });
  if (!merchant?.discoveryPublished)
    throw new Response("Store not published.", { status: 404 });
  const origin = appOrigin();
  // Always the store's own name as Shopify reports it. A public profile must
  // not show a store under any other label.
  const displayName = merchant.name;
  return data(
    {
      merchant,
      displayName,
      origin,
      guidance: await publicReturnGuidance(shop),
      canonical: `${origin}${merchantProfilePath(shop)}`,
      continueUrl: `${origin}/start-return?merchant=${encodeURIComponent(shop)}`,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}
export const meta: MetaFunction<typeof loader> = ({ data: value }) =>
  value
    ? [
        { title: `${value.displayName} returns | Gooper.io` },
        {
          name: "description",
          content: `Return a purchase from ${value.displayName} (${value.merchant.name}) with Gooper.io. Verify with Shopify, find your items, and review a return quote.`,
        },
        { tagName: "link", rel: "canonical", href: value.canonical },
      ]
    : [{ title: "Store not found | Gooper.io" }];

export default function MerchantReturns() {
  const { merchant, displayName, origin, guidance, canonical, continueUrl } =
    useLoaderData<typeof loader>();
  const structured = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${displayName} returns`,
    url: canonical,
    about: {
      "@type": "Organization",
      name: merchant.name,
      alternateName: displayName,
      url: `https://${merchant.primaryDomain}`,
    },
    description:
      "Verify a purchase with Shopify and review a return estimate with Gooper.io. Eligibility and merchant approval are checked separately.",
  };
  return (
    <PublicShell>
      <main
        className={styles.legal}
        data-refund-site-tools
        data-shop-domain={merchant.shop}
        data-shop-name={displayName}
        data-portal-url={continueUrl}
        data-intake-api-url={`${origin}/api/return-intake`}
        data-customer-authenticated="false"
      >
        <p className={styles.eyebrow}>Returns with Gooper.io</p>
        <h1>{displayName} returns.</h1>
        <p>
          Bought something from {displayName}? Start here to verify your
          purchase, find the item, and review a return estimate.
        </p>
        <p>
          Store:{" "}
          <a href={`https://${merchant.primaryDomain}`}>
            {merchant.primaryDomain}
          </a>
          . Shopify store name: {merchant.name}.
        </p>
        <p>
          <a className="refund-site-tools__account-link" href={continueUrl}>
            Start a return
          </a>
        </p>
        <h2>{`Return a purchase from ${displayName}`}</h2>
        <p>
          Tell your assistant which item you want to return from {displayName}.
        </p>
        {(guidance.returnPolicyUrl || guidance.returnInstructions) && (
          <section aria-label={`${displayName} return policy`}>
            <h2>{displayName}&apos;s return policy</h2>
            {guidance.returnPolicyUrl && (
              <p>
                <a href={guidance.returnPolicyUrl} rel="noreferrer">
                  Read the full return policy
                </a>
              </p>
            )}
            {guidance.returnInstructions && (
              <p style={{ whiteSpace: "pre-line" }}>
                {guidance.returnInstructions}
              </p>
            )}
          </section>
        )}
        <p>
          Complete Shopify verification yourself. Review the exact item and
          quote before any further action. A quote is an estimate; it does not
          send a return request or guarantee merchant approval.
        </p>
        <p>
          Compatible assistants can use <code>start_return</code> on this page,
          open the returned link, then use <code>get_return_session</code>,{" "}
          <code>find_returnable_items</code>, and <code>quote_return</code>{" "}
          after customer verification.
        </p>
        <p>
          <a href="/stores">Find another store</a>
        </p>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structured).replace(/</g, "\\u003c"),
          }}
        />
        <script src="/store-tools.js" defer />
      </main>
    </PublicShell>
  );
}
