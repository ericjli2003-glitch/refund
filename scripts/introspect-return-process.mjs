// Print the exact Admin API schema for the returnProcess input types.
//
//   SHOP=your-store.myshopify.com ADMIN_TOKEN=shpat_... \
//     node scripts/introspect-return-process.mjs
//
// Writes schema/return-process.json next to the repo root. Read-only: this
// performs a schema introspection and never touches an order, return or refund.

import { mkdir, writeFile } from "node:fs/promises";

const shop = process.env.SHOP;
const apiVersion = process.env.API_VERSION || "2026-07";

if (!shop) {
  console.error(
    "Set SHOP. Example:\n" +
      "  SHOP=testing-bl7vdfur.myshopify.com node scripts/introspect-return-process.mjs",
  );
  process.exit(1);
}

// Prefer an explicit token. Otherwise reuse the offline token this app already
// holds for the store, which is what it authenticates Admin API calls with.
async function resolveToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  if (!process.env.DATABASE_URL) {
    console.error(
      "Set ADMIN_TOKEN, or set DATABASE_URL to reuse the token the app already has for this store.",
    );
    process.exit(1);
  }
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const sessions = await prisma.session.findMany({
      where: { shop },
      select: { id: true, isOnline: true, scope: true, accessToken: true },
    });
    if (!sessions.length) {
      const known = await prisma.session.findMany({
        distinct: ["shop"],
        select: { shop: true },
      });
      console.error(
        `No session stored for ${shop}.\nStores with sessions: ${
          known.map((row) => row.shop).join(", ") || "(none)"
        }`,
      );
      process.exit(1);
    }
    const offline = sessions.find((row) => !row.isOnline) || sessions[0];
    console.log(
      `Using ${offline.isOnline ? "online" : "offline"} session ${offline.id}\n` +
        `Scopes: ${offline.scope || "(none recorded)"}`,
    );
    return offline.accessToken;
  } finally {
    await prisma.$disconnect();
  }
}

const token = await resolveToken();

// One cheap authenticated call first, so a bad token reports itself once
// rather than nine times.
{
  const probe = await fetch(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query: "{ shop { name myshopifyDomain } }" }),
    },
  );
  if (!probe.ok) {
    console.error(
      `\nThe token was rejected: HTTP ${probe.status} ${probe.statusText}.\n` +
        "An offline session can go stale if the app was reinstalled or its scopes changed.\n" +
        "Reinstall the app on the store, or use a custom app token via ADMIN_TOKEN.",
    );
    process.exit(1);
  }
  const body = await probe.json();
  console.log(`Authenticated against ${body.data?.shop?.myshopifyDomain}\n`);
}

const TYPES = [
  "ReturnProcessInput",
  "ReturnProcessReturnLineItemInput",
  "ReturnProcessFinancialTransferInput",
  "ReturnProcessIssueRefundInput",
  "ReturnProcessOrderTransactionInput",
  "ReturnDispositionInput",
  "ReturnDispositionType",
  "ReturnLineItem",
  "ReverseFulfillmentOrderLineItem",
];

// Two levels of ofType unwraps NonNull(List(NonNull(X))) without recursion.
const TYPE_REF = `
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name } } }
`;

const QUERY = `
  query IntrospectReturnProcess($name: String!) {
    __type(name: $name) {
      kind
      name
      description
      enumValues(includeDeprecated: true) { name description isDeprecated }
      inputFields {
        name
        description
        defaultValue
        type { ${TYPE_REF} }
      }
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        type { ${TYPE_REF} }
      }
    }
  }
`;

async function introspect(name) {
  const response = await fetch(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query: QUERY, variables: { name } }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `${name}: HTTP ${response.status} ${response.statusText}. ` +
        "Check the store domain, the token and that the token has Admin API access.",
    );
  }

  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(`${name}: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data.__type;
}

const results = {};
for (const name of TYPES) {
  try {
    const type = await introspect(name);
    results[name] = type;
    if (!type) {
      console.log(`${name}: not present in ${apiVersion}`);
      continue;
    }
    const count =
      type.inputFields?.length ?? type.enumValues?.length ?? type.fields?.length ?? 0;
    console.log(`${name}: ${type.kind}, ${count} entries`);
  } catch (error) {
    results[name] = { error: String(error.message || error) };
    console.error(String(error.message || error));
  }
}

await mkdir("schema", { recursive: true });
await writeFile(
  "schema/return-process.json",
  JSON.stringify({ shop, apiVersion, types: results }, null, 2),
);
console.log("\nWrote schema/return-process.json");
