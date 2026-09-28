import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import type { WixApi } from "./wix-api.server";
import {
  isSharedWixHost,
  provisionWixSite,
  removeWixSite,
  syncWixSite,
  WixSiteNotInstalled,
  wixSiteHost,
} from "./wix-site.server";

const instanceId = "1b4f3c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c";
const shop = `wix-${instanceId}`;
const now = new Date("2026-09-28T12:00:00Z");

function mockDelegate(
  t: TestContext,
  target: object,
  name: string,
  implementation: (...args: never[]) => unknown,
) {
  const original = Reflect.get(target, name);
  const mock = t.mock.fn(implementation);
  Reflect.set(target, name, mock);
  t.after(() => Reflect.set(target, name, original));
  return mock;
}

function fakeApi(response: unknown) {
  const calls: [string, string][] = [];
  const api = (async (method: string, path: string) => {
    calls.push([method, path]);
    return response;
  }) as WixApi;
  return { api, calls };
}

const instanceResponse = (site: Record<string, unknown> = {}, instance: Record<string, unknown> = {}) => ({
  instance: {
    instanceId: instanceId.toUpperCase(),
    permissions: ["WIX_STORES.READ_PRODUCTS", "ECOM.READ_ORDERS", 7],
    ...instance,
  },
  site: {
    siteDisplayName: "  Plant   Shop ",
    url: "https://www.plantshop.example",
    paymentCurrency: "usd",
    ...site,
  },
});

const domainTaken = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed on primaryDomain", {
    code: "P2002",
    clientVersion: "test",
    meta: { modelName: "MerchantDirectory", target: ["primaryDomain"] },
  });

type DirectoryWrite = { where: unknown; create?: Record<string, unknown>; update?: Record<string, unknown>; data?: Record<string, unknown> };

function mockWrites(
  t: TestContext,
  stored: unknown = null,
  {
    installed = 1,
    directoryRows = 1,
    takenDomains = [] as string[],
    directoryError = null as Error | null,
  } = {},
) {
  const transaction = mockDelegate(t, prisma, "$transaction", async (ops: Promise<unknown>[]) => Promise.all(ops));
  mockDelegate(t, prisma.merchantDirectory, "findUnique", async () => stored);
  return {
    transaction,
    directory: mockDelegate(t, prisma.merchantDirectory, "upsert", async (args: DirectoryWrite) => {
      if (takenDomains.includes(args.update?.primaryDomain as string)) throw domainTaken();
      return {};
    }),
    directoryUpdate: mockDelegate(t, prisma.merchantDirectory, "updateMany", async (args: DirectoryWrite) => {
      if (directoryError) throw directoryError;
      const domain = args.data?.primaryDomain as string;
      if (takenDomains.includes(domain)) throw domainTaken();
      return { count: directoryRows };
    }),
    installation: mockDelegate(t, prisma.wixInstallation, "upsert", async () => ({})),
    installationUpdate: mockDelegate(t, prisma.wixInstallation, "updateMany", async () => ({ count: installed })),
    policy: mockDelegate(t, prisma.storePolicy, "upsert", async () => ({})),
  };
}

const firstArg = (mock: { mock: { calls: { arguments: unknown[] }[] } }, index = 0) =>
  mock.mock.calls[index].arguments[0] as DirectoryWrite;

test("tells custom domains from shared free Wix hosts", () => {
  assert.equal(wixSiteHost("https://www.plantshop.example/"), "www.plantshop.example");
  assert.equal(wixSiteHost("https://jane.wixsite.com/plants"), "jane.wixsite.com");
  assert.equal(wixSiteHost(""), null);
  assert.equal(wixSiteHost(null), null);
  assert.equal(wixSiteHost("http://insecure.example"), null);
  for (const host of ["jane.wixsite.com", "jane.wixstudio.io", "x.editorx.io", "wix.com"])
    assert.equal(isSharedWixHost(host), true, host);
  for (const host of ["plantshop.example", "notwixsite.com", "wixsite.com.evil.example"])
    assert.equal(isSharedWixHost(host), false, host);
});

test("syncs the directory profile and installation from the app instance, update-only", async (t) => {
  const writes = mockWrites(t);
  const { api, calls } = fakeApi(instanceResponse());
  const result = await syncWixSite(shop, api, now);
  assert.deepEqual(calls, [["GET", "/apps/v1/instance"]]);
  assert.deepEqual(result, { name: "Plant   Shop", primaryDomain: "www.plantshop.example", currencyCode: "USD" });

  assert.deepEqual(firstArg(writes.directoryUpdate), {
    where: { shop },
    data: {
      primaryDomain: "www.plantshop.example",
      name: "Plant   Shop",
      aliases: ["plant shop", "plant shop storefront"],
      formerAliases: {},
      verifiedAt: now,
    },
  });
  assert.deepEqual(firstArg(writes.installationUpdate), {
    where: { instanceId, shop },
    data: {
      permissions: ["WIX_STORES.READ_PRODUCTS", "ECOM.READ_ORDERS"],
      siteName: "Plant   Shop",
      siteUrl: "https://www.plantshop.example",
      currencyCode: "USD",
    },
  });
  // A sync never creates rows.
  assert.equal(writes.installation.mock.callCount(), 0);
  assert.equal(writes.directory.mock.callCount(), 0);
  assert.equal(writes.policy.mock.callCount(), 0);
});

test("a sync after the site was removed writes nothing and says so", async (t) => {
  const writes = mockWrites(t, null, { installed: 0 });
  await assert.rejects(syncWixSite(shop, fakeApi(instanceResponse()).api, now), WixSiteNotInstalled);
  assert.equal(writes.directoryUpdate.mock.callCount(), 0);
  assert.equal(writes.directory.mock.callCount(), 0);
  assert.equal(writes.installation.mock.callCount(), 0);
});

test("a sync leaves a missing directory row for provisioning to create", async (t) => {
  const writes = mockWrites(t, null, { directoryRows: 0 });
  const result = await syncWixSite(shop, fakeApi(instanceResponse()).api, now);
  assert.equal(result.name, "Plant   Shop");
  assert.equal(writes.directoryUpdate.mock.callCount(), 1);
  assert.equal(writes.directory.mock.callCount(), 0);
});

test("a custom domain held by another store falls back to the store key", async (t) => {
  const writes = mockWrites(t, null, { takenDomains: ["www.plantshop.example"] });
  const synced = await syncWixSite(shop, fakeApi(instanceResponse()).api, now);
  assert.equal(synced.primaryDomain, shop);
  assert.equal(firstArg(writes.directoryUpdate, 1).data?.primaryDomain, shop);

  const provisioned = await provisionWixSite(instanceId, fakeApi(instanceResponse()).api, now);
  assert.equal(provisioned.primaryDomain, shop);
  assert.equal(writes.installation.mock.callCount(), 1);
  assert.equal(firstArg(writes.directory, 1).create?.primaryDomain, shop);
  assert.equal(writes.policy.mock.callCount(), 1);
});

test("other directory failures are not mistaken for a taken domain", async (t) => {
  mockWrites(t, null, { directoryError: new Error("database unavailable") });
  await assert.rejects(syncWixSite(shop, fakeApi(instanceResponse()).api, now), /database unavailable/);
});

test("free Wix addresses and unpublished sites use the store key as primary domain", async (t) => {
  mockWrites(t);
  const free = await syncWixSite(shop, fakeApi(instanceResponse({ url: "https://jane.wixsite.com/plants" })).api, now);
  assert.equal(free.primaryDomain, shop);
  const unpublished = await syncWixSite(shop, fakeApi(instanceResponse({ url: undefined })).api, now);
  assert.equal(unpublished.primaryDomain, shop);
});

test("keeps a renamed site's former name searchable", async (t) => {
  const writes = mockWrites(t, {
    aliases: ["old name", "old name storefront"],
    formerAliases: {},
  });
  await syncWixSite(shop, fakeApi(instanceResponse()).api, now);
  const update = firstArg(writes.directoryUpdate).data as { aliases: string[]; formerAliases: Record<string, string> };
  assert.deepEqual(update.aliases, ["plant shop", "plant shop storefront", "old name", "old name storefront"]);
  assert.deepEqual(Object.keys(update.formerAliases), ["old name", "old name storefront"]);
});

test("refuses an instance Wix does not confirm, without writing", async (t) => {
  const writes = mockWrites(t);
  for (const response of [
    instanceResponse({}, { instanceId: "2b4f3c2a-9d8e-4f7a-8b6c-5d4e3f2a1b0c" }),
    instanceResponse({}, { instanceId: undefined }),
    {},
    instanceResponse({ siteDisplayName: " ", url: "https://jane.wixsite.com/x" }),
  ])
    await assert.rejects(syncWixSite(shop, fakeApi(response).api, now));
  assert.equal(writes.directoryUpdate.mock.callCount(), 0);
  assert.equal(writes.installationUpdate.mock.callCount(), 0);
  assert.equal(writes.directory.mock.callCount(), 0);
  assert.equal(writes.installation.mock.callCount(), 0);
});

test("an unusable currency is stored as unknown", async (t) => {
  mockWrites(t);
  const result = await syncWixSite(shop, fakeApi(instanceResponse({ paymentCurrency: "dollars" })).api, now);
  assert.equal(result.currencyCode, null);
});

test("provisioning creates the site, listed, with return rules off, and never overwrites choices", async (t) => {
  const writes = mockWrites(t);
  const result = await provisionWixSite(instanceId.toUpperCase(), fakeApi(instanceResponse()).api, now);
  assert.equal(result.shop, shop);
  assert.equal(result.primaryDomain, "www.plantshop.example");
  // Written one by one: nothing about the directory row can undo the install.
  assert.equal(writes.transaction.mock.callCount(), 0);
  const installation = {
    permissions: ["WIX_STORES.READ_PRODUCTS", "ECOM.READ_ORDERS"],
    siteName: "Plant   Shop",
    siteUrl: "https://www.plantshop.example",
    currencyCode: "USD",
  };
  assert.deepEqual(firstArg(writes.installation), {
    where: { instanceId },
    create: { instanceId, shop, ...installation },
    update: installation,
  });
  const directory = firstArg(writes.directory);
  assert.deepEqual(directory.where, { shop });
  assert.equal(directory.create?.shop, shop);
  assert.equal(directory.update?.primaryDomain, "www.plantshop.example");
  assert.equal("discoveryPublished" in (directory.update ?? {}), false);
  assert.equal("discoveryPublished" in (directory.create ?? {}), false);
  assert.deepEqual(writes.policy.mock.calls[0].arguments[0], {
    where: { shop },
    create: { shop, currencyCode: "USD", automaticRefundsEnabled: false },
    update: {},
  });
});

test("provisioning without a currency fails before creating return rules", async (t) => {
  const writes = mockWrites(t);
  await assert.rejects(
    provisionWixSite(instanceId, fakeApi(instanceResponse({ paymentCurrency: undefined })).api),
    /currency/,
  );
  assert.equal(writes.policy.mock.callCount(), 0);
  assert.equal(writes.installation.mock.callCount(), 0);
});

test("removal clears exactly what a Shopify uninstall clears, with the Wix installation for the session", async (t) => {
  const source = readFileSync(new URL("../../routes/webhooks.app.uninstalled.tsx", import.meta.url), "utf8");
  const shopifyTables = [...source.matchAll(/db\.(\w+)\.deleteMany\(/g)].map(([, table]) => table);
  assert.ok(shopifyTables.includes("session") && shopifyTables.length > 10);
  const expected = shopifyTables.map((table) => (table === "session" ? "wixInstallation" : table));

  const deleted: [string, unknown][] = [];
  for (const table of expected)
    mockDelegate(t, Reflect.get(prisma, table) as object, "deleteMany", async (args: unknown) => {
      deleted.push([table, args]);
      return { count: 0 };
    });
  const transaction = mockDelegate(t, prisma, "$transaction", async (ops: Promise<unknown>[]) => Promise.all(ops));

  await removeWixSite(shop);
  assert.equal(transaction.mock.callCount(), 1);
  assert.deepEqual(deleted.map(([table]) => table), expected);
  for (const [table, args] of deleted)
    assert.deepEqual(
      args,
      {
        where:
          table === "merchantOpportunity"
            ? { knownShop: shop }
            : table === "connectionEmail"
              ? { sourceShop: shop }
              : { shop },
      },
      table,
    );
  await assert.rejects(removeWixSite("example.myshopify.com"), /Not a Wix store/);
});
