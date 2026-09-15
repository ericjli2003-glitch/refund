import type { LoaderFunctionArgs } from "react-router";
import { merchantReadiness } from "../services/merchant-readiness.server";
import { resolveMerchant } from "../services/merchant-directory.server";
import { intakeHeaders } from "../services/public-intake-http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const merchant = new URL(request.url).searchParams.get("merchant") || "";
  try {
    const store = await resolveMerchant(merchant);
    if (!store)
      return Response.json(
        {
          status: "not_ready",
          connected: false,
          reason: "merchant_not_connected",
          recovery:
            "Check the store name or website. The merchant needs to install Gooper.io to provide a hosted return portal.",
        },
        { status: 404, headers: intakeHeaders },
      );
    const readiness = await merchantReadiness(store.shop);
    return Response.json(
      {
        ...readiness,
        connected: true,
        merchant: store,
        siteTools: {
          topLevelRegistrationRequired: true,
          tools: ["get_store_return_options", "start_return"],
        },
      },
      { headers: intakeHeaders },
    );
  } catch {
    return Response.json(
      {
        status: "unavailable",
        connected: false,
        recovery: "Retry later or contact the merchant's support team.",
      },
      { status: 503, headers: intakeHeaders },
    );
  }
}
