import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

import { PublicShell } from "../components/PublicShell";
import styles from "../styles/public.module.css";

export const meta: MetaFunction = () => [{ title: "Support | Refund" }];

export const loader = async () => {
  const configured = process.env.PUBLIC_SUPPORT_EMAIL?.trim() ?? "";
  const supportEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured)
    ? configured
    : null;

  return { supportEmail };
};

export default function Support() {
  const { supportEmail } = useLoaderData<typeof loader>();

  return (
    <PublicShell>
      <main className={styles.legal}>
        <p className={styles.eyebrow}>Help</p>
        <h1>Support</h1>
        <p className={styles.updated}>
          Help with setup, return activity, and account questions.
        </p>

        <div className={styles.callout}>
          {supportEmail ? (
            <p>
              Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
              Include your <code>.myshopify.com</code> domain and the return
              status shown in Refund. Do not include payment-card information or
              customer access tokens.
            </p>
          ) : (
            <p>
              Contact Refund through the support link on its Shopify App Store
              listing. Include your <code>.myshopify.com</code> domain and the
              return status shown in the app.
            </p>
          )}
        </div>

        <h2>Before contacting support</h2>
        <ul>
          <li>Check that automatic refunds are enabled for the shop.</li>
          <li>
            Check the configured return window and maximum automatic amount.
          </li>
          <li>
            Open the Activity section and note whether the attempt is complete,
            failed, or needs attention.
          </li>
          <li>
            For customer-account access issues, confirm customer accounts are
            active in Shopify and the customer signed in to the correct shop.
          </li>
        </ul>

        <h2>Refund timing</h2>
        <p>
          Refund submits eligible refunds to Shopify&apos;s original payment
          transaction. Bank posting time depends on the payment provider and is
          not controlled by Refund.
        </p>

        <h2>Privacy requests</h2>
        <p>
          Customers should contact the merchant where they placed the order.
          Shopify then sends the appropriate data request or deletion event to
          installed apps.
        </p>
      </main>
    </PublicShell>
  );
}
