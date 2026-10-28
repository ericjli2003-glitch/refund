import assert from "node:assert/strict";
import test from "node:test";

import {
  planSelectionPath,
  planSelectionUrl,
  planStatusFrom,
} from "./app-plan.server";

const installation = (
  activeSubscriptions: Array<{ name: string; status: string; test?: boolean }>,
  handle: string | null = "gooper-io",
) => ({
  currentAppInstallation: {
    app: { handle },
    activeSubscriptions: activeSubscriptions.map((subscription) => ({
      test: false,
      trialDays: 60,
      currentPeriodEnd: null,
      ...subscription,
    })),
  },
});

test("a store with no subscription has no plan", () => {
  assert.deepEqual(planStatusFrom(installation([])), {
    appHandle: "gooper-io",
    plan: null,
  });
});

test("an active subscription is the store's plan, test charges included", () => {
  assert.deepEqual(
    planStatusFrom(
      installation([{ name: "Starter", status: "ACTIVE", test: true }]),
    ).plan,
    { name: "Starter", test: true, trialDays: 60, currentPeriodEnd: null },
  );
});

test("a subscription that isn't active doesn't count as a plan", () => {
  assert.equal(
    planStatusFrom(installation([{ name: "Growth", status: "PENDING" }])).plan,
    null,
  );
});

test("a missing app handle fails rather than linking to a broken page", () => {
  assert.throws(() => planStatusFrom(installation([], null)), /app handle/);
});

test("plan links open Shopify's hosted plan page for the store", () => {
  assert.equal(
    planSelectionPath("gooper-io"),
    "shopify://admin/charges/gooper-io/pricing_plans",
  );
  assert.equal(
    planSelectionUrl("testing-bl7vdfur.myshopify.com", "gooper-io"),
    "https://admin.shopify.com/store/testing-bl7vdfur/charges/gooper-io/pricing_plans",
  );
});
