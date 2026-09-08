import { randomUUID } from "node:crypto";
import {
  findPublishedMerchants,
  merchantProfilePath,
} from "./merchant-directory.server";
import { appOrigin } from "./customer-security.server";
import {
  noteUnresolvedMerchant,
  stoppedDiscovery,
} from "./merchant-opportunity.server";

export async function lookupMerchant(query: string, recordFailure = false) {
  const profiles = query.trim() ? await findPublishedMerchants(query) : [];
  if (profiles.length !== 1) {
    if (recordFailure && query.trim())
      await noteUnresolvedMerchant(query, "lookup", randomUUID());
    return {
      ...stoppedDiscovery,
      status: profiles.length ? ("ambiguous" as const) : ("not_found" as const),
      merchants: [],
    };
  }
  const { name, shop, primaryDomain } = profiles[0];
  return {
    status: "matched" as const,
    merchants: [
      {
        name,
        shop,
        domain: primaryDomain,
        returnPage: appOrigin() + merchantProfilePath(shop),
      },
    ],
    nextStep:
      "Open the verified merchant returnPage and use start_return only if you have not already stopped this request after a discovery failure.",
  };
}
