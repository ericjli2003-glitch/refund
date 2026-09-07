import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
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
            "Check the store website. The merchant may need to install Refund and enable the AI return assistance theme app embed.",
        },
        { status: 404, headers: intakeHeaders },
      );
    const policy = await prisma.storePolicy.findUnique({
      where: { shop: store.shop },
      select: {
        automaticRefundsEnabled: true,
        returnWindowDays: true,
        currencyCode: true,
      },
    });
    const ready = Boolean(policy?.automaticRefundsEnabled);
    return Response.json(
      {
        status: ready ? "ready" : "configuration_required",
        connected: true,
        merchant: store,
        siteTools: {
          topLevelRegistrationRequired: true,
          tools: ["get_store_return_options", "start_return"],
        },
        quoteAvailable: ready,
        submissionAvailable: ready,
        returnWindowDays: policy?.returnWindowDays ?? null,
        currencyCode: policy?.currencyCode ?? null,
        recovery: ready
          ? "Start with start_return. Shopify verification is required before purchase lookup."
          : "The merchant must enable automatic returns in Refund before quotes can be created.",
      },
      { status: ready ? 200 : 503, headers: intakeHeaders },
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
