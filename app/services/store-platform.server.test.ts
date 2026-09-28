import assert from "node:assert/strict";
import test from "node:test";
import prisma from "../db.server";
import {
  installedStores,
  isWixStore,
  normalizeStoreKey,
  platformOf,
  requireInstalledWixSite,
  storeInstallation,
  WIX_SCOPE_EQUIVALENTS,
  wixInstanceIdOf,
  wixScopeString,
  wixStoreKey,
} from "./store-platform.server";

const instanceId = "0f8a7c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const wixShop = `wix-${instanceId}`;

function mockDelegate(
  t: test.TestContext,
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

test("Wix store keys are built from the instance ID and never look like a domain", () => {
  assert.equal(wixStoreKey(instanceId.toUpperCase()), wixShop);
  assert.equal(wixInstanceIdOf(wixShop), instanceId);
  assert.equal(isWixStore(wixShop), true);
  assert.equal(isWixStore("wix-not-a-uuid"), false);
  assert.equal(isWixStore("testing.myshopify.com"), false);
  assert.equal(platformOf(wixShop), "wix");
  assert.equal(platformOf("testing.myshopify.com"), "shopify");
  assert.throws(() => wixStoreKey("../etc"));
  assert.throws(() => wixInstanceIdOf("testing.myshopify.com"));
});

test("store keys from either platform normalize, and anything else is refused", () => {
  assert.equal(normalizeStoreKey(` ${wixShop.toUpperCase()} `), wixShop);
  assert.equal(normalizeStoreKey("Testing.myshopify.com"), "testing.myshopify.com");
  assert.throws(() => normalizeStoreKey("testing.com"));
  assert.throws(() => normalizeStoreKey("wix-123"));
});

test("Wix permissions map onto the scope names shared code checks", () => {
  for (const permission of WIX_SCOPE_EQUIVALENTS.read_products)
    assert.equal(wixScopeString([permission.toLowerCase()]), "read_products");
  assert.equal(wixScopeString([]), "");
  assert.equal(wixScopeString(["SCOPE.UNRELATED"]), "");
});

test("installation checks read the right table for each platform", async (t) => {
  const session = mockDelegate(t, prisma.session, "findFirst", async () => ({
    id: "offline",
    scope: "read_orders",
  }));
  const wix = mockDelegate(t, prisma.wixInstallation, "findUnique", async () => ({
    permissions: [],
  }));
  assert.deepEqual(await storeInstallation("testing.myshopify.com"), {
    platform: "shopify",
    scope: "read_orders",
  });
  assert.deepEqual(await storeInstallation(wixShop), { platform: "wix", scope: "" });
  assert.equal(session.mock.callCount(), 1);
  assert.equal(wix.mock.callCount(), 1);
});

test("installedStores merges both platforms and skips queries it doesn't need", async (t) => {
  const sessions = mockDelegate(t, prisma.session, "findMany", async () => [
    { shop: "testing.myshopify.com", scope: "read_orders" },
  ]);
  const installs = mockDelegate(t, prisma.wixInstallation, "findMany", async () => [
    { shop: wixShop, permissions: [] },
  ]);
  const found = await installedStores(["testing.myshopify.com", wixShop, "gone.myshopify.com"]);
  assert.deepEqual([...found.keys()].sort(), [wixShop, "testing.myshopify.com"].sort());
  assert.equal((await installedStores([])).size, 0);
  assert.equal(sessions.mock.callCount(), 1);
  assert.equal(installs.mock.callCount(), 1);
});

test("a Wix store page 404s unless the site is installed", async (t) => {
  mockDelegate(t, prisma.wixInstallation, "findUnique", async () => null);
  await assert.rejects(
    () => requireInstalledWixSite(wixShop),
    (error: unknown) => error instanceof Response && error.status === 404,
  );
  await assert.rejects(
    () => requireInstalledWixSite("testing.myshopify.com"),
    (error: unknown) => error instanceof Response && error.status === 404,
  );
});
