import {
  useLoaderData,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { PublicShell } from "../components/PublicShell";
import {
  findPublishedMerchants,
  merchantProfilePath,
} from "../services/merchant-directory.server";
import styles from "../styles/public.module.css";

export const meta: MetaFunction = () => [
  { title: "Find your store | Refund returns" },
  {
    name: "description",
    content:
      "Find a participating store by name and securely start a return with Refund.",
  },
];
export async function loader({ request }: LoaderFunctionArgs) {
  const query = new URL(request.url).searchParams.get("q")?.trim() || "";
  const merchants = await findPublishedMerchants(query);
  return {
    query,
    merchants: merchants.map((merchant) => ({
      ...merchant,
      profilePath: merchantProfilePath(merchant.shop),
    })),
  };
}
export default function Stores() {
  const { query, merchants } = useLoaderData<typeof loader>();
  return (
    <PublicShell>
      <main className={styles.legal}>
        <p className={styles.eyebrow}>Customer returns</p>
        <h1>Find your store.</h1>
        <p>
          Choose the store you bought from. You’ll verify your purchase with
          Shopify before viewing your orders.
        </p>
        <form method="get">
          <label>
            Store name{" "}
            <input
              name="q"
              defaultValue={query}
              maxLength={120}
              placeholder="Testing Storefront"
            />
          </label>{" "}
          <button type="submit">Find store</button>
        </form>
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
            No published store matched.{" "}
            <a href="/start-return">Use the store website instead.</a>
          </p>
        )}
        <p>If multiple stores match, confirm the website before continuing.</p>
      </main>
    </PublicShell>
  );
}
