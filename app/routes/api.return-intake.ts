import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  intakeSchema,
  startReturnIntake,
} from "../services/return-intake.server";
import {
  intakeResponse,
  readIntakeBody,
} from "../services/public-intake-http.server";
import { stoppedDiscovery } from "../services/merchant-opportunity.server";

// Resource-route OPTIONS requests are dispatched to the loader, not the action.
export const loader = ({ request }: Pick<LoaderFunctionArgs, "request">) =>
  intakeResponse(
    request.method === "OPTIONS" ? new Response(null, { status: 204 }) : new Response("Use POST.", {
      status: 405,
      headers: { Allow: "POST, OPTIONS" },
    }),
  );

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS")
    return intakeResponse(new Response(null, { status: 204 }));
  if (request.method !== "POST") return loader({ request });
  try {
    const input = intakeSchema.safeParse(await readIntakeBody(request));
    if (!input.success)
      return intakeResponse(
        Response.json(
          {
            error:
              "Provide a merchant name or website and optional orderName/itemName, each at most 120 characters.",
          },
          { status: 400 },
        ),
      );
    return intakeResponse(Response.json(await startReturnIntake(input.data)));
  } catch (error) {
    return intakeResponse(
      error instanceof Response
        ? error
        : Response.json(
            {
              ...stoppedDiscovery,
              error:
                "Could not identify the merchant. Stop without starting a return.",
            },
            { status: 503 },
          ),
    );
  }
}
