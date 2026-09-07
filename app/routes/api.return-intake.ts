import type { ActionFunctionArgs } from "react-router";
import {
  intakeSchema,
  startReturnIntake,
} from "../services/return-intake.server";
import {
  intakeResponse,
  readIntakeBody,
} from "../services/public-intake-http.server";

export const loader = () =>
  intakeResponse(
    new Response("Use POST.", {
      status: 405,
      headers: { Allow: "POST, OPTIONS" },
    }),
  );

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS")
    return intakeResponse(new Response(null, { status: 204 }));
  if (request.method !== "POST") return loader();
  try {
    const input = intakeSchema.safeParse(await readIntakeBody(request));
    if (!input.success)
      return intakeResponse(
        Response.json(
          {
            error:
              "Provide a merchant website and optional orderName/itemName, each at most 120 characters.",
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
              error:
                "Could not verify the merchant. Check the website address and try again.",
            },
            { status: 503 },
          ),
    );
  }
}
