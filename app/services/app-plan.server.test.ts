import assert from "node:assert/strict";
import test from "node:test";

import {
  planSelectionPath,
  planSelectionUrl,
  planStatusFrom,
} from "./app-plan.server";

const installation = (
  activeSubscriptions: Array<{
    name: string;
    status: string;
    test?: boolean;
    lineItems?: Array<{
      plan: {
        pricingDetails: { __typename: string; price?: { amount: string } };
      };
    }>;
  }>,
  handle: string | null = "gooper-io",
  partnerDevelopment = false,
) => ({
  shop: { plan: { partnerDevelopment } },
  currentAppInstallation: {
    app: { handle },
    activeSubscriptions: activeSubscriptions.map((subscription) => ({
      test: false,
      trialDays: 60,
      currentPeriodEnd: null,
      lineItems: [],
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
    {
      name: "Starter",
      test: true,
      freeDevelopmentTest: false,
      trialDays: 60,
      currentPeriodEnd: null,
    },
  );
});

const recurring = (amount: string) => ({
  plan: {
    pricingDetails: { __typename: "AppRecurringPricing", price: { amount } },
  },
});

test("a $0 development subscription is free to test without the legacy flag", () => {
  const plan = planStatusFrom(
    installation(
      [{ name: "Growth", status: "ACTIVE", lineItems: [recurring("0.00")] }],
      "gooper-io",
      true,
    ),
  ).plan;
  assert.equal(plan?.test, false);
  assert.equal(plan?.freeDevelopmentTest, true);
});

test("free testing requires a development store and known zero recurring prices", () => {
  for (const [partnerDevelopment, lineItems] of [
    [false, [recurring("0.00")]],
    [true, [recurring("49.00")]],
    [true, [recurring("0.00"), recurring("49.00")]],
    [true, []],
    [true, [{ plan: { pricingDetails: { __typename: "AppUsagePricing" } } }]],
    [true, [recurring("invalid")]],
  ] as const) {
    assert.equal(
      planStatusFrom(
        installation(
          [{ name: "Starter", status: "ACTIVE", lineItems: [...lineItems] }],
          "gooper-io",
          partnerDevelopment,
        ),
      ).plan?.freeDevelopmentTest,
      false,
    );
  }
});

test("development stores still need an active subscription", () => {
  assert.equal(planStatusFrom(installation([], "gooper-io", true)).plan, null);
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
