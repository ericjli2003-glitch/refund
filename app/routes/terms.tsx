import type { MetaFunction } from "react-router";

import { PublicShell } from "../components/PublicShell";
import styles from "../styles/public.module.css";

export const meta: MetaFunction = () => [{ title: "Terms | Refund" }];

export default function Terms() {
  return (
    <PublicShell>
      <main className={styles.legal}>
        <p className={styles.eyebrow}>Legal</p>
        <h1>Terms of service</h1>
        <p className={styles.updated}>Effective September 3, 2026</p>

        <p>
          These terms govern a merchant&apos;s use of Refund, a Shopify app that
          can help authenticated customers complete eligible returns through
          compatible AI assistants.
        </p>

        <h2>Merchant authorization</h2>
        <p>
          By installing and enabling Refund, the merchant authorizes the app to
          use the Shopify permissions granted during installation and to submit
          returns and refunds that satisfy the merchant&apos;s configured policy
          after explicit customer confirmation. The merchant remains responsible
          for its return policy, customer communications, taxes, accounting, and
          compliance with applicable law.
        </p>

        <h2>Controls and review</h2>
        <p>
          Merchants can disable automatic refunds or change the return window
          and maximum automatic amount in the embedded app. Merchants should
          review activity and resolve records marked as needing attention.
        </p>

        <h2>Acceptable use</h2>
        <p>
          You may not use Refund to violate law, infringe rights, bypass Shopify
          controls, access another customer&apos;s information, interfere with
          the service, or attempt fraudulent or duplicate refunds.
        </p>

        <h2>Shopify and third-party services</h2>
        <p>
          Refund depends on Shopify, payment providers, AI-assistant hosts, and
          infrastructure services that we do not control. Their terms and
          privacy practices may also apply. Refund is not endorsed by or part of
          Shopify.
        </p>

        <h2>Availability and changes</h2>
        <p>
          We may modify, suspend, or discontinue features and may update these
          terms. We aim to operate Refund reliably, but the service is provided
          on an &quot;as is&quot; and &quot;as available&quot; basis to the
          extent permitted by law.
        </p>

        <h2>Disclaimers and liability</h2>
        <p>
          To the extent permitted by law, we disclaim implied warranties and are
          not liable for indirect, incidental, special, consequential, or
          punitive damages, lost profits, lost data, or third-party service
          failures. Any liability that cannot be excluded is limited to the
          amount the merchant paid for Refund during the three months before the
          event giving rise to the claim.
        </p>

        <h2>Termination</h2>
        <p>
          A merchant may stop using Refund by disabling its automation and
          uninstalling the app. We may suspend access for material breach,
          fraud, security risk, or legal necessity.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms can be sent through the support channel
          shown on the Refund support page or Shopify App Store listing.
        </p>
      </main>
    </PublicShell>
  );
}
