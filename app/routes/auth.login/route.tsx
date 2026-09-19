import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";

import { APP_STORE_URL } from "../../app-store";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

// Shopify sends merchants here with ?shop= when a session must be started
// outside the admin; login() then redirects to Shopify's OAuth. Nobody is ever
// asked to type a shop domain (App Store requirement 2.3.1): a visit without a
// shop goes home, and an invalid one points to the App Store.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!new URL(request.url).searchParams.get("shop")) throw redirect("/");
  return { errors: loginErrorMessage(await login(request)) };
};

export default function Auth() {
  const { errors } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="Install Gooper.io">
          <s-paragraph>
            {errors.shop ?? "Open Gooper.io from your Shopify admin."}
          </s-paragraph>
          <s-button href={APP_STORE_URL}>Open the Shopify App Store</s-button>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
