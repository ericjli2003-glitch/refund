import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { lookupMerchant } from "../services/merchant-lookup.server";
import {
  discoveryFailureSchema,
  stoppedDiscovery,
} from "../services/merchant-opportunity.server";
import {
  intakeHeaders,
  intakeResponse,
  readIntakeBody,
} from "../services/public-intake-http.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS")
    return intakeResponse(new Response(null, { status: 204 }));
  const query = new URL(request.url).searchParams.get("query")?.trim() || "";
  // GET is read-only so crawlers and passive previews never create sales leads.
  return Response.json(await lookupMerchant(query), { headers: intakeHeaders });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST")
    return intakeResponse(
      new Response(null, { status: request.method === "OPTIONS" ? 204 : 405 }),
    );
  try {
    const parsed = discoveryFailureSchema.safeParse(
      await readIntakeBody(request, 4096),
    );
    if (!parsed.success)
      return intakeResponse(
        Response.json(
          { ...stoppedDiscovery, error: "Provide only a merchant name." },
          { status: 400 },
        ),
      );
    return intakeResponse(
      Response.json(await lookupMerchant(parsed.data.merchant, true)),
    );
  } catch (error) {
    return intakeResponse(
      Response.json(
        { ...stoppedDiscovery, error: "Merchant lookup unavailable." },
        { status: error instanceof Response ? error.status : 503 },
      ),
    );
  }
}
