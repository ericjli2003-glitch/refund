import * as z from "zod/v4";
import prisma from "../db.server";
import { seal, unseal } from "./customer-security.server";
import {
  isTestKey,
  LABEL_PROVIDERS,
  labelProvider,
  LabelProviderError,
  PROVIDER_NAMES,
  type DistanceUnit,
  type LabelAddress,
  type LabelProviderName,
  type MassUnit,
  type PurchasedLabel,
} from "./return-label-providers.server";
import { readShipping, SHIPPABLE } from "./return-shipping.server";
import { adminData, type AdminGraphql } from "./shopify-admin.server";
import { isWixStore } from "./store-platform.server";

// Return labels bought on the merchant's own EasyPost or Shippo account once a
// return is approved, then attached to the Shopify return so the customer sees
// the label in chat and in the portal. The carrier bills the merchant through
// that account; Gooper.io buys nothing itself and charges nothing for labels.

type Fetch = typeof fetch;
type UserError = { field?: string[] | null; message: string };

const KEY_PURPOSE = "return-label-account";
const keyContext = (shop: string) => `return-label-key:${shop}`;
const MAX_LABEL_BYTES = 5 * 1024 * 1024;

const errorText = (error: unknown, fallback: string) =>
  (error instanceof Error ? error.message : fallback).slice(0, 500);

// ---------------------------------------------------------------------------
// The merchant's account

const measure = z
  .string()
  .trim()
  .regex(/^\d{1,4}(\.\d{1,2})?$/, "Enter a number like 12 or 4.5.")
  .refine((value) => Number(value) > 0, "Enter a number above zero.");

export const parcelSchema = z.object({
  parcelLength: measure,
  parcelWidth: measure,
  parcelHeight: measure,
  distanceUnit: z.enum(["in", "cm"]),
  parcelWeight: measure,
  massUnit: z.enum(["oz", "lb", "g", "kg"]),
});

export const connectLabelAccountSchema = z.object({
  provider: z.enum(LABEL_PROVIDERS),
  apiKey: z
    .string()
    .trim()
    .min(8, "Paste the full API key.")
    .max(200)
    .regex(/^\S+$/, "An API key has no spaces."),
});

export type LabelAccountSummary = {
  provider: LabelProviderName;
  providerName: string;
  apiKeyHint: string;
  testMode: boolean;
  enabled: boolean;
  parcelLength: string;
  parcelWidth: string;
  parcelHeight: string;
  distanceUnit: DistanceUnit;
  parcelWeight: string;
  massUnit: MassUnit;
};

// The sealed key never leaves this module.
export async function labelAccountFor(shop: string): Promise<LabelAccountSummary | null> {
  const account = await prisma.returnLabelAccount.findUnique({ where: { shop } });
  if (!account) return null;
  const provider = account.provider as LabelProviderName;
  return {
    provider,
    providerName: PROVIDER_NAMES[provider] ?? account.provider,
    apiKeyHint: account.apiKeyHint,
    testMode: account.testMode,
    enabled: account.enabled,
    parcelLength: account.parcelLength,
    parcelWidth: account.parcelWidth,
    parcelHeight: account.parcelHeight,
    distanceUnit: account.distanceUnit as DistanceUnit,
    parcelWeight: account.parcelWeight,
    massUnit: account.massUnit as MassUnit,
  };
}

// The key is checked with the provider before it is saved, so a typo never
// waits until a customer's return to fail.
export async function connectLabelAccount(
  shop: string,
  input: unknown,
  fetchImpl: Fetch = fetch,
) {
  if (isWixStore(shop))
    throw new Error("Return labels from a shipping account are available for Shopify stores only.");
  const { provider, apiKey } = connectLabelAccountSchema.parse(input);
  await labelProvider(provider, apiKey, fetchImpl).verifyKey();
  const data = {
    provider,
    apiKeySealed: seal(apiKey, keyContext(shop), KEY_PURPOSE),
    apiKeyHint: apiKey.slice(-4),
    testMode: isTestKey(provider, apiKey),
    enabled: true,
  };
  await prisma.returnLabelAccount.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
}

export async function saveLabelSettings(shop: string, input: { enabled: boolean } & Record<string, unknown>) {
  const parcel = parcelSchema.parse(input);
  const updated = await prisma.returnLabelAccount.updateMany({
    where: { shop },
    data: { ...parcel, enabled: input.enabled === true },
  });
  if (!updated.count) throw new Error("Connect a shipping account first.");
}

export async function disconnectLabelAccount(shop: string) {
  await prisma.returnLabelAccount.deleteMany({ where: { shop } });
}

// ---------------------------------------------------------------------------
// Addresses

type ShopifyAddress = {
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
  countryCode?: string | null;
  phone?: string | null;
};

const ADDRESSES_QUERY = `#graphql
  query ReturnLabelAddresses($returnId: ID!) {
    return(id: $returnId) {
      order {
        shippingAddress {
          name
          company
          address1
          address2
          city
          provinceCode
          zip
          countryCodeV2
          phone
        }
        fulfillments(first: 5) {
          location { id }
        }
      }
    }
    shop {
      name
      shopAddress {
        address1
        address2
        city
        provinceCode
        zip
        countryCodeV2
        phone
      }
    }
  }
`;

const LOCATION_QUERY = `#graphql
  query ReturnLabelLocation($id: ID!) {
    location(id: $id) {
      address {
        address1
        address2
        city
        provinceCode
        zip
        countryCode
        phone
      }
    }
  }
`;

function labelAddress(address: ShopifyAddress | null | undefined, name: string, company?: string | null): LabelAddress | null {
  const country = address?.countryCodeV2 || address?.countryCode;
  if (!address?.address1 || !address.city || !address.zip || !country) return null;
  return {
    name,
    company: company ?? null,
    street1: address.address1,
    street2: address.address2 ?? null,
    city: address.city,
    state: address.provinceCode ?? null,
    zip: address.zip,
    country,
    phone: address.phone ?? null,
  };
}

// The customer's address is read from Shopify when the label is bought and
// passed only to the merchant's provider; Gooper.io does not store it.
export async function readLabelAddresses(admin: AdminGraphql, shop: string, returnId: string) {
  const data = await adminData<{
    return: {
      order: {
        shippingAddress: ShopifyAddress | null;
        fulfillments: Array<{ location: { id: string } | null }>;
      };
    } | null;
    shop: { name: string; shopAddress: ShopifyAddress | null };
  }>(admin, ADDRESSES_QUERY, { returnId }, "Shopify could not read the addresses for this return.");
  if (!data.return) throw new Error("Shopify could not find this return.");
  const shipping = data.return.order.shippingAddress;
  const customer = labelAddress(shipping, shipping?.name || "Customer", shipping?.company);
  if (!customer)
    throw new Error(
      "Shopify didn't share the customer's shipping address for this order, so no label was bought.",
    );

  const policy = await prisma.storePolicy.findUnique({
    where: { shop },
    select: { returnLocationId: true },
  });
  const locationId =
    policy?.returnLocationId ??
    data.return.order.fulfillments.find((fulfillment) => fulfillment.location)?.location?.id;
  let store: LabelAddress | null = null;
  if (locationId) {
    const { location } = await adminData<{ location: { address: ShopifyAddress } | null }>(
      admin,
      LOCATION_QUERY,
      { id: locationId },
      "Shopify could not read the return location's address.",
    );
    store = labelAddress(location?.address, data.shop.name, data.shop.name);
  }
  store ??= labelAddress(data.shop.shopAddress, data.shop.name, data.shop.name);
  if (!store)
    throw new Error(
      "The store's return address is incomplete in Shopify, so no label was bought. Add a full address to the return location.",
    );
  return { customer, store };
}

// ---------------------------------------------------------------------------
// Attaching the label to the Shopify return

const STAGE_LABEL_MUTATION = `#graphql
  mutation StageReturnLabel($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

// Shopify emails delivery instructions by default; the customer gets the label
// in their chat and the portal instead.
const CREATE_LABEL_DELIVERY_MUTATION = `#graphql
  mutation CreateReturnLabelDelivery(
    $reverseFulfillmentOrderId: ID!
    $trackingInput: ReverseDeliveryTrackingInput
    $labelInput: ReverseDeliveryLabelInput!
  ) {
    reverseDeliveryCreateWithShipping(
      reverseFulfillmentOrderId: $reverseFulfillmentOrderId
      reverseDeliveryLineItems: []
      trackingInput: $trackingInput
      labelInput: $labelInput
      notifyCustomer: false
    ) {
      reverseDelivery { id }
      userErrors { field message }
    }
  }
`;

const UPDATE_LABEL_DELIVERY_MUTATION = `#graphql
  mutation UpdateReturnLabelDelivery(
    $reverseDeliveryId: ID!
    $trackingInput: ReverseDeliveryTrackingInput
    $labelInput: ReverseDeliveryLabelInput!
  ) {
    reverseDeliveryShippingUpdate(
      reverseDeliveryId: $reverseDeliveryId
      trackingInput: $trackingInput
      labelInput: $labelInput
      notifyCustomer: false
    ) {
      reverseDelivery { id }
      userErrors { field message }
    }
  }
`;

function throwOnUserErrors(errors: UserError[], action: string) {
  if (errors.length) throw new Error(`${action}: ${errors.map((error) => error.message).join("; ")}`);
}

async function downloadLabel(fetchImpl: Fetch, labelUrl: string) {
  const response = await fetchImpl(labelUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`The label file could not be downloaded (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_LABEL_BYTES)
    throw new Error("The label file was empty or too large to attach.");
  const mimeType = /image\/png/i.test(response.headers.get("content-type") ?? "")
    ? "image/png"
    : "application/pdf";
  return { bytes, mimeType };
}

// Shopify takes a label file through a staged upload, then the reverse
// delivery points at the uploaded file.
export async function attachLabelToShopify(
  admin: AdminGraphql,
  returnId: string,
  label: Pick<PurchasedLabel, "labelUrl" | "trackingNumber" | "trackingUrl">,
  fetchImpl: Fetch = fetch,
) {
  const shipping = await readShipping(admin, returnId);
  if (!shipping.reverseFulfillmentOrderId)
    throw new Error("Shopify hasn't prepared this return for shipping yet.");
  const { bytes, mimeType } = await downloadLabel(fetchImpl, label.labelUrl);
  const filename = `return-label.${mimeType === "image/png" ? "png" : "pdf"}`;
  const { stagedUploadsCreate } = await adminData<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
      userErrors: UserError[];
    };
  }>(
    admin,
    STAGE_LABEL_MUTATION,
    {
      input: [
        {
          resource: "RETURN_LABEL",
          filename,
          mimeType,
          httpMethod: "POST",
          fileSize: String(bytes.length),
        },
      ],
    },
    "Shopify could not prepare the label upload.",
  );
  throwOnUserErrors(stagedUploadsCreate.userErrors, "Shopify could not prepare the label upload");
  const target = stagedUploadsCreate.stagedTargets[0];
  if (!target?.url || !target.resourceUrl) throw new Error("Shopify returned no upload target for the label.");
  const form = new FormData();
  for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  const upload = await fetchImpl(target.url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!upload.ok) throw new Error(`Shopify did not accept the label file (HTTP ${upload.status}).`);

  const trackingInput = label.trackingNumber
    ? { number: label.trackingNumber, ...(label.trackingUrl ? { url: label.trackingUrl } : {}) }
    : null;
  const labelInput = { fileUrl: target.resourceUrl };
  if (shipping.delivery) {
    const { reverseDeliveryShippingUpdate } = await adminData<{
      reverseDeliveryShippingUpdate: { userErrors: UserError[] };
    }>(
      admin,
      UPDATE_LABEL_DELIVERY_MUTATION,
      { reverseDeliveryId: shipping.delivery.id, trackingInput, labelInput },
      "Shopify could not attach the label.",
    );
    throwOnUserErrors(reverseDeliveryShippingUpdate.userErrors, "Shopify could not attach the label");
  } else {
    const { reverseDeliveryCreateWithShipping } = await adminData<{
      reverseDeliveryCreateWithShipping: { userErrors: UserError[] };
    }>(
      admin,
      CREATE_LABEL_DELIVERY_MUTATION,
      { reverseFulfillmentOrderId: shipping.reverseFulfillmentOrderId, trackingInput, labelInput },
      "Shopify could not attach the label.",
    );
    throwOnUserErrors(reverseDeliveryCreateWithShipping.userErrors, "Shopify could not attach the label");
  }
}

// ---------------------------------------------------------------------------
// Buying the label

export type LabelOutcome =
  | { status: "SKIPPED"; reason: string }
  | { status: "PURCHASED"; attached: boolean; error: string | null }
  | { status: "FAILED"; error: string };

// Never throws: a label problem must not stop a return or its refund. The
// record is claimed first, so a label is bought at most once per return.
export async function buyReturnLabel({
  admin,
  shop,
  recordId,
  fetchImpl = fetch,
}: {
  admin: AdminGraphql;
  shop: string;
  recordId: string;
  fetchImpl?: Fetch;
}): Promise<LabelOutcome> {
  let claimed = false;
  try {
    if (isWixStore(shop)) return { status: "SKIPPED", reason: "Wix stores don't use shipping accounts." };
    const account = await prisma.returnLabelAccount.findUnique({ where: { shop } });
    if (!account) return { status: "SKIPPED", reason: "No shipping account is connected." };
    if (!account.enabled) return { status: "SKIPPED", reason: "Return labels are turned off." };

    const claim = await prisma.agentReturn.updateMany({
      where: {
        id: recordId,
        shop,
        returnId: { not: null },
        itemReceivedAt: null,
        status: { in: SHIPPABLE },
        OR: [{ labelStatus: null }, { labelStatus: "FAILED" }],
      },
      data: { labelStatus: "PURCHASING", labelError: null },
    });
    if (claim.count !== 1)
      return { status: "SKIPPED", reason: "This return already has a label, or can't take one now." };
    claimed = true;
    const record = await prisma.agentReturn.findUniqueOrThrow({
      where: { id: recordId },
      select: { id: true, returnId: true },
    });
    const returnId = record.returnId!;

    // A label the store made, or tracking the customer added, means nothing
    // needs buying.
    const shipping = await readShipping(admin, returnId);
    const deliverable = shipping.delivery?.deliverable;
    if (deliverable?.label?.publicFileUrl || deliverable?.tracking?.number) {
      await prisma.agentReturn.update({
        where: { id: recordId },
        data: { labelStatus: null },
      });
      claimed = false;
      return { status: "SKIPPED", reason: "This return already has a label or tracking in Shopify." };
    }

    const { customer, store } = await readLabelAddresses(admin, shop, returnId);
    const apiKey = unseal(account.apiKeySealed, keyContext(shop), KEY_PURPOSE);
    const label = await labelProvider(account.provider as LabelProviderName, apiKey, fetchImpl).buyLabel({
      from: customer,
      to: store,
      parcel: {
        length: Number(account.parcelLength),
        width: Number(account.parcelWidth),
        height: Number(account.parcelHeight),
        distanceUnit: account.distanceUnit as DistanceUnit,
        weight: Number(account.parcelWeight),
        massUnit: account.massUnit as MassUnit,
      },
      reference: record.id,
    });
    await prisma.agentReturn.update({
      where: { id: recordId },
      data: {
        labelStatus: "PURCHASED",
        labelUrl: label.labelUrl,
        labelCarrier: label.carrier.slice(0, 100),
        labelCost: label.cost?.amount ?? null,
        labelCostCurrency: label.cost?.currency ?? null,
        labelShipmentId: label.shipmentId.slice(0, 100),
        trackingNumber: label.trackingNumber,
        trackingUrl: label.trackingUrl,
      },
    });
    claimed = false;

    // The customer already has the label from the record; attaching it in
    // Shopify is what the merchant sees on the order.
    try {
      await attachLabelToShopify(admin, returnId, label, fetchImpl);
      await prisma.agentReturn.update({
        where: { id: recordId },
        data: { labelAttachedAt: new Date() },
      });
      return { status: "PURCHASED", attached: true, error: null };
    } catch (error) {
      const message = `The label was bought but not attached in Shopify: ${errorText(error, "unknown error")}`;
      await prisma.agentReturn.update({ where: { id: recordId }, data: { labelError: message } });
      return { status: "PURCHASED", attached: false, error: message };
    }
  } catch (error) {
    const message =
      error instanceof LabelProviderError
        ? error.message
        : errorText(error, "The return label could not be bought.");
    if (claimed)
      await prisma.agentReturn
        .update({ where: { id: recordId }, data: { labelStatus: "FAILED", labelError: message } })
        .catch(() => undefined);
    return { status: "FAILED", error: message };
  }
}
