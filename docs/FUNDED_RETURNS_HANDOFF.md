# Gooper-funded returns — implementation handoff

Updated September 17, 2026. This file is the entry point for continuing the work.

## User intent

Build Gooper's own instant-refund product. Gooper pays the customer from its own
funds first; the merchant reimburses Gooper only after physically receiving AND
explicitly approving the returned item. The user does not want to depend on a
Reshop API or spend more turns debating whether the concept is reasonable.

Continue concrete implementation. There is no live payout provider selected yet.
Do not activate real payouts/debits, alter live refund behavior or claim production
readiness. Don't invent customer debit authority, financing terms, fees or a loss
allocation, and don't automatically approve returns. Ask the user before
connecting a real provider (even its sandbox), deploying, or pushing.

Read AGENTS.md and docs/PROJECT_STATE.md before editing. This repository is nested
under a ChatGPT project mirror; its parent's sources/ directory is read-only.

## Current implementation

Two layers, both development-only and synthetic.

### 1. Durable merchant sandbox (case workflow)

- `app/funded-return-sandbox.ts`: pure, schema-validated workflow. Synthetic $50
  CAD/USD cases only; separate risk, payout, physical return, inspection and
  collection states. Money uses integer minor units. Successful payout moves
  simulated cash into funded exposure; approval moves only accepted principal
  into merchant receivables; settlement clears that receivable. Journal postings
  balance to zero per movement. This is not a complete accounting system.
  **New:** every payment request and outcome command carries a `payment` binding
  (`intentId`, `attempt`, `amountMinor`, `currency`). Requests must match the next
  attempt and the amount due (payout = funded amount, collection = approved
  principal only). Outcomes apply only to the case's current intent with the same
  attempt, amount and currency. Snapshots saved before intents still parse
  (`payoutIntentId`/`collectionIntentId` default to null) but can't take outcomes.
- `app/services/funded-return-sandbox.server.ts`: shop-scoped persistence. The
  shared `applyCaseCommand(transaction, …)` does version CAS inside a caller's
  transaction. `updateFundedSandbox` now **rejects** payment requests/outcomes:
  those only go through the payment service, so no screen can assert a result.
- `app/routes/app.funded-returns.tsx` + `app/components/funded-return-sandbox.tsx`:
  authenticated merchant screen. Manual "simulate paid/failed/timeout" buttons are
  gone. The merchant picks a fake-provider scenario, requests the payout/repayment,
  then uses **Deliver next provider webhooks**, **Replay delivered webhooks** and
  **Reconcile with provider now**. A table shows each intent's status, submissions,
  lookups, every matched event and any review reason.

### 2. Payment provider boundary (new)

- `app/funded-payment-matching.ts`: pure, provider-neutral matching of a
  `PaymentObservation` against an intent. Any intent/operation/amount/currency/
  reference mismatch → `MISMATCH` (REVIEW). First terminal result → `APPLIED`.
  Same result again → `ALREADY_APPLIED`. Opposite terminal result → `CONTRADICTION`.
  Reversal after success → `REVERSAL`. Outcome for a never-submitted intent →
  `CONTRADICTION`. Anything on a REVIEW intent → `HELD_FOR_REVIEW`. Only `APPLIED`
  touches the case; nothing else moves balances.
- `app/services/funded-payment-provider.server.ts`: `FundedPaymentProvider`
  interface (`submit`, `lookup`, `verifyEvent`). The type allows only
  `environment: "SANDBOX"` and requires `idempotentSubmit: true`. Also HMAC-SHA256
  `t=…,v1=…` signing/verification over exact raw bytes with 300s tolerance and
  timing-safe compare, strict event parsing, and `derivedId` (stable UUIDv5-shaped
  IDs so replays yield identical case commands).
- `app/services/funded-sandbox-provider.server.ts`: fake adapter `gooper-sandbox`.
  No credentials, no network. Its own table (`FundedSandboxProviderPayment`) is the
  "remote side", deduplicated by idempotency key. Scenarios: `SUCCEED`, `FAIL`,
  `TIMEOUT_AFTER_ACCEPT`, `LOST_BEFORE_ACCEPT`, `SUCCEED_THEN_REVERSE`,
  `FAIL_THEN_LATE_SUCCESS`, `WRONG_AMOUNT_EVENT`. Events are signed at delivery
  time with `GOOPER_FUNDED_SANDBOX_PROVIDER_SECRET` or a random per-process secret.
- `app/services/funded-payment-intents.server.ts`:
  - `fundedPaymentProvider()`: the only resolver. Sandbox gate required; no live
    branch, credential lookup or environment switch.
  - `requestSandboxPayment`: in ONE transaction applies `REQUEST_*` to the case
    and creates a `QUEUED` `FundedPaymentIntent` (outbox). The intent ID is derived
    from the command ID, so a retried POST is a no-op. It never calls a provider.
    A `REVIEW` intent blocks new requests of the same operation for that case.
  - `dispatchPaymentIntents`: claims `QUEUED` → `SUBMITTING` with a version CAS
    and a 60s lease, then calls the provider **after** commit. `ACCEPTED` → recorded
    observation; `REJECTED` (provider confirms nothing was created) → `FAILED`;
    timeout/throw → `UNKNOWN` plus case `*_UNKNOWN`.
  - `ingestProviderEvent`: verify signature → `recordObservation`.
  - `recordObservation`: one transaction inserts a `FundedPaymentEvent` keyed by
    (provider, providerEventId) and updates intent + case. A duplicate insert returns
    `DUPLICATE`, so concurrent or replayed deliveries apply once. If the case workflow
    refuses a matched outcome → `CASE_REJECTED` and REVIEW. Unknown intent IDs →
    `UNMATCHED`.
  - `reconcilePaymentIntents`: expired `SUBMITTING` leases (crash) → `UNKNOWN`.
    Due `PENDING`/`UNKNOWN` intents are **looked up** with backoff. FOUND →
    observation. NOT_FOUND for an unacknowledged `UNKNOWN` → resubmit with the
    **same idempotency key**, capped at 5 submissions. NOT_FOUND for an accepted
    payment, or once the cap is reached → REVIEW. It never creates a new attempt
    or key. REVIEW intents are never looked up again.
- `app/routes/webhooks.funded-sandbox-provider.tsx`: dev-only callback endpoint
  (404 outside the sandbox gate, 16KB cap, raw-body signature, 400 on rejection).
- Prisma models `FundedPaymentIntent` (with `version` CAS column), `FundedPaymentEvent`,
  `FundedSandboxProviderPayment`; migration `20260917090000_funded_payment_intents`.
  SQL CHECK constraints: `environment = 'SANDBOX'` (a LIVE update is refused by
  PostgreSQL), operation/status/currency enums, positive amount/attempt.
- Uninstall and shop redaction also delete these three tables' rows for the shop.
- Tests: `app/funded-payments.test.ts` (matching, signatures, derived IDs, provider
  and webhook-route lockout) and `tests/funded-payment-intents.integration.ts`.
  Both integration files run under `npm run test:funded-sandbox` (already in CI).

In this sandbox the route dispatches inline right after the intent commits. A
production design would run dispatch/reconcile in a worker on a schedule. None
exists, deliberately.

## How to open the sandbox

1. Use an isolated local PostgreSQL database. Apply migrations there
   (`npx prisma migrate deploy`); never point these commands at production.
   Locally: `brew install postgresql@16`, `initdb` a throwaway cluster, then
   `createdb refund_ci`. Run it on 127.0.0.1:5432 with user/password `refund`,
   matching CI. Set `LC_ALL=en_US.UTF-8` for `pg_ctl`.
2. Set `GOOPER_FUNDED_RETURNS_SANDBOX=1` in the local development environment.
3. Run `shopify app dev --config shopify.app.toml --store <dev store>` with
   `DATABASE_URL` pointing at the local database. **Caution:** `shopify.app.toml` is
   the only app config (`application_url = https://gooper.io`,
   `automatically_update_urls_on_dev = true`). Running dev points the app's URLs at
   a tunnel for every store that has it installed. As of 2026-09-17 the user says
   only their two dev stores have it. Restore the URLs afterwards (see the note after step 5).
4. Open **Funded returns sandbox** from the Refunds dashboard, or `/app/funded-returns`.
5. Start a sample, approve risk, choose a provider scenario and send the payout.
   Deliver webhooks or reconcile. Mark received, inspect (full/partial/zero), then
   request repayment the same way. Try every scenario and **Replay delivered webhooks**.

After testing, stop dev with Ctrl+C. If the app's URLs in the Shopify Dev Dashboard
still point at a trycloudflare.com tunnel, restoring `https://gooper.io` needs
`npm run deploy` (it releases a new app version), so ask the user first.

The flag is off by default. Every service and route requires `NODE_ENV=development`
or `test` AND the flag; production returns 404 even with the flag set.

## Verification at handoff (2026-09-17)

- PostgreSQL 16.15 (local throwaway cluster, `refund_ci`): all migrations applied,
  including both funded migrations. `prisma migrate diff` shows no drift.
- `npm run test:funded-sandbox`: **both pass**. Coverage: the original lifecycle,
  store isolation, idempotency, stale-version and concurrent payout requests (one
  intent), and production lockout. Plus webhook settlement, replay → `DUPLICATE`,
  and tampered/unsigned/wrong-secret/expired signatures rejected. Plus
  timeout-after-accept reconciled by lookup with no second payment, and a lost
  request resubmitted with the same key (one provider payment). Plus crash recovery
  from an expired lease, and a failed attempt 1 whose late success is a
  `CONTRADICTION` that never pays attempt 2. A payout hold doesn't block repayment
  of approved principal. Also: wrong-amount webhook → REVIEW and blocks new payouts;
  reversal → REVIEW with unchanged balances; three concurrent dispatchers → one
  submission; four concurrent identical webhooks → one `APPLIED`; forged unknown
  intent → `UNMATCHED`; cross-store isolation; production lockout; and a DB-refused
  `LIVE` environment.
- Mutation check: disabling amount matching, or varying the idempotency key per
  submission, each makes the integration test fail.
- `npm test`: **151 passed, 0 failed**. The previously failing
  `customer-bridge.server.test.ts` assertion was stale wording from commit 04c766f.
  The quote still requires one "Want me to go ahead?" question, calls
  `confirm_return` only "After a clear yes" and says "Ask nothing else". The test
  now asserts those exact guarantees plus `needsConfirmation === true`. Copy unchanged.
- `node scripts/test-grant-cascade.mjs`, `npm run test:oauth` (11), and the
  storefront config test pass. `npm run prisma:validate`, `npm run typecheck`,
  `npm run lint`, and `npm run build` pass.
- View rendering: the real `FundedReturnsSandboxView` was rendered with fixture data
  and Polaris web components in a local static harness, at 900px and narrow widths.
  Verified: sections, review banner, status badges, intent/event table, ledger and
  journal labels; case-select `change` updates the view; button clicks submit the
  right `intent`/`id`/`version`/`actionId`; action availability (e.g. only inspection
  enabled after receipt). No console errors.
- **Embedded admin, verified 2026-09-17** on the dev store
  `testing-bl7vdfur.myshopify.com` via `shopify app dev` (user-approved, no real
  merchants on the app), with the local PostgreSQL database. Flow: new CAD sample
  → approve risk → payout ("Succeeds") → the intent was QUEUED, submitted once and
  left PENDING → signed webhook delivered → payout SUCCEEDED, cash −CA$50,
  exposure CA$50, collection still NOT_DUE. Replay → `DUPLICATE`, case version
  unchanged. Mark received (collection still NOT_DUE) → partial approval 25.00 →
  CA$25 still at risk, collection DUE → repayment intent for 2500 only → webhook →
  SETTLED. A full page reload showed the same persisted state. Database checks:
  2 SANDBOX intents with 1 submission each, 4 events (2 RECORDED, 2 APPLIED), and 0
  `AgentReturn` rows. The session was authenticated, and the route's own Origin
  check passed.
  Not exercised in the admin: timeout/lost/reversal/contradiction/wrong-amount
  scenarios, and the other store. A keyboard can't drive the native select inside
  the cross-origin app frame. Those paths are covered by the PostgreSQL
  integration tests.
- Two dev-environment problems found and fixed during that run:
  1. `react-router.config.ts` `allowedActionOrigins` rejected every admin form
     action under `shopify app dev` with 400 "Bad Request". The browser Origin is
     the tunnel while the server sees localhost. Development now also allows the
     app's own `SHOPIFY_APP_URL`/`HOST` host. Checked: production and test lists
     are unchanged (`gooper.io`, `refund-ztxz.onrender.com`). This affected all
     admin actions in local dev, not only the sandbox. Production is unaffected.
  2. A stray Yarn PnP manifest in the user's home directory (`~/.pnp.cjs`, 2023)
     broke Vite dependency optimisation for any project under `~`. Renamed to
     `~/.pnp.cjs.bak` and `~/.pnp.loader.mjs.bak` with the user's approval.
     Machine-specific; not a repo change.
- Browser automation note: Claude in Chrome mouse clicks don't reach the
  cross-origin embedded app iframe. Focusing the iframe and using Tab/Enter works.
- No commit, push, deploy, real provider connection, payment, email or other
  external write was performed. The pre-existing untracked
  `docs/GOOPER_FUNDED_REFUNDS_VALIDATION.md` is preserved.

## Next implementation steps, in order

1. Embedded happy path is verified (above). Still open: the non-default provider
   scenarios and a second store in the admin, plus route-level tests for the admin
   action's auth/origin. Those tests need an `authenticate.admin` seam or mock.
2. Review resolution: REVIEW intents currently have no resolution path. Design an
   explicit, audited operator action (who may resolve, with what evidence). Never
   auto-resolve, auto-write-off or auto-approve.
3. Reversal accounting: a reversal is recorded but balances don't change. Define
   ledger entries for payout reversal after approval and collection reversal after
   settlement once the funding agreement says who bears them.
4. Scheduled worker for `dispatchPaymentIntents`/`reconcilePaymentIntents` with
   alerting on REVIEW and on aged UNKNOWN intents. Add metrics for
   submission/lookup counts.
5. Exposure controls in synthetic tests: merchant/customer/portfolio caps,
   insufficient capital, non-return and dispute review. Rejected amounts still
   remain exposed; no customer recovery or automatic write-off exists.
6. Define the funding agreement and settlement relationship before attaching real
   orders. A separate funded entitlement must prevent overlap with the
   original-processor refund engine, including externally initiated refunds and
   partial quantities. Existing code does NOT solve live double-payment risk.
7. After the user selects a provider/use case, write a real adapter against its
   **sandbox** only, implementing the same interface. Map its idempotency, lookup,
   webhook signature and reversal semantics, and prove them with the same
   integration scenarios. A live environment needs a new migration relaxing the
   CHECK constraint, separate credentials and explicit user approval. Keep explicit
   receipt + inspection approval as the only repayment trigger, with no timed
   auto-accept.

## Competitor evidence behind this direction

Reshop's customer terms describe buying the customer's refund receivable and
receiving the merchant's payment. They also allow recovery from a customer for
noncompliance/disputes; “risk-free for merchants” is not “no customer recourse.”
Refundid's US terms use assigned merchant return rights; its Australian terms use
a loan structure. Reveni separately tracks instant payouts and later inspection.

- https://www.reshop.com/terms-of-service
- https://help.retailer.reshop.com/hc/en-us/articles/11784559486863-How-does-Reshop-Work-With-Shopify
- https://help.loopreturns.com/en/articles/8080769
- https://refundid.com/us/terms-and-conditions
- https://refundid.com/au/terms-and-conditions
- https://reveni.helpjuice.com/en_US/merchant-onboarding/merchant-onboarding-entendiendo-la-operativa

These validate that the product category exists, not that Gooper inherits their
contracts or platform arrangements. Resolve production requirements alongside
engineering; they are not a reason to stop building the isolated sandbox.
