import type { LoaderFunctionArgs } from "react-router";
import {
  findPublishedMerchants,
  merchantProfilePath,
} from "../services/merchant-directory.server";
import { appOrigin } from "../services/customer-security.server";
import { intakeHeaders } from "../services/public-intake-http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const query = new URL(request.url).searchParams.get("query")?.trim() || "";
  const profiles = await findPublishedMerchants(query);
  return Response.json(
    {
      status:
        profiles.length === 1
          ? "matched"
          : profiles.length
            ? "choose_merchant"
            : "not_found",
      merchants: profiles.map(({ name, shop, primaryDomain }) => ({
        name,
        shop,
        domain: primaryDomain,
        returnPage: appOrigin() + merchantProfilePath(shop),
      })),
      nextStep:
        profiles.length === 1
          ? "Open the verified merchant returnPage and use start_return."
          : "Ask the customer which store website they mean. Do not guess.",
    },
    { headers: intakeHeaders },
  );
}
