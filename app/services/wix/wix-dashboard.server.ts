import prisma from "../../db.server";
import {
  canArchiveReturn,
  canReceiveReturn,
  canRemoveReturn,
  canRetryReturn,
  receiveReturnedItems,
  removeUnsubmittedReturn,
  retryApprovedReturn,
  setReturnArchived,
  wantsRestock,
} from "../automatic-return.server";
import { appOrigin } from "../customer-security.server";
import { merchantProfilePath } from "../merchant-directory.server";
import {
  RETURN_INSTRUCTIONS_MAX_LENGTH,
  cleanReturnInstructions,
  cleanReturnPolicyUrl,
} from "../return-guidance.server";
import { isWixStore, wixStoreKey } from "../store-platform.server";
import { FINAL_SALE_COLLECTION_LIMIT } from "../verified-customer-returns.server";
import { describeRefundProgress } from "../../refund-status";
import { createWixApi, wixApiFor } from "./wix-client.server";
import { listWixCollections } from "./wix-catalog.server";
import { verifyWixDashboardInstance } from "./wix-instance.server";
import { provisionWixSite } from "./wix-site.server";

// ---------------------------------------------------------------------------
// Who is asking
//
// Wix loads the dashboard in an iframe with `?instance=<signature>.<data>`,
// signed with the app secret. That signed value is the only thing that names
// the site: never a shop or instance ID from the page. The page sets no
// cookies (an iframe would need SameSite=None ones, which any site could make
// the browser send), so every form re-sends the original signed instance as a
// hidden field and each action verifies it again. An attacker page can't
// forge a post, because it can't read or mint that value.
// ---------------------------------------------------------------------------

export const WIX_INSTANCE_FIELD = "instance";
// Real instances are a few hundred characters; this only bounds the work an
// oversized value can cause before the signature check.
const MAX_INSTANCE_LENGTH = 4096;

export type WixDashboardIdentity = {
  instanceId: string;
  shop: string;
  userId?: string;
  permissions?: string;
};

export type WixDashboardSession = {
  identity: WixDashboardIdentity;
  // The value to embed in every form on the page.
  signedInstance: string;
};

type VerifyInstance = (
  value: string,
  options: { secret: string; now: Date },
) => WixDashboardIdentity | null | Promise<WixDashboardIdentity | null>;

export type IdentityOptions = {
  verify?: VerifyInstance;
  secret?: string;
  now?: Date;
  origin?: string;
};

const unauthorized = () =>
  new Response(
    "This page opens from your Wix dashboard. Open Gooper.io from your site's dashboard again.",
    {
      status: 401,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
    },
  );

// Where the signed instance comes from: the URL Wix opened the page with on a
// GET, and only the form's hidden field on a POST, so a form can't borrow an
// identity from the address it happens to be posted to.
export function signedInstanceFrom(request: Request, formData?: FormData) {
  const value =
    request.method === "GET" || request.method === "HEAD"
      ? new URL(request.url).searchParams.get(WIX_INSTANCE_FIELD)
      : formData?.get(WIX_INSTANCE_FIELD);
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_INSTANCE_LENGTH
    ? value
    : null;
}

// Defense in depth for posts: a browser always names the page that sent them,
// and ours posts only to itself.
export function isSameOriginPost(request: Request, origin: string) {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const sent = request.headers.get("Origin");
  if (sent !== null) return sent === origin;
  // Browsers that omit Origin still send Fetch Metadata.
  const site = request.headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin";
}

export async function requireWixDashboardSession(
  request: Request,
  formData?: FormData,
  options: IdentityOptions = {},
): Promise<WixDashboardSession> {
  const secret = options.secret ?? process.env.WIX_APP_SECRET ?? "";
  if (!secret) throw new Response("Wix is not configured.", { status: 503 });
  if (!isSameOriginPost(request, options.origin ?? appOrigin()))
    throw unauthorized();
  const signedInstance = signedInstanceFrom(request, formData);
  if (!signedInstance) throw unauthorized();
  let identity: WixDashboardIdentity | null;
  try {
    identity = await (options.verify ?? verifyWixDashboardInstance)(
      signedInstance,
      { secret, now: options.now ?? new Date() },
    );
  } catch {
    identity = null;
  }
  // The store key must be the one this instance maps to, whatever the
  // verifier returned alongside it.
  if (!identity?.instanceId) throw unauthorized();
  let shop: string;
  try {
    shop = wixStoreKey(identity.instanceId);
  } catch {
    throw unauthorized();
  }
  if (identity.shop !== shop) throw unauthorized();
  return { identity: { ...identity, shop }, signedInstance };
}

// Headers for the dashboard document and its data requests. Wix frames the
// page, so this route alone allows the Wix dashboard as a parent; everything
// else in the app keeps its own framing rules.
// UNVERIFIED: the complete list of Wix dashboard origins. manage.wix.com is
// the Wix dashboard; *.editorx.com is the Editor X dashboard; *.wixapps.net
// covers Wix-hosted wrappers in case the page is nested one frame deeper.
export const WIX_FRAME_ANCESTORS = [
  "https://manage.wix.com",
  "https://*.wix.com",
  "https://*.editorx.com",
  "https://*.wixapps.net",
];

export const wixDashboardHeaders = () => ({
  "Content-Security-Policy": `frame-ancestors ${WIX_FRAME_ANCESTORS.join(" ")}; base-uri 'self'; form-action 'self'`,
  "Cache-Control": "no-store, private",
  // The signed instance sits in this page's address; don't hand it to other
  // sites in the Referer header.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

// ---------------------------------------------------------------------------
// Return policy form
//
// The same fields and bounds as the Shopify dashboard's policy action, minus
// the restock location (Wix has none in our model). Final-sale choices are
// Wix Stores collections (Catalog V1) or categories (Catalog V3); either way
// they must be IDs Wix just listed for this site.
// ---------------------------------------------------------------------------

// Wix IDs are GUIDs, but not always RFC 4122 shaped (the V1 "All Products"
// collection is 00000000-000000-000000-000000000001), so this only rejects
// anything that isn't an ID; membership in the listed IDs is the real check.
const WIX_ID = /^[0-9a-f][0-9a-f-]{0,63}$/i;

export type ParsedReturnPolicy = {
  automaticRefundsEnabled: boolean;
  returnWindowDays: number;
  maxAutoRefundAmount: string;
  currencyCode: string;
  returnLocationId: null;
  returnInstructions: string | null;
  returnPolicyUrl: string | null;
  refundTiming: "IMMEDIATE" | "ON_RECEIPT";
  verifiedStoreLinks: boolean;
  restockingFeePercent: string;
  returnShippingFee: string;
  finalSaleCollectionIds: string[];
  returnRulesConfirmedAt: Date;
  returnRulesMismatch: null;
};

export type PolicyFormResult =
  | { ok: true; policy: ParsedReturnPolicy }
  | { ok: false; heading: string; error: string };

const notSaved = (error: string): PolicyFormResult => ({
  ok: false,
  heading: "Policy not saved",
  error,
});

export function parseReturnPolicyForm(
  formData: FormData,
  {
    currencyCode,
    knownCollectionIds,
    allowedPolicyHosts,
    now = new Date(),
  }: {
    currencyCode: string | null | undefined;
    // Null when Gooper.io couldn't read the site's collections.
    knownCollectionIds: string[] | null;
    allowedPolicyHosts: string[];
    now?: Date;
  },
): PolicyFormResult {
  const returnWindowDays = Number(formData.get("returnWindowDays"));
  const maxAutoRefundAmount = Number(formData.get("maxAutoRefundAmount"));
  if (
    !Number.isInteger(returnWindowDays) ||
    returnWindowDays < 1 ||
    returnWindowDays > 365
  )
    return notSaved("Enter a return window from 1 to 365 days.");
  if (
    !Number.isFinite(maxAutoRefundAmount) ||
    maxAutoRefundAmount <= 0 ||
    maxAutoRefundAmount > 100_000
  )
    return notSaved(
      "Enter a maximum automatic refund above 0 and no more than 100,000.",
    );

  const restockingFeePercent = Number(
    formData.get("restockingFeePercent") || 0,
  );
  const returnShippingFee = Number(formData.get("returnShippingFee") || 0);
  if (
    !Number.isFinite(restockingFeePercent) ||
    restockingFeePercent < 0 ||
    restockingFeePercent > 100
  )
    return notSaved("Enter a restocking fee from 0 to 100 percent.");
  if (
    !Number.isFinite(returnShippingFee) ||
    returnShippingFee < 0 ||
    returnShippingFee > 1_000
  )
    return notSaved("Enter a return shipping fee from 0 to 1,000.");

  const finalSaleCollectionIds = [
    ...new Set(
      formData
        .getAll("finalSaleCollectionIds")
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  if (finalSaleCollectionIds.length > FINAL_SALE_COLLECTION_LIMIT)
    return notSaved(
      `Choose up to ${FINAL_SALE_COLLECTION_LIMIT} final-sale collections or categories.`,
    );
  if (finalSaleCollectionIds.some((id) => !WIX_ID.test(id)))
    return notSaved("Choose final-sale collections from the list.");
  if (finalSaleCollectionIds.length) {
    if (!knownCollectionIds)
      return notSaved(
        "Gooper.io couldn't read your store's collections just now, so final-sale choices weren't saved. Check that Gooper.io can read your products, then try again.",
      );
    if (finalSaleCollectionIds.some((id) => !knownCollectionIds.includes(id)))
      return notSaved(
        "One of the final-sale choices is no longer in your store. Reload the page and choose again.",
      );
  }

  let returnInstructions: string | null;
  let returnPolicyUrl: string | null;
  try {
    returnInstructions = cleanReturnInstructions(
      formData.get("returnInstructions"),
    );
    returnPolicyUrl = cleanReturnPolicyUrl(
      formData.get("returnPolicyUrl"),
      allowedPolicyHosts,
    );
  } catch (error) {
    return notSaved(
      error instanceof Error
        ? error.message
        : "Check the return guidance fields.",
    );
  }

  if (!currencyCode)
    return notSaved(
      "Gooper.io couldn't find your store's currency yet. Reload the page in a minute and try again.",
    );

  return {
    ok: true,
    policy: {
      automaticRefundsEnabled:
        formData.get("automaticRefundsEnabled") === "true",
      returnWindowDays,
      maxAutoRefundAmount: maxAutoRefundAmount.toFixed(2),
      currencyCode,
      returnLocationId: null,
      returnInstructions,
      returnPolicyUrl,
      refundTiming:
        formData.get("refundTiming") === "ON_RECEIPT"
          ? "ON_RECEIPT"
          : "IMMEDIATE",
      verifiedStoreLinks: formData.get("verifiedStoreLinks") === "true",
      restockingFeePercent: String(
        Math.round(restockingFeePercent * 100) / 100,
      ),
      returnShippingFee: returnShippingFee.toFixed(2),
      finalSaleCollectionIds,
      // Saving is the merchant's confirmation that these rules match their
      // store's return rules, and clears any earlier mismatch.
      returnRulesConfirmedAt: now,
      returnRulesMismatch: null,
    },
  };
}

// Hosts a return policy link may point at: the site's own domains. A free Wix
// address (owner.wixsite.com/shop) has a host that only that Wix account's
// sites use, so it counts too; Wix's own domains never do. A primaryDomain
// that is really the store key (sites with no custom domain) is not a host.
const WIX_OWN_HOSTS =
  /^(?:(?:.+\.)?wix\.com|wixsite\.com|wixstudio\.io|wixstudio\.com|editorx\.io)$/;

export function policyHostsFor(
  primaryDomain: string | null | undefined,
  siteUrl: string | null | undefined,
) {
  const hosts = new Set<string>();
  const add = (host: string) => {
    host = host.toLowerCase();
    if (host.includes(".") && !isWixStore(host) && !WIX_OWN_HOSTS.test(host))
      hosts.add(host);
  };
  if (primaryDomain) add(primaryDomain);
  if (siteUrl) {
    try {
      add(new URL(siteUrl).hostname);
    } catch {
      /* A malformed site URL adds nothing. */
    }
  }
  return [...hosts];
}

// ---------------------------------------------------------------------------
// Page data and actions
// ---------------------------------------------------------------------------

async function siteCollections(shop: string) {
  try {
    return await listWixCollections(await wixApiFor(shop));
  } catch (error) {
    console.warn(
      "Wix collections unavailable",
      error instanceof Error ? error.name : "error",
    );
    return null;
  }
}

// Wix normally tells us about an install by webhook. If that was missed, the
// merchant opening the dashboard is proof enough to set the site up now.
async function installationFor(identity: WixDashboardIdentity) {
  const existing = await prisma.wixInstallation.findUnique({
    where: { shop: identity.shop },
  });
  if (existing) return existing;
  try {
    await provisionWixSite(
      identity.instanceId,
      await createWixApi(identity.instanceId),
    );
  } catch (error) {
    console.warn(
      "Wix dashboard provisioning fallback failed",
      error instanceof Error ? error.name : "error",
    );
    return null;
  }
  return prisma.wixInstallation.findUnique({ where: { shop: identity.shop } });
}

// Status wording for the merchant. The shared wording names Shopify, which a
// Wix merchant would find confusing.
function wixStatusTitle(record: {
  status: string;
  refundStatus: string | null;
}) {
  return describeRefundProgress(record).title.replace(/Shopify/g, "Wix");
}

function statusTone(record: { status: string; refundStatus: string | null }) {
  if (record.status === "NEEDS_ATTENTION") return "critical";
  if (record.refundStatus === "SUCCESS") return "success";
  if (record.status === "NOT_SUBMITTED") return "warning";
  return "info";
}

export function safeTrackingUrl(value: string | null | undefined) {
  if (!value || !value.startsWith("https://")) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

export async function loadWixDashboard(
  session: WixDashboardSession,
  { showArchived }: { showArchived: boolean },
) {
  const { shop } = session.identity;
  const installation = await installationFor(session.identity);
  const base = {
    signedInstance: session.signedInstance,
    shop,
    connectUrl: `${appOrigin()}/connect`,
    publicPageUrl: appOrigin() + merchantProfilePath(shop),
  };
  if (!installation) return { ...base, ready: false as const };

  const [storedPolicy, directory, agentReturns, archivedCount, collections] =
    await Promise.all([
      prisma.storePolicy.findUnique({ where: { shop } }),
      prisma.merchantDirectory.findUnique({
        where: { shop },
        select: { discoveryPublished: true },
      }),
      prisma.agentReturn.findMany({
        where: { shop, archivedAt: showArchived ? { not: null } : null },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
      prisma.agentReturn.count({ where: { shop, archivedAt: { not: null } } }),
      siteCollections(shop),
    ]);

  return {
    ...base,
    ready: true as const,
    siteName: installation.siteName,
    listed: directory?.discoveryPublished ?? false,
    hasDirectory: Boolean(directory),
    collections,
    finalSaleCollectionLimit: FINAL_SALE_COLLECTION_LIMIT,
    instructionsMaxLength: RETURN_INSTRUCTIONS_MAX_LENGTH,
    showArchived,
    archivedCount,
    policy: storedPolicy
      ? {
          ...storedPolicy,
          currencyCode: installation.currencyCode ?? storedPolicy.currencyCode,
        }
      : {
          automaticRefundsEnabled: false,
          returnWindowDays: 30,
          maxAutoRefundAmount: "100.00",
          currencyCode: installation.currencyCode ?? null,
          returnInstructions: null as string | null,
          returnPolicyUrl: null as string | null,
          refundTiming: "IMMEDIATE",
          verifiedStoreLinks: true,
          restockingFeePercent: "0",
          returnShippingFee: "0.00",
          finalSaleCollectionIds: [] as string[],
          returnRulesConfirmedAt: null as Date | null,
          returnRulesMismatch: null as string | null,
        },
    returns: agentReturns.map((record) => ({
      id: record.id,
      orderLabel: record.orderName ?? "Order",
      createdAt: record.createdAt.toISOString(),
      itemReceivedAt: record.itemReceivedAt?.toISOString() ?? null,
      amount: record.amount,
      currencyCode: record.currencyCode,
      refundTiming: record.refundTiming,
      status: record.status,
      statusTitle: wixStatusTitle(record),
      tone: statusTone(record),
      failureReason: record.failureReason,
      // Customers add their own tracking in chat; the link is shown only when
      // it is a plain https address, never another scheme.
      trackingNumber: record.trackingNumber,
      trackingUrl: safeTrackingUrl(record.trackingUrl),
      archivable: canArchiveReturn(record),
      retryable: canRetryReturn(record),
      receivable: canReceiveReturn(record),
      removable: canRemoveReturn(record),
    })),
  };
}

export type WixDashboardActionResult =
  | { ok: true; notice: string; detail: string }
  | { ok: false; heading: string; error: string };

const failed = (heading: string, error: unknown): WixDashboardActionResult => ({
  ok: false,
  heading,
  error: error instanceof Error ? error.message : "The action did not finish.",
});

export async function runWixDashboardAction(
  session: WixDashboardSession,
  formData: FormData,
): Promise<WixDashboardActionResult> {
  const { shop } = session.identity;
  const intent = formData.get("intent");
  const agentReturnId = formData.get("agentReturnId");
  const returnId =
    typeof agentReturnId === "string" && agentReturnId ? agentReturnId : null;

  if (intent === "archiveReturn" || intent === "unarchiveReturn") {
    const archived = intent === "archiveReturn";
    if (!returnId)
      throw new Response("Return ID is required.", { status: 400 });
    try {
      await setReturnArchived(shop, returnId, archived);
    } catch (error) {
      return failed(
        archived ? "The return wasn't archived" : "The return wasn't restored",
        error,
      );
    }
    return archived
      ? {
          ok: true,
          notice: "Return archived",
          detail:
            "It is off this list. The record stays, and a customer data request still reports it.",
        }
      : {
          ok: true,
          notice: "Return restored",
          detail: "It is back on the main list.",
        };
  }

  if (intent === "retryReturn" || intent === "receiveReturn") {
    const retry = intent === "retryReturn";
    if (!returnId)
      throw new Response("Return ID is required.", { status: 400 });
    try {
      if (retry) await retryApprovedReturn(shop, returnId);
      else
        await receiveReturnedItems(
          shop,
          returnId,
          undefined,
          wantsRestock(formData.get("restock")),
        );
    } catch (error) {
      return failed(
        retry ? "Retry did not finish" : "The return wasn't marked received",
        error,
      );
    }
    return {
      ok: true,
      notice: retry ? "Retry finished" : "Return marked received",
      detail: "Check the return's status under Recent returns.",
    };
  }

  if (intent === "removeReturn") {
    if (!returnId)
      throw new Response("Return ID is required.", { status: 400 });
    try {
      await removeUnsubmittedReturn(shop, returnId);
    } catch (error) {
      return failed("The request wasn't removed", error);
    }
    return {
      ok: true,
      notice: "Return request removed",
      detail: "The customer can try that return again.",
    };
  }

  if (intent === "setListing") {
    // Listing affects only the public store directory, never an existing return.
    const listed = formData.get("listed") === "true";
    await prisma.merchantDirectory.updateMany({
      where: { shop },
      data: { discoveryPublished: listed },
    });
    return {
      ok: true,
      notice: "Directory listing saved",
      detail: listed
        ? "Your store is listed in Gooper.io's store directory."
        : "Your store is hidden from Gooper.io's store directory.",
    };
  }

  if (intent !== "savePolicy")
    throw new Response("Unknown action.", { status: 400 });

  const [installation, storedPolicy, directory] = await Promise.all([
    prisma.wixInstallation.findUnique({
      where: { shop },
      select: { currencyCode: true, siteUrl: true },
    }),
    prisma.storePolicy.findUnique({
      where: { shop },
      select: { currencyCode: true },
    }),
    prisma.merchantDirectory.findUnique({
      where: { shop },
      select: { primaryDomain: true },
    }),
  ]);
  if (!installation)
    return failed(
      "Policy not saved",
      new Error(
        "Gooper.io is still finishing setup for your site. Try again in a minute.",
      ),
    );
  const wantsCollections = formData.getAll("finalSaleCollectionIds").length > 0;
  const collections = wantsCollections ? await siteCollections(shop) : [];
  const parsed = parseReturnPolicyForm(formData, {
    currencyCode: installation.currencyCode ?? storedPolicy?.currencyCode,
    knownCollectionIds: collections?.map((collection) => collection.id) ?? null,
    allowedPolicyHosts: policyHostsFor(
      directory?.primaryDomain,
      installation.siteUrl,
    ),
  });
  if (!parsed.ok) return parsed;
  await prisma.storePolicy.upsert({
    where: { shop },
    create: { shop, ...parsed.policy },
    update: parsed.policy,
  });
  return {
    ok: true,
    notice: "Automatic return policy saved",
    detail: "The policy applies to the next return a customer confirms.",
  };
}
