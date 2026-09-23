import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useActionData, useLoaderData, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { describeRefundProgress } from "../refund-status";
import { authenticate } from "../shopify.server";
import { fundedSandboxEnabled } from "../services/funded-return-sandbox.server";
import {
  canReceiveReturn,
  canRemoveReturn,
  canRetryReturn,
  receiveReturnedItems,
  removeUnsubmittedReturn,
  retryApprovedReturn,
} from "../services/automatic-return.server";
import {
  provisionMerchant,
  merchantProfilePath,
} from "../services/merchant-directory.server";
import { appOrigin } from "../services/customer-security.server";
import { hasScope } from "../services/shopify-admin.server";
import {
  FINAL_SALE_COLLECTION_LIMIT,
  RETURN_RULES_SCOPE,
} from "../services/verified-customer-returns.server";
import {
  RETURN_INSTRUCTIONS_MAX_LENGTH,
  cleanReturnInstructions,
  cleanReturnPolicyUrl,
  merchantAgentsTemplateSection,
  publicReturnGuidance,
} from "../services/return-guidance.server";


type Money = {
  amount: string;
  currencyCode: string;
};

type ShopLocation = { id: string; name: string };

type OrdersQueryResponse = {
  data?: {
    shop: { currencyCode: string };
    locations: { nodes: ShopLocation[] };
  };
  errors?: Array<{ message: string }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const merchant = await provisionMerchant(session.shop, admin);
  const url = new URL(request.url);

  const response = await admin.graphql(
    `#graphql
      query RefundDashboardData {
        shop { currencyCode }
        locations(first: 50, includeInactive: false) {
          nodes { id name }
        }
      }`,
  );

  const responseJson = (await response.json()) as OrdersQueryResponse;
  if (!responseJson.data || responseJson.errors?.length) {
    const message =
      responseJson.errors?.map((error) => error.message).join(", ") ||
      "Shopify did not return order data.";
    throw new Response(message, { status: 502 });
  }

  // Final-sale collections for store links that skip signing in again.
  const canReadProducts = hasScope(session.scope, RETURN_RULES_SCOPE);
  let collections: Array<{ id: string; title: string }> = [];
  if (canReadProducts) {
    const collectionResponse = await admin.graphql(`#graphql
      query FinalSaleCollectionChoices {
        collections(first: 100, sortKey: TITLE) { nodes { id title } }
      }`);
    const collectionJson = (await collectionResponse.json()) as {
      data?: { collections: { nodes: Array<{ id: string; title: string }> } };
    };
    collections = collectionJson.data?.collections.nodes ?? [];
  }

  const [storedPolicy, agentReturns, privacyRequests, guidance] =
    await Promise.all([
      prisma.storePolicy.findUnique({ where: { shop: session.shop } }),
      prisma.agentReturn.findMany({
        where: { shop: session.shop },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      prisma.privacyRequest.findMany({
        where: { shop: session.shop, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        take: 10,
      }),
      publicReturnGuidance(session.shop),
    ]);

  return {
    fundedSandbox: fundedSandboxEnabled(),
    locations: responseJson.data.locations.nodes,
    collections,
    canReadProducts,
    finalSaleCollectionLimit: FINAL_SALE_COLLECTION_LIMIT,
    saved: url.searchParams.get("saved") === "true",
    retried: url.searchParams.get("retried") === "true",
    received: url.searchParams.get("received") === "true",
    removed: url.searchParams.get("removed") === "true",
    listingSaved: url.searchParams.get("listingSaved") === "true",
    returnPortalUrl: `${appOrigin()}/returns/${session.shop}`,
    listed: merchant.discoveryPublished,
    merchantProfileUrl: merchant.discoveryPublished
      ? appOrigin() + merchantProfilePath(session.shop)
      : null,
    privacyResolved: url.searchParams.get("privacyResolved") === "true",
    siteToolsActivationUrl: new URL(
      `/admin/themes/current/editor?context=apps&template=index&activateAppId=${encodeURIComponent(
        process.env.SHOPIFY_API_KEY ?? "",
      )}/refund-site-tools`,
      `https://${session.shop}`,
    ).toString(),
    policy: storedPolicy ?? {
      automaticRefundsEnabled: false,
      returnWindowDays: 30,
      maxAutoRefundAmount: "100.00",
      currencyCode: responseJson.data.shop.currencyCode,
      returnLocationId: null as string | null,
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
    instructionsMaxLength: RETURN_INSTRUCTIONS_MAX_LENGTH,
    agentsTemplateSection: merchantAgentsTemplateSection(guidance),
    agentReturns: agentReturns.map((agentReturn) => ({
      ...agentReturn,
      retryable: canRetryReturn(agentReturn),
      receivable: canReceiveReturn(agentReturn),
      removable: canRemoveReturn(agentReturn),
    })),
    privacyRequests,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "resolvePrivacyRequest") {
    const requestId = formData.get("requestId");
    if (typeof requestId !== "string" || !requestId) {
      throw new Response("Privacy request ID is required.", { status: 400 });
    }
    await prisma.privacyRequest.updateMany({
      where: { id: requestId, shop: session.shop, status: "PENDING" },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    return redirect("/app?privacyResolved=true");
  }

  if (
    formData.get("intent") === "retryReturn" ||
    formData.get("intent") === "receiveReturn"
  ) {
    const retry = formData.get("intent") === "retryReturn";
    const agentReturnId = formData.get("agentReturnId");
    if (typeof agentReturnId !== "string" || !agentReturnId) {
      throw new Response("Return ID is required.", { status: 400 });
    }
    try {
      if (retry) await retryApprovedReturn(session.shop, agentReturnId);
      else await receiveReturnedItems(session.shop, agentReturnId);
    } catch (error) {
      return {
        heading: retry
          ? "Retry did not finish"
          : "The return wasn't marked received",
        error:
          error instanceof Error ? error.message : "The action did not finish.",
      };
    }
    return redirect(retry ? "/app?retried=true" : "/app?received=true");
  }

  if (formData.get("intent") === "removeReturn") {
    const agentReturnId = formData.get("agentReturnId");
    if (typeof agentReturnId !== "string" || !agentReturnId) {
      throw new Response("Return ID is required.", { status: 400 });
    }
    try {
      await removeUnsubmittedReturn(session.shop, agentReturnId);
    } catch (error) {
      return {
        heading: "The request wasn't removed",
        error:
          error instanceof Error ? error.message : "The action did not finish.",
      };
    }
    return redirect("/app?removed=true");
  }

  if (formData.get("intent") === "setListing") {
    // Listing affects only the public store directory, never an existing return.
    await prisma.merchantDirectory.updateMany({
      where: { shop: session.shop },
      data: { discoveryPublished: formData.get("listed") === "true" },
    });
    return redirect("/app?listingSaved=true");
  }

  const returnWindowDays = Number(formData.get("returnWindowDays"));
  const maxAutoRefundAmount = Number(formData.get("maxAutoRefundAmount"));

  if (
    !Number.isInteger(returnWindowDays) ||
    returnWindowDays < 1 ||
    returnWindowDays > 365 ||
    !Number.isFinite(maxAutoRefundAmount) ||
    maxAutoRefundAmount <= 0 ||
    maxAutoRefundAmount > 100_000
  ) {
    throw new Response("Invalid automatic return policy.", { status: 400 });
  }

  const restockingFeePercent = Number(formData.get("restockingFeePercent") || 0);
  const returnShippingFee = Number(formData.get("returnShippingFee") || 0);
  const finalSaleCollectionIds = [
    ...new Set(
      formData
        .getAll("finalSaleCollectionIds")
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  if (
    !Number.isFinite(restockingFeePercent) ||
    restockingFeePercent < 0 ||
    restockingFeePercent > 100 ||
    !Number.isFinite(returnShippingFee) ||
    returnShippingFee < 0 ||
    returnShippingFee > 1_000 ||
    finalSaleCollectionIds.length > FINAL_SALE_COLLECTION_LIMIT ||
    finalSaleCollectionIds.some(
      (id) => !/^gid:\/\/shopify\/Collection\/\d+$/.test(id),
    )
  ) {
    throw new Response("Invalid return rules.", { status: 400 });
  }
  if (finalSaleCollectionIds.length) {
    if (!hasScope(session.scope, RETURN_RULES_SCOPE))
      throw new Response(
        "Approve Gooper.io's permission to read products before choosing final-sale collections.",
        { status: 400 },
      );
    const collectionCheck = await admin.graphql(
      `#graphql
        query FinalSaleCollectionsCheck($ids: [ID!]!) {
          nodes(ids: $ids) { ... on Collection { id } }
        }`,
      { variables: { ids: finalSaleCollectionIds } },
    );
    const found =
      ((await collectionCheck.json()) as {
        data?: { nodes: Array<{ id?: string } | null> };
      }).data?.nodes ?? [];
    if (finalSaleCollectionIds.some((id) => !found.some((node) => node?.id === id)))
      throw new Response("Unknown final-sale collection.", { status: 400 });
  }

  let returnInstructions: string | null;
  let returnPolicyUrl: string | null;
  try {
    returnInstructions = cleanReturnInstructions(
      formData.get("returnInstructions"),
    );
    const directory = await prisma.merchantDirectory.findUnique({
      where: { shop: session.shop },
      select: { primaryDomain: true },
    });
    returnPolicyUrl = cleanReturnPolicyUrl(formData.get("returnPolicyUrl"), [
      session.shop,
      ...(directory ? [directory.primaryDomain] : []),
    ]);
  } catch (error) {
    return {
      heading: "Policy not saved",
      error:
        error instanceof Error
          ? error.message
          : "Check the return guidance fields.",
    };
  }

  const shopResponse = await admin.graphql(`#graphql
    query AutomaticRefundCurrency {
      shop { currencyCode }
      locations(first: 50, includeInactive: false) {
        nodes { id }
      }
    }
  `);
  const shopResult = (await shopResponse.json()) as {
    data?: {
      shop: { currencyCode: string };
      locations: { nodes: Array<{ id: string }> };
    };
  };
  const currencyCode = shopResult.data?.shop.currencyCode;
  if (!currencyCode) {
    throw new Response("Could not determine the store currency.", {
      status: 502,
    });
  }

  // Empty means restock to the location that fulfilled the order. Any other
  // value must be one of this shop's own active locations, never free text.
  const submittedLocation = formData.get("returnLocationId");
  const returnLocationId =
    typeof submittedLocation === "string" && submittedLocation
      ? submittedLocation
      : null;
  if (
    returnLocationId &&
    !shopResult.data?.locations.nodes.some(
      (location) => location.id === returnLocationId,
    )
  ) {
    throw new Response("Unknown restock location.", { status: 400 });
  }

  const policy = {
    automaticRefundsEnabled: formData.get("automaticRefundsEnabled") === "true",
    returnWindowDays,
    maxAutoRefundAmount: maxAutoRefundAmount.toFixed(2),
    currencyCode,
    returnLocationId,
    returnInstructions,
    returnPolicyUrl,
    refundTiming:
      formData.get("refundTiming") === "ON_RECEIPT" ? "ON_RECEIPT" : "IMMEDIATE",
    verifiedStoreLinks: formData.get("verifiedStoreLinks") === "true",
    restockingFeePercent: String(Math.round(restockingFeePercent * 100) / 100),
    returnShippingFee: returnShippingFee.toFixed(2),
    finalSaleCollectionIds,
    // Saving the policy is the merchant's confirmation that these rules match
    // their Shopify return rules, and clears any earlier mismatch.
    returnRulesConfirmedAt: new Date(),
    returnRulesMismatch: null,
  };
  await prisma.storePolicy.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop, ...policy },
    update: policy,
  });

  return redirect("/app?saved=true");
};

function formatMoney(money: Money) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: money.currencyCode,
  }).format(Number(money.amount));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(value));
}

export default function RefundDashboard() {
  const {
    fundedSandbox,
    locations,
    collections,
    canReadProducts,
    finalSaleCollectionLimit,
    saved,
    retried,
    received,
    removed,
    listed,
    listingSaved,
    privacyResolved,
    policy,
    siteToolsActivationUrl,
    returnPortalUrl,
    merchantProfileUrl,
    instructionsMaxLength,
    agentsTemplateSection,
    agentReturns,
    privacyRequests,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const bridge = useAppBridge();
  const [storefrontActive, setStorefrontActive] = useState<boolean | null>(
    null,
  );
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      try {
        const extensions = await bridge.app.extensions();
        const active = extensions.some(
          (extension) =>
            extension.type === "theme_app_extension" &&
            extension.activations.some(
              (block) =>
                "handle" in block &&
                "status" in block &&
                block.handle === "refund-site-tools" &&
                block.status === "active",
            ),
        );
        if (!disposed) setStorefrontActive(active);
      } catch {
        /* Hosted portal access does not depend on the theme check. */
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => {
      disposed = true;
      window.removeEventListener("focus", check);
    };
  }, [bridge]);
  const [automaticRefundsEnabled, setAutomaticRefundsEnabled] = useState(
    policy.automaticRefundsEnabled,
  );
  const [returnWindowDays, setReturnWindowDays] = useState(
    String(policy.returnWindowDays),
  );
  const [maxAutoRefundAmount, setMaxAutoRefundAmount] = useState(
    policy.maxAutoRefundAmount,
  );
  const [returnLocationId, setReturnLocationId] = useState(
    policy.returnLocationId ?? "",
  );
  const [refundTiming, setRefundTiming] = useState(policy.refundTiming);
  const [verifiedStoreLinks, setVerifiedStoreLinks] = useState(
    policy.verifiedStoreLinks,
  );
  const [restockingFeePercent, setRestockingFeePercent] = useState(
    policy.restockingFeePercent,
  );
  const [returnShippingFee, setReturnShippingFee] = useState(
    policy.returnShippingFee,
  );
  const [finalSaleCollectionIds, setFinalSaleCollectionIds] = useState<
    string[]
  >(policy.finalSaleCollectionIds);
  const [returnInstructions, setReturnInstructions] = useState(
    policy.returnInstructions ?? "",
  );
  const [returnPolicyUrl, setReturnPolicyUrl] = useState(
    policy.returnPolicyUrl ?? "",
  );
  const [copyStatus, setCopyStatus] = useState("");

  async function copyTemplate() {
    try {
      await navigator.clipboard.writeText(agentsTemplateSection);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Select the text above and copy it manually.");
    }
  }

  const returnAction = (
    intent: "retryReturn" | "receiveReturn" | "removeReturn",
    agentReturnId: string,
    // Null where the button's own label is the whole explanation, which keeps
    // a row that needs nothing from the merchant down to one line.
    explanation: string | null,
    label: string,
  ) => (
    <form
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="agentReturnId" value={agentReturnId} />
      <s-stack direction="block" gap="small-200">
        {explanation && (
          <s-paragraph color="subdued">{explanation}</s-paragraph>
        )}
        <s-box>
          <s-button type="submit" variant="secondary">
            {label}
          </s-button>
        </s-box>
      </s-stack>
    </form>
  );

  // The aside column renders only at inlineSize="base". At "large" every
  // section slotted into it disappears from the page entirely.
  return (
    <s-page heading="Gooper.io" inlineSize="base">
      <s-button slot="primary-action" href="shopify:admin/orders">
        View all orders
      </s-button>

      <s-section slot="aside" heading="Gooper.io is installed">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Your store is connected. Customers can verify purchases and get
            return estimates through your hosted return portal. No separate
            Gooper.io account or connector is needed.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button href={returnPortalUrl} target="_blank" variant="primary">
              Open your return portal
            </s-button>
            {fundedSandbox && (
              <s-button href="/app/funded-returns">
                Funded returns sandbox
              </s-button>
            )}
            {merchantProfileUrl && (
              <s-button href={merchantProfileUrl} target="_blank">
                View your public return page
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      {saved && (
        <s-banner heading="Automatic return policy saved" tone="success">
          The policy applies to the next return a customer confirms.
        </s-banner>
      )}

      {retried && (
        <s-banner heading="Retry finished" tone="info">
          Check the return&apos;s status under Recent returns.
        </s-banner>
      )}

      {received && (
        <s-banner heading="Return marked received" tone="success">
          Check the return&apos;s status under Recent returns.
        </s-banner>
      )}

      {removed && (
        <s-banner heading="Return request removed" tone="success">
          The customer can try that return again.
        </s-banner>
      )}

      {listingSaved && (
        <s-banner heading="Directory listing saved" tone="success">
          {listed
            ? "Your store is listed in Gooper.io's store directory."
            : "Your store is hidden from Gooper.io's store directory."}
        </s-banner>
      )}

      {privacyRequests.length > 0 && (
        <s-section heading="Pending privacy requests">
          <s-stack direction="block" gap="base">
            <s-banner heading="Customer data export required" tone="warning">
              Download each verified customer export, deliver it through your
              compliance process, then mark the request completed.
            </s-banner>
            {privacyRequests.map((privacyRequest) => (
              <s-stack
                key={privacyRequest.id}
                direction="inline"
                gap="base"
                alignItems="center"
              >
                <s-link href={`/app/privacy/${privacyRequest.id}`}>
                  Download request from{" "}
                  {formatDate(privacyRequest.createdAt.toString())}
                </s-link>
                <form
                  method="post"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit(event.currentTarget);
                  }}
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="resolvePrivacyRequest"
                  />
                  <input
                    type="hidden"
                    name="requestId"
                    value={privacyRequest.id}
                  />
                  <s-button type="submit" variant="secondary">
                    Mark completed
                  </s-button>
                </form>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      )}
      <s-section heading="Recent returns" padding="none">
        {agentReturns.length === 0 ? (
          <s-box padding="large">
            <s-paragraph color="subdued">
              No customer-agent return requests have been received yet.
            </s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Requested</s-table-header>
              <s-table-header listSlot="labeled">Status</s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Refund
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {agentReturns.map((agentReturn) => (
                <s-table-row key={agentReturn.id}>
                  <s-table-cell>
                    {agentReturn.orderName ?? agentReturn.orderId}
                  </s-table-cell>
                  <s-table-cell>
                    {formatDate(agentReturn.createdAt.toString())}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-200">
                      <s-stack
                        direction="inline"
                        gap="small-200"
                        alignItems="center"
                      >
                        <s-badge
                          tone={
                            agentReturn.status !== "NEEDS_ATTENTION" && agentReturn.refundStatus === "SUCCESS"
                              ? "success"
                              : agentReturn.status === "NEEDS_ATTENTION"
                                ? "critical"
                                : agentReturn.status === "NOT_SUBMITTED"
                                  ? "warning"
                                  : "info"
                          }
                        >
                          {describeRefundProgress(agentReturn).title}
                        </s-badge>
                        {agentReturn.returnId && !agentReturn.itemReceivedAt && (
                          <s-link
                            href={`shopify:admin/orders/${agentReturn.orderId.split("/").pop()}`}
                          >
                            Add a return label or tracking
                          </s-link>
                        )}
                        {agentReturn.receivable &&
                          agentReturn.refundTiming !== "ON_RECEIPT" &&
                          returnAction(
                            "receiveReturn",
                            agentReturn.id,
                            null,
                            "Mark received and restock",
                          )}
                      </s-stack>
                      {agentReturn.itemReceivedAt && (
                        <s-paragraph color="subdued">
                          Item received{" "}
                          {formatDate(agentReturn.itemReceivedAt.toString())}
                        </s-paragraph>
                      )}
                      {agentReturn.failureReason && (
                        <s-paragraph>{agentReturn.failureReason}</s-paragraph>
                      )}
                      {agentReturn.removable &&
                        returnAction(
                          "removeReturn",
                          agentReturn.id,
                          agentReturn.status === "NOT_SUBMITTED"
                            ? "Shopify turned this request down, so no return or refund exists. Removing it clears it from this list."
                            : "Shopify never confirmed a return for this request. Check the order in Shopify first; removing it only clears it from Gooper.io so the customer can try again.",
                          "Remove",
                        )}
                      {agentReturn.retryable &&
                        returnAction(
                          "retryReturn",
                          agentReturn.id,
                          "Retrying checks Shopify first. It refunds the amount the customer confirmed only if the return is still requested or open and no refund exists for it or for the order since the request. A return set to refund on receipt goes back to waiting for its item.",
                          "Retry refund",
                        )}
                      {agentReturn.receivable &&
                        agentReturn.refundTiming === "ON_RECEIPT" &&
                        returnAction(
                          "receiveReturn",
                          agentReturn.id,
                          "Once the item is back, this checks Shopify for any existing refund, then refunds the amount the customer confirmed and restocks the item.",
                          "Mark received and refund",
                        )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {agentReturn.amount && agentReturn.currencyCode
                      ? formatMoney({
                          amount: agentReturn.amount,
                          currencyCode: agentReturn.currencyCode,
                        })
                      : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="Store directory listing">
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            submit(event.currentTarget);
          }}
        >
          <input type="hidden" name="intent" value="setListing" />
          <input type="hidden" name="listed" value={listed ? "false" : "true"} />
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {listed
                ? "Your store is listed, so customers and assistants can find it by name in Gooper.io's store directory."
                : "Your store is hidden from Gooper.io's store directory."}
            </s-paragraph>
            <s-paragraph color="subdued">
              Listing publishes only your store name, website and Gooper.io return
              page, at /stores, in /llms.txt and to assistants searching the
              directory. Customers still verify every purchase, by confirming
              their email or with your store&apos;s Shopify sign-in. Hiding the store doesn&apos;t affect
              your return portal, your app proxy guide, or returns started from
              your own website.
            </s-paragraph>
            <s-box>
              <s-button type="submit" variant="secondary">
                {listed
                  ? "Hide my store from the directory"
                  : "List my store in the directory"}
              </s-button>
            </s-box>
          </s-stack>
        </form>
      </s-section>

      {actionData?.error && (
        <s-banner heading={actionData.heading} tone="critical">
          {actionData.error}
        </s-banner>
      )}

      {privacyResolved && (
        <s-banner heading="Privacy request completed" tone="success">
          The request has been removed from the pending queue.
        </s-banner>
      )}


      <s-section heading="Automatic refund payments (optional)">
        <form
          method="post"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData();
            formData.set(
              "automaticRefundsEnabled",
              automaticRefundsEnabled ? "true" : "false",
            );
            formData.set("returnWindowDays", returnWindowDays);
            formData.set("maxAutoRefundAmount", maxAutoRefundAmount);
            formData.set("returnLocationId", returnLocationId);
            formData.set("refundTiming", refundTiming);
            formData.set("returnInstructions", returnInstructions);
            formData.set("returnPolicyUrl", returnPolicyUrl);
            formData.set(
              "verifiedStoreLinks",
              verifiedStoreLinks ? "true" : "false",
            );
            formData.set("restockingFeePercent", restockingFeePercent);
            formData.set("returnShippingFee", returnShippingFee);
            for (const id of finalSaleCollectionIds)
              formData.append("finalSaleCollectionIds", id);
            submit(formData, { method: "post" });
          }}
        >
          <s-stack direction="block" gap="base">
            {/* Two groups of settings side by side, so the form is as tall
                as its longer half rather than both halves stacked. */}
            <s-grid
              gridTemplateColumns="@container (inline-size <= 700px) 1fr, 1fr 1fr"
              gap="base"
            >
              <s-stack direction="block" gap="base">
                <s-switch
                  label="Authorize eligible refunds to the original payment method on customer confirmation"
                  checked={automaticRefundsEnabled}
                  onChange={(event) =>
                    setAutomaticRefundsEnabled(event.currentTarget.checked)
                  }
                ></s-switch>
                <s-paragraph color="subdued">
                  Estimates work without enabling this setting. When enabled, the
                  customer signs in, selects an eligible item, sees the calculated
                  amount and refund timing, and confirms it. Shopify then opens the
                  return, and the refund goes to the original payment method.
                </s-paragraph>
                <s-grid
                  gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))"
                  gap="base"
                >
                  <s-number-field
                    label="Return window (days)"
                    min={1}
                    max={365}
                    step={1}
                    value={returnWindowDays}
                    onChange={(event) =>
                      setReturnWindowDays(event.currentTarget.value)
                    }
                    required
                  ></s-number-field>
                  <s-money-field
                    label={`Maximum automatic refund (${policy.currencyCode})`}
                    min={0.01}
                    max={100000}
                    value={maxAutoRefundAmount}
                    onChange={(event) =>
                      setMaxAutoRefundAmount(event.currentTarget.value)
                    }
                    required
                  ></s-money-field>
                  <s-select
                    label="When to refund"
                    value={refundTiming}
                    onChange={(event) => setRefundTiming(event.currentTarget.value)}
                  >
                    <s-option value="IMMEDIATE">
                      As soon as the customer confirms the return
                    </s-option>
                    <s-option value="ON_RECEIPT">
                      After I mark the returned item received
                    </s-option>
                  </s-select>
                  <s-select
                    label="Restock returned items to"
                    value={returnLocationId}
                    onChange={(event) =>
                      setReturnLocationId(event.currentTarget.value)
                    }
                  >
                    <s-option value="">
                      The location that fulfilled the order
                    </s-option>
                    {locations.map((location) => (
                      <s-option key={location.id} value={location.id}>
                        {location.name}
                      </s-option>
                    ))}
                  </s-select>
                </s-grid>
                <s-paragraph>
                  Immediate refunds reach customers before you receive or inspect
                  the item, so your store carries the risk if it never comes back.
                  Refunds on receipt approve the return at confirmation, then refund
                  and restock when you mark the item received below.
                </s-paragraph>
                <s-paragraph color="subdued">
                  Leave the restock location on the fulfilling location unless you
                  route returns to a dedicated warehouse. If an order was fulfilled
                  from more than one location and you have not chosen one here,
                  received items are recorded as not restocked.
                </s-paragraph>
                <s-paragraph color="subdued">
                  For customers signed in to your store, restocking and return
                  shipping fees come from your Shopify return rules (Settings, then
                  Policies). Customers see them in their quote, and Gooper.io deducts
                  them from the refund it submits.
                </s-paragraph>
              </s-stack>
              <s-stack direction="block" gap="base">
                {!policy.returnRulesConfirmedAt && (
                  <s-banner heading="Save to turn on assistant returns" tone="info">
                    Customers can&apos;t start returns at your store from ChatGPT or
                    Claude until you review the fees and final-sale collections
                    below and save.
                  </s-banner>
                )}
                {policy.returnRulesMismatch && (
                  <s-banner
                    heading="Assistant returns are paused"
                    tone="warning"
                  >
                    {policy.returnRulesMismatch} Check the fees and final-sale
                    collections below against your Shopify return rules, then save.
                  </s-banner>
                )}
                <s-switch
                  label="Let customers return through their AI assistant"
                  checked={verifiedStoreLinks}
                  onChange={(event) =>
                    setVerifiedStoreLinks(event.currentTarget.checked)
                  }
                ></s-switch>
                <s-paragraph color="subdued">
                  Customers who add Gooper.io to ChatGPT or Claude confirm their email
                  once, and Gooper.io finds their orders at your store by that email,
                  with no store sign-in. Shopify doesn’t apply your return rules to
                  those returns, so Gooper.io applies the fees and final-sale
                  collections below. Saving confirms they match your Shopify return
                  rules. Turn this off to stop returns through assistants; your
                  return portal keeps working.
                </s-paragraph>
                <s-grid
                  gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))"
                  gap="base"
                >
                  <s-number-field
                    label="Restocking fee (%)"
                    min={0}
                    max={100}
                    step={0.01}
                    value={restockingFeePercent}
                    onChange={(event) =>
                      setRestockingFeePercent(event.currentTarget.value)
                    }
                  ></s-number-field>
                  <s-money-field
                    label={`Return shipping fee (${policy.currencyCode})`}
                    min={0}
                    max={1000}
                    value={returnShippingFee}
                    onChange={(event) =>
                      setReturnShippingFee(event.currentTarget.value)
                    }
                  ></s-money-field>
                </s-grid>
                {canReadProducts ? (
                  collections.length ? (
                    <s-stack direction="block" gap="small-200">
                      <s-text>
                        Final-sale collections (up to {finalSaleCollectionLimit})
                      </s-text>
                      {collections.map((collection) => {
                        const checked = finalSaleCollectionIds.includes(
                          collection.id,
                        );
                        return (
                          <s-checkbox
                            key={collection.id}
                            label={collection.title}
                            checked={checked}
                            disabled={
                              !checked &&
                              finalSaleCollectionIds.length >=
                                finalSaleCollectionLimit
                            }
                            onChange={(event) => {
                              const selected = event.currentTarget.checked;
                              setFinalSaleCollectionIds((current) =>
                                selected
                                  ? [...current, collection.id]
                                  : current.filter((id) => id !== collection.id),
                              );
                            }}
                          ></s-checkbox>
                        );
                      })}
                    </s-stack>
                  ) : (
                    <s-paragraph color="subdued">
                      Your store has no collections to mark as final sale.
                    </s-paragraph>
                  )
                ) : (
                  <s-paragraph color="subdued">
                    To mark final-sale collections, approve Gooper.io&apos;s updated
                    permission to read products when Shopify asks.
                  </s-paragraph>
                )}
                <s-text-area
                  label="Return instructions for customers and assistants"
                  details={`Shown with every quote, on your public return page, and in your store's Gooper.io agent guide and manifest. Plain text, up to ${instructionsMaxLength} characters.`}
                  maxLength={instructionsMaxLength}
                  rows={4}
                  value={returnInstructions}
                  onChange={(event) =>
                    setReturnInstructions(event.currentTarget.value)
                  }
                ></s-text-area>
                <s-url-field
                  label="Return policy page"
                  details="A page on your own store domain, such as your Shopify refund policy."
                  value={returnPolicyUrl}
                  onChange={(event) => setReturnPolicyUrl(event.currentTarget.value)}
                ></s-url-field>
              </s-stack>
            </s-grid>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button type="submit" variant="primary">
                Save policy
              </s-button>
              <s-badge
                tone={policy.automaticRefundsEnabled ? "success" : "warning"}
              >
                {policy.automaticRefundsEnabled
                  ? "Automatic payments on"
                  : "Quotes only"}
              </s-badge>
            </s-stack>
          </s-stack>
        </form>
      </s-section>

      <s-section slot="aside" heading="Add a return button to your storefront (optional)">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Your return portal already works without this. Turning it on adds a
            “Start a return” button to the bottom-right corner of every page of
            your store, plus return details that AI shopping assistants can
            read. It works with every Shopify theme, including older ones.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              <s-text type="strong">Turn it on:</s-text> click the button below.
              Your theme editor opens with it switched on. Click Save.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Hide the button, keep AI assistant support:</s-text>{" "}
              in the theme editor, open App embeds → AI return assistance and
              untick Show the return button.
            </s-list-item>
            <s-list-item>
              <s-text type="strong">Turn it off completely:</s-text> go to Online
              Store → Themes → Customize → App embeds, switch off AI return
              assistance, then Save. Uninstalling Gooper.io also removes it.
            </s-list-item>
          </s-unordered-list>
          <s-box>
            <s-button
              href={siteToolsActivationUrl}
              target="_top"
              variant="secondary"
            >
              {storefrontActive
                ? "Manage storefront assistance"
                : "Activate in theme editor"}
            </s-button>
          </s-box>
          {storefrontActive && (
            <s-badge tone="success">Active on your published theme</s-badge>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Returns section for your store's agents.md (optional)">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Gooper.io already serves a current return guide at
            /apps/refund/agents.md. Only if your theme publishes its own
            agents.md, copy this Returns section into it, and copy it again
            whenever you change your return guidance.
          </s-paragraph>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button onClick={() => void copyTemplate()}>
              Copy Returns section
            </s-button>
            <s-text color="subdued">{copyStatus}</s-text>
          </s-stack>
        </s-stack>
      </s-section>

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
