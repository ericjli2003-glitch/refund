import FundedReturnsSandboxView from "../components/funded-return-sandbox";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  data,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { appOrigin } from "../services/customer-security.server";
import {
  createFundedSandbox,
  listFundedSandboxes,
  requireFundedSandbox,
  updateFundedSandbox,
} from "../services/funded-return-sandbox.server";
import {
  dispatchPaymentIntents,
  fundedPaymentProvider,
  ingestProviderEvent,
  listSandboxPayments,
  reconcilePaymentIntents,
  requestSandboxPayment,
} from "../services/funded-payment-intents.server";
import {
  planSandboxScenario,
  releaseSandboxEvents,
  replaySandboxEvents,
  sandboxScenarioSchema,
} from "../services/funded-sandbox-provider.server";
import { ProviderEventRejected } from "../services/funded-payment-provider.server";
import {
  parseSandboxMoney,
  SandboxError,
  sandboxCommandSchema,
} from "../funded-return-sandbox";

export async function loader({ request }: LoaderFunctionArgs) {
  requireFundedSandbox();
  const { session } = await authenticate.admin(request);
  const cases = await listFundedSandboxes(session.shop);
  return data(
    {
      cases,
      payments: await listSandboxPayments(
        session.shop,
        cases.map((row) => row.id),
      ),
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

export async function action({ request }: ActionFunctionArgs) {
  requireFundedSandbox();
  const { session } = await authenticate.admin(request);
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  if (request.headers.get("Origin") !== appOrigin())
    throw new Response("Invalid origin", { status: 403 });
  const form = await request.formData();
  const shop = session.shop;
  const intent = String(form.get("intent") ?? "");
  try {
    let notice: string | null = null;
    if (intent === "deliver") {
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

export default function FundedReturnsSandbox() {
  const { cases, payments, actionId } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  return (
    <FundedReturnsSandboxView
      cases={cases}
      payments={payments}
      actionId={actionId}
      error={result?.error}
      notice={result?.notice}
      busy={navigation.state !== "idle"}
      onSubmit={(values) => submit(values, { method: "post" })}
    />
  );
}

export const headers: HeadersFunction = (args) => {
  const responseHeaders = new Headers(boundary.headers(args));
  responseHeaders.set("Cache-Control", "no-store");
  return responseHeaders;
};
