import { randomUUID } from "node:crypto";
import { z } from "zod";
import { data } from "react-router";
import { appOrigin } from "./customer-security.server";
import type { AdminGraphql } from "./shopify-admin.server";
import {
  attachShopifyReturn,
  fundedOrderCandidates,
  releaseFundedCase,
  startFundedCaseFromOrder,
} from "./funded-shopify-return.server";
import { FundedConflictError } from "./funded-entitlements.server";
import prisma from "../db.server";
import {
  createFundedSandbox,
  listFundedSandboxes,
  requireFundedSandbox,
  updateFundedSandbox,
} from "./funded-return-sandbox.server";
import {
  dispatchPaymentIntents,
  fundedPaymentProvider,
  ingestProviderEvent,
  listSandboxPayments,
  reconcilePaymentIntents,
  requestSandboxPayment,
} from "./funded-payment-intents.server";
import {
  planSandboxScenario,
  releaseSandboxEvents,
  replaySandboxEvents,
  sandboxScenarioSchema,
} from "./funded-sandbox-provider.server";
import { ProviderEventRejected } from "./funded-payment-provider.server";
import {
  parseSandboxMoney,
  SandboxError,
  sandboxCommandSchema,
} from "../funded-return-sandbox";

// The merchant screen's server logic, with Shopify admin authentication passed
// in so tests can prove its ordering and store scoping without a live session.
// The sandbox gate always runs first: production answers 404 before any auth.
export type AuthenticateAdmin = (
  request: Request,
) => Promise<{ session: { shop: string }; admin?: AdminGraphql }>;

export async function fundedReturnsLoader(
  request: Request,
  authenticateAdmin: AuthenticateAdmin,
) {
  requireFundedSandbox();
  const { session, admin } = await authenticateAdmin(request);
  const cases = await listFundedSandboxes(session.shop);
  // Real orders are optional context; the sandbox works without them.
  let orders: Awaited<ReturnType<typeof fundedOrderCandidates>> = [];
  let ordersError: string | null = null;
  if (admin)
    try {
      orders = await fundedOrderCandidates(admin);
    } catch (error) {
      ordersError = error instanceof Error ? error.message : "Shopify could not list orders.";
    }
  const funded = await prisma.fundedEntitlement.findMany({
    where: { shop: session.shop, caseId: { in: cases.map((row) => row.id) } },
    select: {
      caseId: true,
      lineItemId: true,
      quantity: true,
      status: true,
      shopifyReturnId: true,
      conflictReason: true,
    },
  });
  return data(
    {
      cases,
      payments: await listSandboxPayments(
        session.shop,
        cases.map((row) => row.id),
      ),
      orders,
      ordersError,
      funded,
      actionId: randomUUID(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const noStore = { "Cache-Control": "no-store" };

async function deliver(
  deliveries: Awaited<ReturnType<typeof releaseSandboxEvents>>,
) {
  const provider = fundedPaymentProvider();
  const results: string[] = [];
  for (const delivery of deliveries)
    results.push(
      await ingestProviderEvent(provider, delivery.rawBody, delivery.headers),
    );
  return results.length
    ? `Delivered ${results.length} provider event(s): ${results.join(", ")}.`
    : "No provider events were waiting.";
}

export async function fundedReturnsAction(
  request: Request,
  authenticateAdmin: AuthenticateAdmin,
) {
  requireFundedSandbox();
  const { session, admin } = await authenticateAdmin(request);
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  if (request.headers.get("Origin") !== appOrigin())
    throw new Response("Invalid origin", { status: 403 });
  const form = await request.formData();
  const shop = session.shop;
  const intent = String(form.get("intent") ?? "");
  try {
    let notice: string | null = null;
    if (intent === "fromOrder" || intent === "attachReturn" || intent === "releaseOrder") {
      if (!admin) throw new FundedConflictError("Shopify isn't connected for this request.");
      if (intent === "fromOrder") {
        const started = await startFundedCaseFromOrder({
          admin,
          shop,
          orderId: z.string().parse(form.get("orderId")),
          lineItemId: z.string().parse(form.get("lineItemId")),
          quantity: z.coerce.number().int().positive().parse(form.get("quantity")),
        });
        notice = `Started a funded case for this order. Shopify return ${started.returnId} holds the funded units, and the order is tagged gooper-funded.`;
      } else if (intent === "releaseOrder") {
        const result = await releaseFundedCase({
          admin,
          shop,
          caseId: z.string().uuid().parse(form.get("id")),
        });
        notice = result.problems.length
          ? `Released ${result.released} item(s), but Shopify didn't cancel the return (${result.problems.join("; ")}). Cancel it in Shopify admin.`
          : `Released ${result.released} item(s) and cancelled the Shopify return.`;
      } else {
        const returnId = await attachShopifyReturn({
          admin,
          shop,
          caseId: z.string().uuid().parse(form.get("id")),
        });
        notice = `Shopify return ${returnId} holds the funded units.`;
      }
    } else if (intent === "deliver") {
      notice = await deliver(await releaseSandboxEvents(shop));
    } else if (intent === "replay") {
      notice = await deliver(await replaySandboxEvents(shop));
    } else if (intent === "reconcile") {
      const summary = await reconcilePaymentIntents(fundedPaymentProvider(), {
        shop,
        ignoreSchedule: true,
      });
      notice = `Checked ${summary.checked} payment(s) with the sandbox provider. Resubmitted with the same key: ${summary.resubmitted}. Recovered interrupted submissions: ${summary.recovered}. Held for review: ${summary.review}.`;
    } else {
      const id = z.string().uuid().parse(form.get("id"));
      const version = () =>
        z.coerce.number().int().nonnegative().parse(form.get("version"));
      if (intent === "create") {
        const currency = z.enum(["CAD", "USD"]).parse(form.get("currency"));
        await createFundedSandbox(shop, id, currency);
      } else if (
        intent === "REQUEST_PAYOUT" ||
        intent === "REQUEST_COLLECTION"
      ) {
        const scenario = sandboxScenarioSchema.parse(form.get("scenario"));
        const payment = await requestSandboxPayment({
          shop,
          caseId: id,
          version: version(),
          commandId: z.string().uuid().parse(form.get("actionId")),
          operation: intent === "REQUEST_PAYOUT" ? "payout" : "collection",
        });
        // The intent is committed first; only then is the provider called.
        await planSandboxScenario(
          shop,
          {
            idempotencyKey: payment.id,
            operation: payment.operation as "PAYOUT" | "COLLECTION",
            amountMinor: payment.amountMinor,
            currency: payment.currency as "CAD" | "USD",
          },
          scenario,
        );
        await dispatchPaymentIntents(fundedPaymentProvider(), { shop });
      } else {
        const command = sandboxCommandSchema.parse({
          id: form.get("actionId"),
          action: intent,
          ...(intent === "INSPECT_ITEM"
            ? {
                acceptedMinor: parseSandboxMoney(
                  String(form.get("acceptedAmount") ?? ""),
                ),
              }
            : {}),
        });
        await updateFundedSandbox(shop, id, version(), command);
      }
    }
    return data({ error: null, notice }, { headers: noStore });
  } catch (error) {
    if (
      error instanceof SandboxError ||
      error instanceof FundedConflictError ||
      error instanceof ProviderEventRejected ||
      error instanceof z.ZodError
    ) {
      return data(
        {
          error:
            error instanceof z.ZodError
              ? "Check the sample action and amount, then try again."
              : error.message,
          notice: null,
        },
        { status: 400, headers: noStore },
      );
    }
    throw error;
  }
}
