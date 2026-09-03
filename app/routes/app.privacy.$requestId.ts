import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const privacyRequest = await prisma.privacyRequest.findFirst({
    where: { id: params.requestId, shop: session.shop },
  });
  if (!privacyRequest) {
    throw new Response("Privacy request not found.", { status: 404 });
  }

  const safeRequestId = privacyRequest.id.replace(/[^a-zA-Z0-9-]/g, "");

  return Response.json(
    {
      requestId: privacyRequest.id,
      type: privacyRequest.type,
      createdAt: privacyRequest.createdAt,
      customerData: privacyRequest.reportData,
    },
    {
      headers: {
        "Content-Disposition": `attachment; filename="privacy-request-${safeRequestId}.json"`,
      },
    },
  );
};
