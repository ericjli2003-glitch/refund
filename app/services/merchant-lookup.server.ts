import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import {
  findPublishedMerchants,
  merchantHost,
  merchantProfilePath,
  normalizeMerchantName,
} from "./merchant-directory.server";
import { appOrigin } from "./customer-security.server";
import {
  noteUnresolvedMerchant,
  opportunityLabel,
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

// Broader than lookupMerchant's exact matching: partial business names and
// exact domains across every listed, currently installed store. It only finds
// candidates; resolving the store for a return still requires an exact match.
export async function searchPublishedMerchants(query: string, limit = 20) {
  const text = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!text || text.length > 120) return [];
  let host: string | null = null;
  try {
    host = merchantHost(text);
  } catch {
    /* A business name need not be a domain. */
  }
  const profiles = await prisma.merchantDirectory.findMany({
    where: {
      discoveryPublished: true,
      OR: [
        { name: { contains: text, mode: "insensitive" } },
        { aliases: { has: normalizeMerchantName(text) } },
        ...(host ? [{ shop: host }, { primaryDomain: host }] : []),
      ],
    },
    orderBy: { name: "asc" },
    take: 100,
    select: { shop: true, name: true, primaryDomain: true },
  });
  if (!profiles.length) return [];
  const installed = new Set(
    (
      await prisma.session.findMany({
        where: {
          shop: { in: profiles.map((profile) => profile.shop) },
          isOnline: false,
        },
        select: { shop: true },
      })
    ).map((session) => session.shop),
  );
  return profiles.filter((profile) => installed.has(profile.shop)).slice(0, limit);
}

// A single match is used without asking; several matches go back to the
// customer to choose from, and a store that isn't found stops the request.
export async function findStore(query: string) {
  const label = opportunityLabel(query);
  if (!label)
    return {
      ...stoppedDiscovery,
      status: "invalid_query" as const,
      merchants: [],
      message: "Search with only a business name or store website.",
    };
  const merchants = (await searchPublishedMerchants(label)).map(
    ({ name, shop, primaryDomain }) => ({
      name,
      shop,
      domain: primaryDomain,
      returnPage: appOrigin() + merchantProfilePath(shop),
    }),
  );
  if (!merchants.length) {
    await noteUnresolvedMerchant(label, "lookup", randomUUID());
    return { ...stoppedDiscovery, status: "not_found" as const, merchants };
  }
  const outcome = { returnSubmitted: false, refundSubmitted: false, merchants };
  if (merchants.length > 1)
    return {
      ...outcome,
      status: "multiple_matches" as const,
      selectionRequired: true,
      nextStep:
        "Ask the customer which of these stores they bought from, in one short, friendly question listing each store's name and website. Don't pick for them. Then continue with the store they choose.",
    };
  return {
    ...outcome,
    status: "matched" as const,
    selectionRequired: false,
    nextStep:
      "Only one store matches, so go ahead with it without asking the customer to confirm. Mention its name naturally, like \"Found it, let's get your return started,\" so they can correct you if it's the wrong store. Then continue with its domain.",
  };
}
