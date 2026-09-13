import { data, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { privateHeaders } from "../services/customer-security.server";
import "../styles/customer-returns.css";

export const headers = () => privateHeaders;

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  return data(
    {
      cancelled: url.searchParams.has("cancelled"),
      shop:
        shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null,
    },
    { headers: privateHeaders },
  );
}

export default function StoreLinked() {
  const { cancelled, shop } = useLoaderData<typeof loader>();
  return (
    <main className="customer-returns">
      <h1>{cancelled ? "Store link cancelled" : "Store linked"}</h1>
      <p>
        {cancelled
          ? "Nothing was linked. You can close this page."
          : `Your assistant can now find your purchases at ${shop ?? "this store"}. Go back to your conversation to continue.`}
      </p>
      <p>No return or refund has been submitted.</p>
    </main>
  );
}
