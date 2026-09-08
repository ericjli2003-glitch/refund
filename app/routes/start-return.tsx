import {
  data,
  redirect,
  useLoaderData,
  type LoaderFunctionArgs,
} from "react-router";
import {
  intakeSchema,
  startReturnIntake,
} from "../services/return-intake.server";
import { privateHeaders } from "../services/customer-security.server";
import "../styles/customer-returns.css";

export const headers = () => privateHeaders;
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  if (!url.searchParams.has("merchant"))
    return data({ error: "" }, { headers: privateHeaders });
  const parsed = intakeSchema.safeParse({
    merchant: url.searchParams.get("merchant"),
    orderName: url.searchParams.get("orderName") || undefined,
    itemName: url.searchParams.get("itemName") || undefined,
  });
  if (!parsed.success)
    return data(
      {
        error:
          "Enter the store name or website. Order and item details must each be 120 characters or fewer.",
      },
      { status: 400, headers: privateHeaders },
    );
  try {
    const result = await startReturnIntake(parsed.data);
    if (result.status === "verification_required")
      return redirect(result.continueUrl, { headers: privateHeaders });
    return data({ error: result.message }, { headers: privateHeaders });
  } catch {
    return data(
      {
        error:
          "We could not verify that store. Check its website address and try again.",
      },
      { status: 503, headers: privateHeaders },
    );
  }
}

export default function StartReturn() {
  const { error } = useLoaderData<typeof loader>();
  return (
    <main className="customer-returns">
      <header>
        <span>REFUND · CUSTOMER RETURNS</span>
      </header>
      <h1>Where did you buy it?</h1>
      <p>
        Enter the store name or website to find its return service. You’ll verify your
        purchase with the store before reviewing a refund.
      </p>
      {error && (
        <section className="return-error" role="alert">
          {error}
        </section>
      )}
      <section>
        <form method="get" className="return-intake-form">
          <label>
            Store name or website
            <input
              name="merchant"
              type="text"
              required
              maxLength={2048}
              placeholder="Testing Storefront or store.example.com"
              autoComplete="off"
            />
          </label>
          <label>
            Order number (optional)
            <input
              name="orderName"
              type="text"
              maxLength={120}
              placeholder="#1001"
            />
          </label>
          <label>
            Item (optional)
            <input
              name="itemName"
              type="text"
              maxLength={120}
              placeholder="Snowboard"
            />
          </label>
          <button type="submit">Continue</button>
        </form>
      </section>
      <footer>
        Nothing is submitted until you confirm the exact items and refund
        amount. <a href="/privacy">Privacy</a>
      </footer>
    </main>
  );
}
