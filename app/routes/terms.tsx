import type { MetaFunction } from "react-router";

import { PublicShell } from "../components/PublicShell";
import styles from "../styles/public.module.css";

export const meta: MetaFunction = () => [{ title: "Terms | Gooper.io" }];

export default function Terms() {
  return (
    <PublicShell>
      <main className={styles.legal}>
        <p className={styles.eyebrow}>Legal</p>
        <h1>Terms of service</h1>
        <p className={styles.updated}>Effective September 20, 2026</p>

        <p>
          These terms govern a merchant&apos;s use of Gooper.io, a Shopify app that
          can help authenticated customers complete eligible returns through
          compatible AI assistants.
        </p>

        <h2>Merchant authorization</h2>
        <p>
          By installing and enabling Gooper.io, the merchant authorizes the app to
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

        <h2>Data protection</h2>
        <p>
          This section governs personal data that Gooper.io processes on a
          merchant&apos;s behalf, and applies in addition to our privacy policy.
          For the personal data of the merchant&apos;s customers, the merchant is
          the controller and Gooper.io is the processor. Gooper.io processes that
          data only to provide the return and refund functionality the merchant
          has enabled, on the merchant&apos;s documented instructions, which are
          given through the app&apos;s settings and these terms. Gooper.io does not
          sell personal data, use it for advertising, or use it to train models.
        </p>
        <p>
          The data processed is limited to what the return flow requires:
          customer email addresses, a keyed hash of the customer identifier,
          order, line-item, return and refund records, and technical records
          needed for security and deduplication. Gooper.io does not request or
          store customer names, telephone numbers, or postal addresses.
          Processing continues for as long as the app is installed, and the
          categories of data subject are the merchant&apos;s customers who begin a
          return.
        </p>
        <p>
          Gooper.io engages the following sub-processors: Shopify, which hosts
          the underlying order and return records; our hosting and database
          provider; and our transactional email provider, which delivers return
          and store-link confirmations. We remain responsible for their
          performance of this section, and will give merchants notice of a
          change through the app or this page before a new sub-processor begins
          processing.
        </p>
        <p>
          Gooper.io maintains technical and organizational measures appropriate
          to the risk, including encryption of personal data in transit and at
          rest, storage of customer identifiers and credentials as hashes rather
          than plain values, access limited to personnel who require it,
          multi-factor authentication on accounts with production access, and
          defined retention periods after which records are deleted
          automatically.
        </p>
        <p>
          Gooper.io will notify the affected merchant without undue delay after
          becoming aware of a personal data breach affecting that
          merchant&apos;s customers, and will provide the information the
          merchant reasonably needs to meet its own notification obligations.
        </p>
        <p>
          Gooper.io supports Shopify&apos;s mandatory customer data request,
          customer redaction, and shop redaction webhooks, and will assist the
          merchant in responding to requests from data subjects and supervisory
          authorities. Personal data is deleted or returned when the app is
          uninstalled, except where law requires it to be retained. On
          reasonable request, Gooper.io will make available the information
          necessary to demonstrate compliance with this section.
        </p>

        <h2>Acceptable use</h2>
        <p>
          You may not use Gooper.io to violate law, infringe rights, bypass Shopify
          controls, access another customer&apos;s information, interfere with
          the service, or attempt fraudulent or duplicate refunds.
        </p>

        <h2>Shopify and third-party services</h2>
        <p>
          Gooper.io depends on Shopify, payment providers, AI-assistant hosts, and
          infrastructure services that we do not control. Their terms and
          privacy practices may also apply. Gooper.io is not endorsed by or part of
          Shopify.
        </p>

        <h2>Availability and changes</h2>
        <p>
          We may modify, suspend, or discontinue features and may update these
          terms. We aim to operate Gooper.io reliably, but the service is provided
          on an &quot;as is&quot; and &quot;as available&quot; basis to the
          extent permitted by law.
        </p>

        <h2>Disclaimers and liability</h2>
        <p>
          To the extent permitted by law, we disclaim implied warranties and are
          not liable for indirect, incidental, special, consequential, or
          punitive damages, lost profits, lost data, or third-party service
          failures. Any liability that cannot be excluded is limited to the
          amount the merchant paid for Gooper.io during the three months before the
          event giving rise to the claim.
        </p>

        <h2>Termination</h2>
        <p>
          A merchant may stop using Gooper.io by disabling its automation and
          uninstalling the app. We may suspend access for material breach,
          fraud, security risk, or legal necessity.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms can be sent through the support channel
          shown on the Gooper.io support page or Shopify App Store listing.
        </p>
      </main>
    </PublicShell>
  );
}
