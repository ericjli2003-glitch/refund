import type { ActionFunctionArgs } from "react-router";
import { getReturnableOrders } from "../services/automatic-return.server";
import { CustomerAccountApiError } from "../services/customer-account.server";
import {
  getCustomerSession,
  requireInstalledShop,
} from "../services/customer-session.server";
import {
  privateHeaders,
  verifyPortalPost,
} from "../services/customer-security.server";
import {
  createReturnQuote,
  submitReturnQuote,
  readBoundQuote,
} from "../services/return-quote.server";
import prisma from "../db.server";
import {
  listAgentGrants,
  revokeAgentGrant,
} from "../services/agent-access.server";
import {
  getReturnSession,
  markDraftSubmitted,
  notePurchaseLookup,
  saveReturnQuote,
} from "../services/return-draft.server";

// A resource route keeps fetch/WebMCP responses JSON, separate from portal HTML.
export async function action({ request, params }: ActionFunctionArgs) {
  const shop = await requireInstalledShop(params.shop || "");
  const session = await getCustomerSession(request, shop);
  if (!session)
    return Response.json(
      {
        error: "Sign in again before continuing.",
        authenticationRequired: true,
      },
      { status: 401, headers: privateHeaders },
    );
  verifyPortalPost(request, session.csrfToken);
  const bodyText = await request.text();
  if (bodyText.length > 40_000)
    return Response.json(
      { error: "Request is too large." },
      { status: 413, headers: privateHeaders },
    );
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    if (body.operation === "disconnect_assistant") {
      if (typeof body.grantId !== "string" || !/^[\w-]{43}$/.test(body.grantId))
        throw new Error("Invalid assistant connection.");
      await revokeAgentGrant(body.grantId, session.id);
      return Response.json(
        { grants: await listAgentGrants(session.id) },
        { headers: privateHeaders },
      );
    }
    const customer = {
      shop,
      customerSubjectHash: session.customerSubjectHash!,
      draftId: typeof body.draftId === "string" ? body.draftId : session.draftId,
    };
    if (body.operation === "get_session" || body.operation === "status")
      return Response.json(
        { session: await getReturnSession(customer) },
        { headers: privateHeaders },
      );
    if (body.operation === "list") {
      const { orders } = await getReturnableOrders(shop, session.customerToken);
      await notePurchaseLookup(customer);
      return Response.json(
        {
          orders,
        },
        { headers: privateHeaders },
      );
    }
    if (body.operation === "quote") {
      const quote = await createReturnQuote(shop, session.customerToken, body);
      const draft = await saveReturnQuote(customer, quote);
      return Response.json(
        { quote: { ...draft.quote, correlationId: draft.id } },
        { headers: privateHeaders },
      );
    }
    if (body.operation === "confirm") {
      const quote = readBoundQuote(String(body.quoteToken || ""), shop, customer.customerSubjectHash);
      const result = await submitReturnQuote(shop, session.customerToken, body);
      await markDraftSubmitted(customer, result, quote.id);
      return Response.json(
        { result },
        { headers: privateHeaders },
      );
    }
    if (body.operation === "logout") {
      await prisma.customerReturnSession.deleteMany({
        where: { id: session.id },
      });
      return Response.json({ signedOut: true }, { headers: privateHeaders });
    }
    return Response.json(
      { error: "Unknown return action." },
      { status: 400, headers: privateHeaders },
    );
  } catch (cause) {
    const status =
      cause instanceof CustomerAccountApiError && cause.status === 401
        ? 401
        : 400;
    return Response.json(
      {
        error:
          cause instanceof Error
            ? cause.message
            : "The return action failed. Do not retry a submission without checking its status.",
        authenticationRequired: status === 401,
      },
      { status, headers: privateHeaders },
    );
  }
}

export const loader = () =>
  Response.json(
    { error: "Use a signed-in customer POST request." },
    { status: 405, headers: { ...privateHeaders, Allow: "POST" } },
  );
