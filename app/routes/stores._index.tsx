import {
  useLoaderData,
  useActionData,
  Form,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { PublicShell } from "../components/PublicShell";
import {
  findPublishedMerchants,
  merchantProfilePath,
} from "../services/merchant-directory.server";
import styles from "../styles/public.module.css";
import { MerchantDiscoveryTools } from "../components/MerchantDiscoveryTools";
import {
  lookupMerchant,
  searchPublishedMerchants,
} from "../services/merchant-lookup.server";
import { opportunityLabel } from "../services/merchant-opportunity.server";
import { privateHeaders } from "../services/customer-security.server";

export const headers = () => privateHeaders;
export async function action({ request }: ActionFunctionArgs) {
  const raw = (await request.formData()).get("q");
  const query =
    typeof raw === "string" && raw.length <= 120 && opportunityLabel(raw)
      ? raw
      : "";
  const result = await lookupMerchant(query, true);
  return {
    query,
    merchants: result.merchants.map((merchant) => ({
      name: merchant.name,
      shop: merchant.shop,
      primaryDomain: merchant.domain,
      profilePath: merchantProfilePath(merchant.shop),
    })),
  };
}

export const meta: MetaFunction = () => [
  { title: "Find your store | Gooper.io returns" },
  {
    name: "description",
    content:
      "Find a participating store by name and securely start a return with Gooper.io.",
  },
];
export async function loader({ request }: LoaderFunctionArgs) {
  const query = new URL(request.url).searchParams.get("q")?.trim() || "";
  // Browsing lists every listed store; a search shows partial-name candidates.
  const merchants = query
    ? await searchPublishedMerchants(query)
    : await findPublishedMerchants();
  return {
    query,
    merchants: merchants.map((merchant) => ({
      ...merchant,
      profilePath: merchantProfilePath(merchant.shop),
    })),
  };
}
export default function Stores() {
  const initial = useLoaderData<typeof loader>();
  const submitted = useActionData<typeof action>();
  const { query, merchants } = submitted || initial;
  return (
    <PublicShell>
      <MerchantDiscoveryTools />
      <main className={styles.legal}>
        <p className={styles.eyebrow}>Customer returns</p>
        <h1>Find your store.</h1>
        <p>
          Choose the store you bought from. You’ll verify your purchase with
          Shopify before viewing your orders.
        </p>
        <Form method="post">
          <label>
            Store name{" "}
            <input
              name="q"
              defaultValue={query}
              maxLength={120}
              placeholder="The store's name"
            />
          </label>{" "}
          <button type="submit">Find store</button>
        </Form>
        {merchants.length ? (
          <ul>
            {merchants.map((merchant) => (
              <li key={merchant.shop}>
                <a href={merchant.profilePath}>{merchant.name} returns</a> ·{" "}
                {merchant.primaryDomain}
              </li>
            ))}
          </ul>
        ) : (
          <p>
            The store could not be uniquely identified. Nothing has been
            submitted.
          </p>
        )}
        <p>
          If the store cannot be found or uniquely identified, stop without
          starting a return. No merchant will be contacted.
        </p>
        <p>
          Gooper.io keeps a limited business-name discovery record for private
          service improvement and merchant opportunity review. Do not include
          personal or order details.
        </p>
      </main>
    </PublicShell>
  );
}
