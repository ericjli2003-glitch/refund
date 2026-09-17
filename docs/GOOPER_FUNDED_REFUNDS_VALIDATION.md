# Gooper-funded refunds: validation and launch package

Prepared September 16, 2026. Planning document, not platform approval, legal advice,
or an authorization to move money. Canada and the US are research targets; the
first launch market, legal entity and payout provider still need to be selected.
No outreach has been sent and no production refund behavior has been changed.

## 1. The product we are validating

Gooper pays an eligible customer from Gooper's own funds before the physical return.
The merchant reimburses Gooper only after receiving and approving the returned item.
Gooper bears the agreed return risk during that interval. This is different from
initiating an ordinary merchant-funded refund sooner.

Example, excluding taxes and fees for simplicity:

1. Customer requests a $100 return; Gooper approves eligibility and risk.
2. Gooper funds a $100 payout through its approved payment partner.
3. The partner confirms the payout outcome; the customer ships the item back.
4. Merchant records receipt and explicitly approves the item.
5. Merchant owes Gooper the agreed $100 reimbursement, plus any separately agreed fee.
6. Authorized collection occurs; Gooper reconciles settlement and any reversals.

Receipt, inspection approval, reimbursement becoming due, and money settling are
four distinct events. A carrier delivery scan alone must not trigger collection.
Before approval, Gooper has funded exposure, not an unconditionally collectible
merchant debt. Accounting treatment needs an accountant's review.

The customer must not also receive a second original-payment refund for the same
amount. Exactly how the original sale, return, taxes and refund entitlement are
recorded and discharged in Shopify is a launch-blocking question, not a solved API
detail. Gooper cannot assume it can redirect a customer's card refund to itself.

## 2. Actions in priority order

| Order | Action | Concrete deliverable / completion condition |
| --- | --- | --- |
| 1 | Submit the Shopify message below through Partner support. | Case number and written determination covering the actual funds flow and permitted distribution. Ask for escalation to the team responsible for app/payment policy. |
| 2 | Send the partner brief to TabaPay, Adyen, and a Canadian business-banking contact. | Written use-case eligibility, country coverage, onboarding requirements, fees, reserves and a sandbox route. Run these conversations alongside Shopify. |
| 3 | Engage payments/fintech counsel with this same brief. | A scoped legal assessment for the first market and the exact contracts; not merely advice to “use a licensed provider.” |
| 4 | Interview 2–3 potential pilot merchants. | Return volumes, average amounts, approval delays, rejection rates, current payment processors and willingness to reimburse only after approval. No live payouts yet. |
| 5 | Choose one domestic market/currency and one approved payment route. | Signed partner terms, reviewed merchant/customer terms, committed Gooper funding and an agreed loss budget. Research both markets; avoid a simultaneous cross-border first pilot. |
| 6 | Build and test a sandbox-only funded-return flow. | All failure scenarios below pass; reconciliation and operational controls work. |
| 7 | Run a limited live pilot after all gates are met. | Named merchants, customer/merchant exposure caps, daily reconciliation and a kill switch. Expand only on measured results. |

These are milestones, not promises about approval timelines.

## 3. Shopify: resolve permission before implementation

Current App Store requirements restrict off-original-processor refunds (§1.1.15),
capital-funding apps (§1.1.16), and off-platform app charges (§1.2). Those create a
material conflict with the proposed model. The precise classification and any
permitted route require Shopify's written determination. A custom/private
integration is not an assumed exemption, and renaming a payout an “advance” does
not settle the issue. [Shopify App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)

Contact path: sign in to Shopify Help Center, select your **Partner organization**,
then **Chat with us**. Request a written response and retain the case number.
[Shopify Partner support instructions](https://help.shopify.com/en/partners/help-support/getting-support)

### Message to Shopify — ready to paste

Subject: Written policy determination requested: Gooper-funded customer return payouts

Hello Shopify Partner Support,

I'm building Gooper, a Shopify returns integration. Before implementing a new
money flow, I need a written determination from the team responsible for app and
payment policy.

Our existing integration processes ordinary refunds through the original payment
processor. The proposed model is different:

- Gooper pays an eligible customer using Gooper's own capital before the item is returned.
- The merchant reimburses Gooper only after physically receiving and approving the item.
- Gooper assumes the agreed non-return/rejection risk; the detailed allocation is still being designed.
- We are investigating Canada and the US and have not enabled this flow in production.

We have reviewed requirements 1.1.15, 1.1.16 and 1.2. Could you please confirm:

1. Is this exact model permitted on Shopify, and through which distribution or partner program, if any?
2. Does it fall within the refund restriction, the capital-funding restriction, or both?
3. What approved workflow can record the return and its financial/tax outcome without paying the customer twice? We are not assuming that an original-tender refund can be redirected to Gooper.
4. How must merchant principal reimbursement and Gooper's service fee be handled? Please distinguish reimbursement from app charges.
5. Would involving an approved payment provider change the determination, and what additional approval would be required?

Please do not treat this as a request merely to accelerate a standard Shopify
refund. We need approval of the separate Gooper-funded payment and later merchant
reimbursement. If this is prohibited, please confirm that explicitly before we
invest in implementation.

Thank you,
Eric — Gooper

### What counts as a useful answer

An answer referring to this exact flow, identifying the relevant policies and
permitted distribution, plus a documented financial-recording route. An AI chat
answer, generic API success, or a provider's willingness to send money is not
Shopify approval. If Shopify says no, pause this Shopify-linked product and assess
a different approved structure or non-Shopify market; do not route around review.

## 4. Payment-partner shortlist

These are candidates for an underwriting conversation, not endorsements or
confirmation that they accept Gooper's business model.

| Candidate | Why contact them | What remains unconfirmed |
| --- | --- | --- |
| **TabaPay — first discovery call** | Its documentation describes push payouts and supports businesses with legal addresses in the US and Canada. [Overview](https://developers.tabapay.com/docs/learn-more), [sales contact](https://tabapay.com/contact) | Exact domestic CAD/USD recipient coverage, startup minimums, sponsor requirements, Gooper-funded return eligibility, collection support and loss allocation. Business eligibility is not proof of every payout route. |
| **Adyen — parallel comparison** | Its current third-party card payout documentation supports US domestic USD payouts. [Technical coverage](https://docs.adyen.com/payouts/payout-service/pay-out-to-cards), [sales contact](https://www.adyen.com/contact/sales) | Canada is not in that specific API's coverage table. Its broader CashOut marketing mentions Canada, but that is not proof of suitability for this shopper payout. Ask sales to identify the exact available product, entity requirements and startup minimums. [CashOut](https://www.adyen.com/cashout) |
| **Your Canadian business bank / its supported disbursement provider** | Interac e-Transfer for Business/Bulk is a domestic payout option to investigate through a participating institution. [Business product](https://www.interac.ca/en/payments/business/send-receive-money-with-interac-e-transfer-for-business/), [setup requirements](https://www.interac.ca/en/how-to-use/interac-e-transfer/how-to-use-interac-e-transfer-bulk/) | Permission for this use case, API access versus manual file upload, verification, limits, funds-availability timing, unclaimed transfers and per-payment fees. It does not solve US coverage. |

Do not infer that a payout provider will supply Gooper's capital. For example,
TabaPay documents prefunding requirements; negotiate the actual program terms.
[TabaPay settlement](https://developers.tabapay.com/docs/settlement)

### Partner inquiry — ready to paste into sales forms or email

Subject: Eligibility inquiry — Gooper-funded consumer return payouts, Canada/US

Hello,

I'm the founder of Gooper. We are validating a product that pays customers from
Gooper's own funds when an eligible retail return is approved, before the merchant
receives the item. The merchant reimburses Gooper only after receipt and inspection
approval. This is not a payout of a seller's existing platform earnings.

We are researching domestic CAD payouts in Canada and domestic USD payouts in the
US. Shopify policy approval is pending. We would like an eligibility discussion
before building a production integration.

Can your underwriting team support this exact use case? Please clarify:

- Supported legal-entity countries, recipient countries, rails and recipient account/card types.
- Whether Gooper must have processed the original purchase; we generally will not have.
- Whether the same provider can collect merchant reimbursement after approval, and what bank authorization is required.
- Expected customer funds-availability times, weekend coverage, eligibility checks and fallback options.
- Required prefunding, reserves, monthly minimums, implementation fees and transaction fees.
- Responsibility for KYB/KYC, sanctions screening, fraud, disputes, reversals and regulatory obligations.
- Hosted/tokenized payout-detail collection, sandbox access, idempotency, final-status webhooks and reconciliation reports.

Could you provide your underwriting checklist and arrange a discovery call? We can
then supply our entity details, funding source and honest pilot volume estimates.

Thank you,
Eric — Gooper

### Fill in before an underwriting submission

- Legal business name, incorporation country and operating bank country.
- First launch country/currency; target states/provinces where relevant.
- Committed funding available for payouts, separately from operating cash.
- Estimated monthly payout count, average amount and maximum amount; label forecasts as estimates.
- Expected days from payout to inspection and from approval to collection settlement.
- Merchant categories, prohibited items, return deadlines and initial risk limits.
- Proposed customer recourse and who bears each type of loss; do not imply these are decided.

## 5. Counsel and commercial terms

Ask for a fixed-scope assessment of this funds-flow diagram and proposed contracts.
The questions are whether the structure is permitted and what obligations apply,
not how to label it to avoid regulation.

- **Canada:** assess RPAA registration/safeguarding scope, FINTRAC scope, and any
  applicable credit, guarantee/insurance, privacy and consumer-protection rules.
  Treatment depends on the actual activities and contracts.
  [Bank of Canada registration criteria](https://www.bankofcanada.ca/2026/06/criteria-for-registering-payment-service-providers/),
  [FINTRAC MSB guidance](https://fintrac-canafe.canada.ca/msb-esm/msb-eng)
- **US:** assess federal MSB and state money-transmission requirements, plus any
  credit/financing, guarantee/insurance, privacy and consumer-protection implications.
  Identify precisely what the partner covers and what remains Gooper's obligation.
  [FinCEN MSB registration](https://www.fincen.gov/resources/money-services-business-msb-registration),
  [CSBS licensing overview](https://www.csbs.org/nonbank-licensing-and-examination)
- **Collection authority:** use the bank/provider's reviewed mandate. In Canada,
  PADs require a payor agreement and rules concerning amount/timing/notice; do not
  assume an “Approve return” button alone authorizes a debit. Have the provider
  confirm the relevant mandate for US business ACH collection too.
  [Payments Canada PAD guide](https://www.payments.ca/payment-resources/support-guides/business-guides/pre-authorized-debit)

Decide these commercial terms before live funding:

| Situation | Decision required |
| --- | --- |
| Item never arrives, is damaged, or is rejected | Precisely which losses Gooper absorbs; any customer recourse must be explicit, reviewed and consistent with the promise. |
| Merchant receives but delays inspection | Inspection deadline, evidence and dispute escalation. No automatic approval merely because time elapsed unless explicitly agreed and approved. |
| Merchant approves only part of the return | Accepted amount, residual loss, evidence and dispute process. |
| Merchant approves but collection fails | Merchant liability, retry rules, suspension and recovery process. Customer payout must not be repeated. |
| Customer also gets a refund or chargeback | Reconciliation, notification and legally permitted recovery. Do not assume the app can block all Shopify-admin refunds or card disputes. |
| Merchant uninstalls or becomes insolvent | Surviving contractual obligations, servicing and loss treatment. |

For the pilot, define a measurable claim such as “eligible payouts typically arrive
within [partner-confirmed window].” Do not promise instant availability universally
or describe an API acceptance response as money received.

## 6. What to build while approvals are pending

Keep the existing original-processor refund product unchanged. A separate,
feature-disabled simulator can model the funded product without live credentials.
No external payout or merchant debit should run in this phase.

Maintain independent records for:

- Return: requested, in transit, received, accepted/partially accepted/rejected.
- Payout: not started, pending, succeeded, failed, unknown, reversed.
- Reimbursement: not due, due, collection pending, settled, failed, reversed/disputed.
- Risk and ledger: approved exposure, committed funds, fees, losses and audit evidence.

Required controls and test cases:

1. Unique funding entitlement per merchant/order/line quantity, bound to the customer.
2. One idempotency key per logical money movement; retry after a timeout first queries
   the provider. Never fall back to a second payout route while the first is unknown.
3. Persist an intent before sending money; recover safely if the app crashes after
   the provider succeeds but before the database update.
4. Signed, deduplicated webhooks; tolerate repeated and out-of-order events. Compare
   provider statements with the internal ledger daily.
5. Prove that Gooper's two refund modes cannot both fund the same entitlement.
   Detect external refunds/disputes and escalate; app locking cannot prevent every
   concurrent merchant action. The residual risk needs an approved arrangement.
6. Receipt without approval creates no reimbursement due. Approval without a
   successful customer payout creates no collectible funded principal.
7. Test partial acceptance, non-return, payout reversal, collection failure,
   merchant uninstall and insufficient Gooper funds.
8. Use provider-hosted/tokenized payout details; keep card/bank credentials out of
   chat, ordinary logs and application-owned storage where possible.
9. Enforce per-customer, per-merchant and portfolio exposure caps, manual review and
   a global stop-funding switch. Stop new funding without breaking reconciliation.

The exact Shopify financial-recording implementation remains blocked until Shopify
confirms a permitted approach. Do not fake a successful Shopify refund to represent
an external payment.

## 7. Pilot economics and go/no-go

Illustrative liquidity calculation, not a recommended funding commitment:

    20 payouts/day × $50 average × 14 days to settled reimbursement = $14,000

That is base outstanding principal in one currency, before stressed delays,
non-returns, fraud, collection failures, fees, provider reserves and operating
cash. Model CAD and USD separately. Longer approval delays directly increase
funding needs. The payout partner does not eliminate Gooper's balance-sheet risk.

Calculate expected contribution per funded return:

    merchant fee − payout cost − collection cost − funding cost
    − expected unrecovered principal − fraud/support/compliance cost

Only launch when all are true:

- [ ] Shopify has confirmed the exact permitted flow and distribution in writing.
- [ ] Payment partner has approved the use case, countries, funding and collection arrangement.
- [ ] Counsel has assessed the structure; required registrations/approvals and contracts are in place.
- [ ] Shopify accounting and duplicate-payment handling have an approved, tested solution.
- [ ] Gooper has committed capital and a documented maximum tolerable loss/exposure.
- [ ] Merchant/customer terms explain timing, payout destination, risk and disputes accurately.
- [ ] Sandbox failure tests, ledger reconciliation and operational runbooks pass.
- [ ] Pilot merchants and operating owners are named; caps and stop conditions are set.

**Immediate founder checklist:** send the two inquiry drafts, book the scoped legal
review, and fill in the underwriting facts. The first objective is a written
feasibility decision—not a live-money integration.
