import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  discoveryFailureSchema,
  recordMerchantOpportunity,
  stoppedDiscovery,
} from "../services/merchant-opportunity.server";
import {
  intakeResponse,
  readIntakeBody,
} from "../services/public-intake-http.server";

// Write-only ingestion. No public list/detail/export route exists.
export const loader = ({ request }: Pick<LoaderFunctionArgs, "request">) =>
  intakeResponse(
    request.method === "OPTIONS"
      ? new Response(null, { status: 204 })
      : new Response("Use POST.", {
          status: 405,
          headers: { Allow: "POST, OPTIONS" },
        }),
  );
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return loader({ request });
  try {
    const parsed = discoveryFailureSchema.safeParse(
      await readIntakeBody(request, 4096),
    );
    if (!parsed.success)
      return intakeResponse(
        Response.json(
          {
            ...stoppedDiscovery,
            error:
              "Provide only a merchant name or HTTPS domain; no personal or order details.",
          },
          { status: 400 },
        ),
      );
    await recordMerchantOpportunity(parsed.data.merchant, "discovery_report");
    return intakeResponse(Response.json(stoppedDiscovery, { status: 202 }));
  } catch (error) {
    return intakeResponse(
      Response.json(
        {
          ...stoppedDiscovery,
          error:
            "Could not record the discovery issue. Nothing has been submitted.",
        },
        { status: error instanceof Response ? error.status : 503 },
      ),
    );
  }
}
