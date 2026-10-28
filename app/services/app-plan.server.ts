import { adminData, type AdminGraphql } from "./shopify-admin.server";

// Gooper.io charges through Shopify App Pricing (App Store requirement 1.2.1).
// The plans live in the Partner Dashboard and Shopify hosts the page where a
// merchant picks, upgrades or downgrades one, so Gooper.io never creates a
// charge itself: it only reads the store's subscription and sends merchants
// without one to that page.

export type AppPlan = {
  name: string;
  test: boolean;
  trialDays: number;
  currentPeriodEnd: string | null;
};

export type PlanStatus = {
  appHandle: string;
  plan: AppPlan | null;
};

type AppPlanData = {
  currentAppInstallation: {
    app: { handle: string | null };
    activeSubscriptions: Array<{
      name: string;
      status: string;
      test: boolean;
      trialDays: number;
      currentPeriodEnd: string | null;
    }>;
  };
};

const APP_PLAN_QUERY = `#graphql
  query AppPlan {
    currentAppInstallation {
      app { handle }
      activeSubscriptions {
        name
        status
        test
        trialDays
        currentPeriodEnd
      }
    }
  }`;

export function planStatusFrom(data: AppPlanData): PlanStatus {
  const appHandle = data.currentAppInstallation.app.handle;
  if (!appHandle)
    throw new Error("Shopify did not return Gooper.io's app handle.");
  const active = data.currentAppInstallation.activeSubscriptions.find(
    (subscription) => subscription.status === "ACTIVE",
  );
  return {
    appHandle,
    plan: active
      ? {
          name: active.name,
          test: active.test,
          trialDays: active.trialDays,
          currentPeriodEnd: active.currentPeriodEnd,
        }
      : null,
  };
}

export async function planStatus(admin: AdminGraphql) {
  return planStatusFrom(
    await adminData<AppPlanData>(
      admin,
      APP_PLAN_QUERY,
      {},
      "Shopify did not return Gooper.io's plan.",
    ),
  );
}

// Shopify's hosted plan selection page, for the `redirect` helper from
// `authenticate.admin`, which expands `shopify://admin` to this store's admin.
export const planSelectionPath = (appHandle: string) =>
  `shopify://admin/charges/${encodeURIComponent(appHandle)}/pricing_plans`;

// The same page as a plain URL, for a link the merchant clicks.
export const planSelectionUrl = (shop: string, appHandle: string) =>
  `https://admin.shopify.com/store/${encodeURIComponent(
    shop.replace(/\.myshopify\.com$/, ""),
  )}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
