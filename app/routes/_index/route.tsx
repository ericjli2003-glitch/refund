import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";

import { APP_STORE_URL } from "../../app-store";
import { PublicShell } from "../../components/PublicShell";
import publicStyles from "../../styles/public.module.css";

import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "Gooper.io | Customer-confirmed Shopify returns" },
  {
    name: "description",
    content:
      "Let customers complete eligible Shopify returns inside compatible AI assistants, with explicit confirmation and merchant-controlled limits.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function Index() {
  return (
    <PublicShell>
      <main>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={publicStyles.eyebrow}>
              Returns that respect the customer
            </p>
            <h1>Customer-confirmed Shopify returns, inside AI assistants.</h1>
            <p className={styles.lede}>
              Gooper.io lets a verified customer return eligible items in one
              request, using Shopify&apos;s calculated amount. You set the return
              window and refund limit.
            </p>
            <div className={styles.trustLine}>
              <span>Explicit confirmation</span>
              <span>Original payment method</span>
              <span>Idempotent execution</span>
            </div>
          </div>

          <div className={styles.installCard}>
            <p className={publicStyles.eyebrow}>Merchant access</p>
            <h2>Open Gooper.io</h2>
            <p>Install Gooper.io to get your return portal. Your store identity and currency are set up automatically.</p>
            <a className={styles.button} href={APP_STORE_URL}>
              Install from the Shopify App Store
            </a>
            <p className={styles.finePrint}>
              Shopify handles installation. No separate Gooper.io account is needed. Adding tools to your storefront is optional and requires one theme activation.
            </p>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="how-it-works">
          <div className={styles.sectionHeading}>
            <div>
              <p className={publicStyles.eyebrow}>How it works</p>
              <h2 id="how-it-works">Guardrails before automation.</h2>
            </div>
          </div>
          <div className={styles.cardGrid}>
            <article className={styles.featureCard}>
              <span className={styles.step}>01</span>
              <h3>Verify the customer</h3>
              <p>
                Shopify Customer Account authentication limits the assistant to
                that customer&apos;s orders and returnable items.
              </p>
            </article>
            <article className={styles.featureCard}>
              <span className={styles.step}>02</span>
              <h3>Recalculate the quote</h3>
              <p>
                Gooper.io rechecks item eligibility, quantities, store policy, and
                Shopify&apos;s latest suggested amount.
              </p>
            </article>
            <article className={styles.featureCard}>
              <span className={styles.step}>03</span>
              <h3>Require confirmation</h3>
              <p>
                Nothing is submitted until the customer confirms the exact items
                and refund amount, even across several orders. Duplicate requests
                do not refund twice.
              </p>
            </article>
          </div>
        </section>

        <section className={styles.controlPanel}>
          <div>
            <p className={publicStyles.eyebrow}>Merchant controls</p>
            <h2>You decide what can run automatically.</h2>
          </div>
          <ul>
            <li>Master enable switch</li>
            <li>Return-window limit</li>
            <li>Maximum automatic refund amount</li>
            <li>Return and refund status reconciliation</li>
          </ul>
        </section>
      </main>
    </PublicShell>
  );
}
