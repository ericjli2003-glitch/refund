import type { MetaFunction } from "react-router";

import { PublicShell } from "../components/PublicShell";
import styles from "../styles/public.module.css";

export const meta: MetaFunction = () => [{ title: "Privacy | Refund" }];

export default function Privacy() {
  return (
    <PublicShell>
      <main className={styles.legal}>
        <p className={styles.eyebrow}>Legal</p>
        <h1>Privacy policy</h1>
        <p className={styles.updated}>Effective September 3, 2026</p>

        <p>
          Refund helps Shopify merchants offer customer-confirmed returns
          through compatible AI assistants. This policy explains the data the
          app uses to provide that service.
        </p>

        <h2>Information we process</h2>
        <ul>
          <li>
            Merchant account and shop information, including the shop domain,
            Shopify session, access scopes, and configured return policy.
          </li>
          <li>
            Return records, including Shopify order, line-item, return, and
            refund identifiers, quantities, status, amount, currency, and
            timestamps.
          </li>
          <li>
            A keyed hash of the customer identifier. Refund does not store the
            raw customer identifier in its operational return records.
          </li>
          <li>
            Technical records needed for security, webhook deduplication,
            idempotency, troubleshooting, and compliance requests.
          </li>
        </ul>

        <h2>How we use information</h2>
        <p>
          We use this information to authenticate shops and customers, determine
          return eligibility, calculate and submit confirmed returns, reconcile
          Shopify status updates, prevent duplicate refunds, support merchants,
          protect the service, and meet legal obligations.
        </p>

        <h2>Customer authentication and payments</h2>
        <p>
          Customer Account access tokens are used to validate the request and
          read the authenticated customer&apos;s eligible order information.
          They are not stored in Refund&apos;s return records. Refund does not
          collect debit or credit card numbers. Shopify and the merchant&apos;s
          payment provider process refunds to the original payment method.
        </p>
        <p>
          The customer return portal stores access tokens encrypted in a separate,
          short-lived session. The browser receives an opaque, HttpOnly session
          cookie, not the token. Portal sessions expire within four hours and are
          removed on sign-out, expiry cleanup, applicable redaction requests, or
          app uninstall.
        </p>

        <h2>Sharing and service providers</h2>
        <p>
          Information is shared with Shopify when needed to operate the app. We
          may use infrastructure providers to host the app and database. We do
          not sell personal information or use it for cross-context behavioral
          advertising.
        </p>

        <h2>Retention and deletion</h2>
        <p>
          We retain records only as long as needed to operate, secure, and
          support the service or meet legal obligations. Refund processes
          Shopify&apos;s mandatory customer data request, customer redaction,
          and shop redaction webhooks. Local shop data is also deleted when the
          app receives an uninstall webhook.
        </p>

        <h2>Security</h2>
        <p>
          We use access controls, signed webhook verification, scoped Shopify
          permissions, hashed customer references, and idempotency controls. No
          system is completely secure, and we cannot guarantee absolute
          security.
        </p>

        <h2>Your choices</h2>
        <p>
          Customers can contact the Shopify merchant where they placed their
          order to request access, correction, or deletion. Merchants can
          uninstall the app and can contact us through the support channel shown
          on the Refund support page or Shopify App Store listing.
        </p>

        <h2>Changes</h2>
        <p>
          We may update this policy as the service or legal requirements change.
          An updated effective date will appear at the top of this page.
        </p>
      </main>
    </PublicShell>
  );
}
