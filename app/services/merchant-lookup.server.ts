import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import {
  findPublishedMerchants,
  merchantHost,
  merchantProfilePath,
  normalizeMerchantName,
} from "./merchant-directory.server";
import { appOrigin } from "./customer-security.server";
import { installedStores, publicWebsite } from "./store-platform.server";
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
        domain: publicWebsite(primaryDomain),
        returnPage: appOrigin() + merchantProfilePath(shop),
      },
    ],
    nextStep:
      "Open the verified merchant returnPage and use start_return only if you have not already stopped this request after a discovery failure.",
  };
}

// Words nearly every store name could carry, so "Blue Sky Co." and "blueskyshop"
// compare as the same name.
const NAME_FILLER = new Set([
  "the",
  "co",
  "company",
  "inc",
  "llc",
  "ltd",
  "shop",
  "store",
  "official",
]);

// A store name as only its distinguishing letters and digits.
export function compactMerchantName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !NAME_FILLER.has(word))
    .join("");
}

// Levenshtein distance, giving up once it passes max.
export function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, current[j]);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

// Whether a customer's spelling plausibly means this store: the same name once
// spacing, punctuation and filler words are ignored, or a typo or two away.
// Short names must match exactly, since one letter changes them entirely.
export function similarMerchantName(query: string, candidate: string) {
  const typed = compactMerchantName(query);
  const name = compactMerchantName(candidate);
  if (!typed || !name) return false;
  if (typed === name) return true;
  const allowed = typed.length >= 10 ? 2 : typed.length >= 5 ? 1 : 0;
  return allowed > 0 && editDistance(typed, name, allowed) <= allowed;
}

// How a candidate store matched, so the assistant can say how sure it is.
export type MatchedBy = "website" | "name" | "similar_name";

// How many listed stores a similar-name search compares against. Beyond this
// the directory needs a search index rather than an in-memory scan.
const SIMILAR_NAME_SCAN_LIMIT = 5000;

// Broader than lookupMerchant's exact matching: partial business names, exact
// domains, and, when nothing else matches, similar spellings, across every
// listed, currently installed store. It only finds candidates; resolving the
// store for a return still requires an exact match.
export async function searchPublishedMerchants(query: string, limit = 20) {
  const text = query.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!text || text.length > 120) return [];
  let host: string | null = null;
  try {
    host = merchantHost(text);
  } catch {
    /* A business name need not be a domain. */
  }
  const select = { shop: true, name: true, primaryDomain: true } as const;
  let profiles: Array<{
    shop: string;
    name: string;
    primaryDomain: string;
    matchedBy: MatchedBy;
  }> = (
    await prisma.merchantDirectory.findMany({
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
      select,
    })
  ).map((profile) => ({
    ...profile,
    matchedBy:
      host && (profile.shop === host || profile.primaryDomain === host)
        ? ("website" as const)
        : ("name" as const),
  }));
  // A website names exactly one store, so it wins over any name that happens
  // to contain the same words.
  if (profiles.some((profile) => profile.matchedBy === "website"))
    profiles = profiles.filter((profile) => profile.matchedBy === "website");
  if (!profiles.length && !host)
    profiles = (
      await prisma.merchantDirectory.findMany({
        where: { discoveryPublished: true },
        orderBy: { name: "asc" },
        take: SIMILAR_NAME_SCAN_LIMIT,
        select: { ...select, aliases: true },
      })
    )
      .filter(
        (profile) =>
          similarMerchantName(text, profile.name) ||
          (profile.aliases ?? []).some((alias) => similarMerchantName(text, alias)),
      )
      .map(({ shop, name, primaryDomain }) => ({
        shop,
        name,
        primaryDomain,
        matchedBy: "similar_name" as const,
      }));
  if (!profiles.length) return [];
  const installed = await installedStores(profiles.map((profile) => profile.shop));
  return profiles.filter((profile) => installed.has(profile.shop)).slice(0, limit);
}

// Which candidate stores the customer has bought from: true or false per
// store, absent when it couldn't be checked.
export type CustomerOrdersAt = (shops: string[]) => Promise<Map<string, boolean>>;

// How many candidates are checked against the customer's orders. More than
// this and the customer is better off naming the website.
const ORDER_CHECK_LIMIT = 5;

// A single match is used without asking; several matches go back to the
// customer to choose from, unless the customer's own orders are at exactly one
// of them, and a store that isn't found stops the request.
export async function findStore(
  query: string,
  options: { customerOrdersAt?: CustomerOrdersAt } = {},
) {
  const label = opportunityLabel(query);
  if (!label)
    return {
      ...stoppedDiscovery,
      status: "invalid_query" as const,
      merchants: [],
      message: "Search with only a business name or store website.",
    };
  const found = await searchPublishedMerchants(label);
  if (!found.length) {
    await noteUnresolvedMerchant(label, "lookup", randomUUID());
    return { ...stoppedDiscovery, status: "not_found" as const, merchants: [] };
  }
  let ordersAt = new Map<string, boolean>();
  if (found.length > 1 && found.length <= ORDER_CHECK_LIMIT && options.customerOrdersAt)
    try {
      ordersAt = await options.customerOrdersAt(found.map((entry) => entry.shop));
    } catch {
      /* Without the order check, the customer chooses. */
    }
  const merchants = found.map(({ name, shop, primaryDomain, matchedBy }) => ({
    name,
    shop,
    domain: publicWebsite(primaryDomain),
    returnPage: appOrigin() + merchantProfilePath(shop),
    matchedBy,
    ...(ordersAt.has(shop) ? { customerHasOrders: ordersAt.get(shop)! } : {}),
  }));
  const outcome = { returnSubmitted: false, refundSubmitted: false };
  const withOrders = merchants.filter((merchant) => merchant.customerHasOrders);
  if (merchants.length > 1 && withOrders.length === 1)
    return {
      ...outcome,
      merchants: withOrders,
      otherMatches: merchants.length - 1,
      status: "matched" as const,
      matchedByCustomerOrders: true,
      selectionRequired: false,
      nextStep:
        "Several stores have a similar name, but the customer's orders are only at this one, so go ahead with it. Mention its name and website naturally, like \"Found your order at Snow Supply (snowsupply.com),\" so they can correct you. Then continue with its domain.",
    };
  if (merchants.length > 1)
    return {
      ...outcome,
      merchants,
      status: "multiple_matches" as const,
      selectionRequired: true,
      nextStep: withOrders.length
        ? "The customer has orders at more than one of these stores. Ask which one this return is for, in one short, friendly question listing each of those stores' name and website. Don't pick for them."
        : "Ask the customer which of these stores they bought from, in one short, friendly question listing each store's name and website. Don't pick for them. Then continue with the store they choose.",
    };
  return {
    ...outcome,
    merchants,
    status: "matched" as const,
    selectionRequired: false,
    nextStep:
      merchants[0].matchedBy === "similar_name"
        ? `No store is called exactly that, but ${merchants[0].name} is close. Check with the customer in a few words, like "Did you mean ${merchants[0].name}${merchants[0].domain ? ` (${merchants[0].domain})` : ""}?", before going ahead.`
        : "Only one store matches, so go ahead with it without asking the customer to confirm. Mention its name naturally, like \"Found it, let's get your return started,\" so they can correct you if it's the wrong store. Then continue with its domain.",
  };
}
