import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";

import { PublicShell } from "../../components/PublicShell";
import { login } from "../../shopify.server";
import publicStyles from "../../styles/public.module.css";

import styles from "./styles.module.css";

export const meta: MetaFunction = () => [
  { title: "Gooper.io | Customer-confirmed Shopify returns" },
  {
    name: "description",
    content:
      "Let customers complete eligible Shopify returns inside compatible AI assistants, in one request and within merchant-controlled limits.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();

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
              <span>Returns in one request</span>
              <span>Original payment method</span>
              <span>Idempotent execution</span>
            </div>
          </div>

          {showForm && (
            <div className={styles.installCard}>
              <p className={publicStyles.eyebrow}>Merchant access</p>
              <h2>Open Gooper.io</h2>
              <p>Install Gooper.io to get your return portal. Your store identity and currency are set up automatically.</p>
              <Form className={styles.form} method="post" action="/auth/login">
                <label className={styles.label}>
                  <span>Shop domain</span>
                  <input
                    className={styles.input}
                    type="text"
                    name="shop"
                    inputMode="url"
                    autoComplete="url"
                    placeholder="your-store.myshopify.com"
                    required
                  />
                </label>
                <button className={styles.button} type="submit">
                  Continue to Shopify
                </button>
              </Form>
              <p className={styles.finePrint}>
                Shopify handles installation. No separate Gooper.io account is needed. Adding tools to your storefront is optional and requires one theme activation.
              </p>
            </div>
          )}
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
              <h3>Ask only when it matters</h3>
              <p>
                A return goes ahead when the customer asks for it. If a fee would
                come out of the refund, the customer agrees to it first. Duplicate
                requests do not refund twice.
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
