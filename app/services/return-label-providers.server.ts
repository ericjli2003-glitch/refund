// Return labels bought on the merchant's own shipping-label account. Each
// provider is a thin client over its REST API behind one interface, so the
// rest of Gooper.io never depends on which one a store connected.
//
// Labels are bought as ordinary shipments from the customer to the store, not
// with the providers' return flags: Shippo only swaps addresses for USPS,
// FedEx and UPS, so a return flag could send a Canada Post label the wrong
// way. The trade-off is that the label is charged when bought, not on scan.

export const LABEL_PROVIDERS = ["EASYPOST", "SHIPPO"] as const;
export type LabelProviderName = (typeof LABEL_PROVIDERS)[number];

export const PROVIDER_NAMES: Record<LabelProviderName, string> = {
  EASYPOST: "EasyPost",
  SHIPPO: "Shippo",
};

export type LabelAddress = {
  name: string;
  company?: string | null;
  street1: string;
  street2?: string | null;
  city: string;
  state?: string | null;
  zip: string;
  country: string;
  phone?: string | null;
};

export type DistanceUnit = "in" | "cm";
export type MassUnit = "oz" | "lb" | "g" | "kg";

export type Parcel = {
  length: number;
  width: number;
  height: number;
  distanceUnit: DistanceUnit;
  weight: number;
  massUnit: MassUnit;
};

export type PurchasedLabel = {
  shipmentId: string;
  labelUrl: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string;
  cost: { amount: string; currency: string } | null;
};

export type LabelProvider = {
  verifyKey(): Promise<void>;
  buyLabel(input: {
    from: LabelAddress;
    to: LabelAddress;
    parcel: Parcel;
    reference: string;
  }): Promise<PurchasedLabel>;
};

// Messages here are shown to the merchant; they never include the API key.
export class LabelProviderError extends Error {}

type Fetch = typeof fetch;

const TIMEOUT_MS = 20_000;

// A test key buys sample labels and bills nothing.
export function isTestKey(provider: LabelProviderName, apiKey: string) {
  return provider === "EASYPOST"
    ? apiKey.startsWith("EZTK")
    : apiKey.startsWith("shippo_test_");
}

const httpsOrNull = (value: unknown) =>
  typeof value === "string" && /^https:\/\//i.test(value) ? value : null;

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

// Rates come back as decimal strings; the cheapest one is bought.
function cheapest<T>(rates: T[], amount: (rate: T) => unknown) {
  return rates
    .map((rate) => ({ rate, value: Number(amount(rate)) }))
    .filter((entry) => Number.isFinite(entry.value) && entry.value >= 0)
    .sort((a, b) => a.value - b.value)[0]?.rate;
}

async function request(
  fetchImpl: Fetch,
  providerName: string,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new LabelProviderError(`${providerName} could not be reached. Try again shortly.`);
  }
  if (response.status === 401 || response.status === 403)
    throw new LabelProviderError(
      `${providerName} did not accept the API key. Check it in your ${providerName} account and connect it again.`,
    );
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body) {
    const detail = providerErrorText(body);
    throw new LabelProviderError(
      `${providerName} refused the request${detail ? `: ${detail}` : ` (HTTP ${response.status})`}.`,
    );
  }
  return body;
}

function providerErrorText(body: Record<string, unknown> | null) {
  if (!body) return null;
  const error = body.error as Record<string, unknown> | undefined;
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  const parts = [
    text(error?.message),
    text(body.detail),
    ...(Array.isArray(messages) ? messages.map((message) => text(message.text)) : []),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("; ").slice(0, 300) : null;
}

const round1 = (value: number) => Math.max(0.1, Math.round(value * 10) / 10);

// EasyPost takes inches and ounces only.
export function toInchesAndOunces(parcel: Parcel) {
  const inches = (value: number) => round1(parcel.distanceUnit === "cm" ? value / 2.54 : value);
  const ounces = {
    oz: 1,
    lb: 16,
    g: 1 / 28.349523125,
    kg: 35.27396195,
  }[parcel.massUnit];
  return {
    length: inches(parcel.length),
    width: inches(parcel.width),
    height: inches(parcel.height),
    weight: round1(parcel.weight * ounces),
  };
}

const omitEmpty = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value != null && value !== ""));

const providerAddress = (address: LabelAddress) =>
  omitEmpty({
    name: address.name,
    company: address.company,
    street1: address.street1,
    street2: address.street2,
    city: address.city,
    state: address.state,
    zip: address.zip,
    country: address.country,
    phone: address.phone,
  });

function easyPost(apiKey: string, fetchImpl: Fetch): LabelProvider {
  const base = "https://api.easypost.com/v2";
  const headers = {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "Content-Type": "application/json",
  };
  const call = (path: string, init: RequestInit = {}) =>
    request(fetchImpl, "EasyPost", `${base}${path}`, { ...init, headers });
  return {
    async verifyKey() {
      await call("/shipments?page_size=1");
    },
    async buyLabel({ from, to, parcel, reference }) {
      const shipment = await call("/shipments", {
        method: "POST",
        body: JSON.stringify({
          shipment: {
            from_address: providerAddress(from),
            to_address: providerAddress(to),
            parcel: toInchesAndOunces(parcel),
            reference,
            options: { label_format: "PDF" },
          },
        }),
      });
      const shipmentId = text(shipment.id);
      const rates = Array.isArray(shipment.rates)
        ? (shipment.rates as Array<Record<string, unknown>>)
        : [];
      const rate = cheapest(rates, (entry) => entry.rate);
      if (!shipmentId || !rate || !text(rate.id))
        throw new LabelProviderError(
          `EasyPost found no rates for this return${providerErrorText(shipment) ? `: ${providerErrorText(shipment)}` : ""}. Check the store address, the box size and which carriers are on in EasyPost.`,
        );
      const bought = await call(`/shipments/${encodeURIComponent(shipmentId)}/buy`, {
        method: "POST",
        body: JSON.stringify({ rate: { id: rate.id } }),
      });
      const postage = (bought.postage_label ?? {}) as Record<string, unknown>;
      const labelUrl = httpsOrNull(postage.label_pdf_url) ?? httpsOrNull(postage.label_url);
      if (!labelUrl) throw new LabelProviderError("EasyPost bought the label but returned no label file.");
      const selected = (bought.selected_rate ?? rate) as Record<string, unknown>;
      const tracker = (bought.tracker ?? {}) as Record<string, unknown>;
      return {
        shipmentId,
        labelUrl,
        trackingNumber: text(bought.tracking_code),
        trackingUrl: httpsOrNull(tracker.public_url),
        carrier: [text(selected.carrier), text(selected.service)].filter(Boolean).join(" ") || "Carrier",
        cost:
          text(selected.rate) && text(selected.currency)
            ? { amount: text(selected.rate)!, currency: text(selected.currency)! }
            : null,
      };
    },
  };
}

function shippo(apiKey: string, fetchImpl: Fetch): LabelProvider {
  const base = "https://api.goshippo.com";
  const headers = {
    Authorization: `ShippoToken ${apiKey}`,
    "Content-Type": "application/json",
  };
  const call = (path: string, init: RequestInit = {}) =>
    request(fetchImpl, "Shippo", `${base}${path}`, { ...init, headers });
  return {
    async verifyKey() {
      await call("/addresses/?results=1");
    },
    async buyLabel({ from, to, parcel, reference }) {
      const shipment = await call("/shipments/", {
        method: "POST",
        body: JSON.stringify({
          address_from: providerAddress(from),
          address_to: providerAddress(to),
          parcels: [
            {
              length: String(parcel.length),
              width: String(parcel.width),
              height: String(parcel.height),
              distance_unit: parcel.distanceUnit,
              weight: String(parcel.weight),
              mass_unit: parcel.massUnit,
            },
          ],
          metadata: reference,
          async: false,
        }),
      });
      const shipmentId = text(shipment.object_id);
      const rates = Array.isArray(shipment.rates)
        ? (shipment.rates as Array<Record<string, unknown>>)
        : [];
      const rate = cheapest(rates, (entry) => entry.amount);
      if (!shipmentId || !rate || !text(rate.object_id))
        throw new LabelProviderError(
          `Shippo found no rates for this return${providerErrorText(shipment) ? `: ${providerErrorText(shipment)}` : ""}. Check the store address, the box size and which carriers are on in Shippo.`,
        );
      const transaction = await call("/transactions/", {
        method: "POST",
        body: JSON.stringify({
          rate: rate.object_id,
          label_file_type: "PDF",
          metadata: reference,
          async: false,
        }),
      });
      const labelUrl = httpsOrNull(transaction.label_url);
      if (transaction.status !== "SUCCESS" || !labelUrl)
        throw new LabelProviderError(
          `Shippo could not buy the label${providerErrorText(transaction) ? `: ${providerErrorText(transaction)}` : "."}`,
        );
      const service = (rate.servicelevel ?? {}) as Record<string, unknown>;
      return {
        shipmentId,
        labelUrl,
        trackingNumber: text(transaction.tracking_number),
        trackingUrl: httpsOrNull(transaction.tracking_url_provider),
        carrier: [text(rate.provider), text(service.name)].filter(Boolean).join(" ") || "Carrier",
        cost:
          text(rate.amount) && text(rate.currency)
            ? { amount: text(rate.amount)!, currency: text(rate.currency)! }
            : null,
      };
    },
  };
}

export function labelProvider(
  provider: LabelProviderName,
  apiKey: string,
  fetchImpl: Fetch = fetch,
): LabelProvider {
  return provider === "EASYPOST" ? easyPost(apiKey, fetchImpl) : shippo(apiKey, fetchImpl);
}
