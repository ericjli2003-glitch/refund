# Security incident response policy — Gooper.io

**Owner:** Eric Li · **Version:** 1.0 · **Effective:** 2026-09-19 · **Next review:** 2027-03-19

This policy governs how Gooper.io detects, responds to, and reports security
incidents affecting the app, its infrastructure, or the merchant and customer
data it processes. It exists to satisfy Shopify's
[protected customer data requirements](https://shopify.dev/docs/apps/launch/protected-customer-data#requirements)
and applies to everyone with access to Gooper.io production systems.

> **Before first use:** fill in every `[CONFIRM]` marker below. Each one is a
> fact about the team or the accounts, not about the code, and an unfilled
> marker means that part of the policy is not yet true.

---

## 1. Scope and definitions

**Security incident** — any actual or reasonably suspected event that
compromises the confidentiality, integrity, or availability of Gooper.io
systems or the data they hold. This includes unauthorized access to the
database or hosting account, leaked credentials or API keys, exploitation of a
vulnerability in the app, malicious or accidental data disclosure, ransomware,
and loss of data without a recoverable backup.

**Personal data / protected customer data** — information identifying a unique
person or linkable to one. What Gooper.io actually holds:

| Data | Where | Form |
| --- | --- | --- |
| Customer email addresses | `ConnectionEmail`, `ConsentEmailCheck`, `EmailVerification` | Encrypted at the application layer (`sealedEmail`), with a separate `emailHash` used only for lookup |
| Customer identity | `CustomerReturnSession`, `ReturnDraft`, `AgentStoreLink`, `AgentAccessGrant` | Hashed (`customerSubjectHash`); the raw Shopify customer ID is not stored |
| Order and return details | `ReturnDraft`, `AgentReturn` | Order name, line items, return reasons, quote amounts |
| Shopify access tokens | `Session` | Merchant offline tokens, expiring |
| Customer session and grant credentials | `CustomerReturnSession`, `AgentAccessGrant`, `AgentConnection` | Stored as hashes only (`tokenHash`, `codeHash`, `grantHash`, `browserHash`) |

Gooper.io does **not** request or store customer names, phone numbers, or
postal addresses. Rows carrying personal data have an `expiresAt` and are
deleted by `pruneExpiredCustomerAccess` on the maintenance schedule.

**Systems in scope** — the Render web service and Postgres database, the
Shopify Partner account and app, the GitHub repository, and the Resend account
used for transactional email.

---

## 2. Roles and contacts

| Role | Held by | Responsibility |
| --- | --- | --- |
| Incident lead | Eric Li | Declares incidents, owns the response, decides on notification |
| Deputy | None — sole operator | — |

Gooper.io is operated by one person. There is no deputy and no internal
escalation path, which means an incident discovered while the lead is
unreachable waits. That is an accepted risk at this size, and it is the first
thing to revisit when anyone else joins.

**Internal reporting:** not applicable while sole-operator. Suspected incidents
reach the lead directly, or through the external inbox below.

**External reporting inbox:** the address published at `/support` and in the
app listing. Reports from researchers and merchants arrive here and must be
triaged within one business day.

**Key external contacts**

| Party | Channel |
| --- | --- |
| Shopify Partner support | Partner Dashboard support, and the App Review contact for the submission in flight |
| Render | Dashboard support |
| Resend | Dashboard support |
| Privacy regulator | Office of the Privacy Commissioner of Canada, and the relevant provincial or EU authority where affected residents require it |

---

## 3. Severity

| Level | Definition | Examples | Response start |
| --- | --- | --- | --- |
| **SEV-1** | Confirmed or likely exposure of personal data, or loss of control of production | Database accessed by an unauthorized party; Shopify access tokens leaked; hosting or Partner account taken over | Immediately, at any hour |
| **SEV-2** | A vulnerability that could lead to exposure, not yet exploited | Authentication bypass found in the return flow; a secret committed to the repository | Within 4 hours |
| **SEV-3** | Security-relevant but contained, no personal data at risk | Dependency CVE with no reachable path; failed intrusion attempt | Within 2 business days |

When severity is unclear, treat it as the higher level until assessment says
otherwise.

---

## 4. Response procedure

### 4.1 Detect and declare
Record the date and time of discovery — the clock for notification starts here.
Declare severity and open an incident record (§6).

### 4.2 Contain
Act to stop ongoing exposure before investigating in depth:
- Rotate the affected secrets. `SHOPIFY_API_SECRET`, `REFUND_SECRET`, and
  `DATABASE_URL` are set as unsynced Render environment variables; rotate in the
  Render dashboard and redeploy. `REFUND_PREVIOUS_SECRETS` exists so sealed
  values stay readable across a rotation — use it rather than orphaning data.
- Revoke compromised sessions. Customer grants and sessions are deletable by
  `customerSubjectHash` or connection; merchant sessions live in `Session`.
- If the Shopify access tokens are implicated, uninstall or suspend the affected
  installations and tell the merchants.
- Take the service offline if continued operation would worsen exposure.

### 4.3 Assess
Determine what data was involved, whose, how much, over what window, and
whether it was actually accessed or merely exposed. Use Render service and
Postgres logs, Render audit logs for infrastructure changes, GitHub audit
logs, and Shopify webhook receipts (`WebhookReceipt`).

Application-level access to personal data is recorded in `PersonalDataAccess`.
Query it by `shop` and `occurredAt` to see everything reached in a window, or
by `customerSubjectHash` to see everything reached for one person. Each row
names the actor (`CUSTOMER`, `MERCHANT`, `SYSTEM`), the source (`PORTAL`,
`ASSISTANT`, `ADMIN`, `JOB`), the action, the Shopify order or return
involved, and how many records the access covered. Rows hold no email, name or
amount, so the log can be read during an incident without widening exposure.

Coverage is the boundaries where the actor is known: customer order reads
through the portal and through an assistant, the merchant dashboard's order
read, and a merchant exporting a privacy request. Access reached by other
paths is not represented, so absence of a row is not proof that nothing was
read.

### 4.4 Notify
Notification is the incident lead's decision and cannot be deferred past the
deadlines below.

- **Shopify — immediately, and no later than 24 hours after becoming aware.**
  The Shopify API License and Terms of Use require notification of any
  *actual or suspected* breach or compromise of Merchant Data "immediately
  upon, but no later than twenty-four (24) hours of, becoming aware". The
  trigger is suspicion, not confirmation: do not wait for the assessment in
  §4.3 to complete. Report through Shopify Partner support at
  <https://help.shopify.com/questions/partners>.

  The same terms require prompt remediation, a full investigation, reasonable
  steps to mitigate further harm, and cooperation with Shopify's questions
  throughout — at Gooper.io's own cost.
- **Affected merchants** — without undue delay once the scope is known, with
  what happened, what data of their customers was involved, what has been done,
  and what they should do.
- **Regulators and data subjects** — where the applicable privacy law requires
  it. Under PIPEDA this is any breach posing a real risk of significant harm;
  under GDPR it is 72 hours to the supervisory authority.

Do not delay a Shopify or merchant notification to finish the investigation.
Send what is known, say what is still unknown, and follow up.

### 4.5 Eradicate and recover
Remove the cause, patch the vulnerability, and confirm the fix. Restore from
backup only after the cause is closed, so a restore cannot reintroduce it.
Verify data integrity and that scheduled maintenance and retention sweeps run
correctly afterwards.

### 4.6 Review
Within 10 business days of closing a SEV-1 or SEV-2, write a post-incident
review covering timeline, root cause, what detection missed, and dated
follow-up actions with owners. Add a regression test where the cause was a code
defect — the repository's test suite is the right place for it.

---

## 5. Backups and recovery

Render's managed Postgres provides automated encrypted backups and
point-in-time recovery. Recovery is performed from the Render dashboard.

`[CONFIRM: retention window of the current Render Postgres plan, and the date
of the last restore test.]` A backup that has never been restored is not a
verified backup; test a restore at least annually and record the date here.

---

The access log in `PersonalDataAccess` is retained for 365 days and swept by
the same maintenance schedule as other expiring data. A customer redaction
request clears the identifier on those rows but keeps the rows, so the record
of what was reached survives without pointing at a person.

---

## 6. Records

Keep one record per incident, retained at least two years, containing:
discovery date and time, reporter, severity, systems and data involved, the
timeline of actions with timestamps, notifications sent and to whom, root
cause, and follow-up actions.

Records are kept in a **private GitHub repository separate from this one**, so
they survive an incident affecting Render, carry their own timestamps and
history, and can be produced if Shopify or a regulator asks for them. Never
record personal data belonging to an affected customer in an incident record —
reference the affected rows by identifier and count instead.

`[CONFIRM: repository name, once created.]`

---

## 7. Access control

- Production access is held by the sole operator only. No other person holds
  credentials to Render, GitHub, the Shopify Partner account, or Resend.
- Multi-factor authentication is enforced on Render, GitHub, the Shopify
  Partner account, and Resend (confirmed 2026-09-20).
- MFA is also required on the two accounts that can be used to reach the
  others: the domain registrar and DNS for gooper.io, which controls both the
  app's hostname and the mailbox that receives password resets, and the
  mailbox behind `PUBLIC_SUPPORT_EMAIL` / `REFUND_EMAIL_FROM`.
  `[CONFIRM: MFA and transfer lock on the registrar; MFA on the support mailbox.]`
- Credentials are unique per service and generated by a password manager.
  `[CONFIRM: password manager in use.]`
- Access is reviewed every 6 months and revoked the same day someone no longer
  needs it.
- Production secrets are never committed. They are set as unsynced environment
  variables in Render and are absent from `render.yaml` and the repository.

---

## 8. Known gaps

Tracked openly so they are not mistaken for controls that exist.

| Gap | Status |
| --- | --- |
| **Access logging coverage.** `PersonalDataAccess` records the boundaries listed in §4.3. Paths outside those, including scheduled return processing, are not yet recorded. | Partial — extend as new surfaces are added |
| **Restore testing.** No recorded test restore from a Render backup. | Open |
| **Third-party security audit.** None performed. | Open, not currently required |

---

## 9. Review

Reviewed at least every 6 months and after any SEV-1, by the incident lead.
Record the date and any changes in the table below.

| Date | Reviewer | Change |
| --- | --- | --- |
| 2026-09-19 | Eric Li | Initial version |
