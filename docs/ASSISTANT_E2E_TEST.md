# Assistant end-to-end test: ChatGPT and Claude

A manual acceptance run for the customer connection at `https://gooper.io/mcp`,
done once in each host. It checks what automated tests can't: the host's own
connector UI, the consent page in a real browser, real email delivery, and a
real return reaching Shopify.

Run it before submitting to a host's directory, after any change to the OAuth
flow, the consent page or the connection tools, and after Shopify API version
upgrades. Record each run in [Results](#results).

How the flow works is in [AGENT_ACCESS.md](AGENT_ACCESS.md).

## Before you start

**Only use the test store.** Confirming a return refunds the original payment
method. Use Pied Piper (`testing-bl7vdfur.myshopify.com`) and its test payment
gateway, never a real store or a real card.

**Store setup** (Gooper.io dashboard in the Pied Piper admin):

- Return rules saved, and "Let customers return through their AI assistant"
  on. "AI-assisted returns" shows **Enabled**.
- "Authorize eligible refunds to the original payment method on customer
  confirmation" on, for the submission steps. With it off, the assistant quotes
  and the store reviews the return, which is also worth one run.
- Note the restocking fee, return shipping fee and final-sale collections, so
  you know what the quote should deduct.

**Two email addresses you can read:**

- **Email A**, confirmed on the consent page.
- **Email B**, not confirmed anywhere, for the different-email case (step 7).

**Two test orders at Pied Piper**, placed through the storefront with the test
gateway and then **fulfilled** in the admin (Shopify only returns fulfilled
items):

- **Order A** with Email A, one ordinary item that isn't final sale.
- **Order B** with Email B.

**A clean start:** remove any existing Gooper.io connector from the host, and
disconnect at `https://gooper.io/connect/manage` if the browser has a
connection.

## Host setup

URL for both: `https://gooper.io/mcp` (no trailing slash). Choose OAuth if asked
and leave client ID and secret blank.

- **Claude:** Customize → Connectors → add a custom connector named "Gooper.io"
  with the URL, then Connect.
- **ChatGPT:** turn on developer mode (Settings → Apps & Connectors →
  Advanced), then create a connector named "Gooper.io" with the URL and OAuth.
  Workspace policy can block developer mode.

Host menus change. If these paths are out of date, follow the host links in
[AGENT_ACCESS.md](AGENT_ACCESS.md#connect-and-test) and update this section.

## Steps

Each step lists what to do, what should happen, and what counts as a failure.
Start each step in a new chat unless it says otherwise. Screenshot anything
marked 📸.

### 1. Connect

Do: finish the host's connect flow.

Expect:

- A Gooper.io page opens that names no store and asks "What email do you use
  when you shop online?" 📸
- A 6-digit code arrives at Email A. Allow stays disabled until the code is
  entered.
- After Allow, the host shows Gooper.io as connected. Note whether it shows
  the Gooper.io icon or a plain letter. The server advertises the icon, but
  whether it appears is up to the host, so a letter isn't a failure.
- `https://gooper.io/connect/manage`, in the same browser, lists Email A.

Fail if: any Shopify sign-in page appears, the host shows an OAuth or
registration error, or Allow works before an email is confirmed.

Then set Gooper.io's tools to "Always allow" in the host, so later steps aren't
interrupted by permission prompts.

### 2. Find the store and the item

Say: "I'd like to return something from Pied Piper."

Expect: the assistant finds Pied Piper and shows Order A's item, with no
sign-in, no order number and no reason asked for. The store links through
Email A without anything for you to do.

Fail if: it asks you to sign in to Shopify, asks for an order number, picks a
different store, or says the store isn't set up (`store_not_ready`). If it says
that, check the store setup above; the order-email lookup also needs Shopify's
protected customer data access.

### 3. Quote, then decline

Continue the same chat: "Return the [item]."

Expect: one message with the item going back, any restocking and return
shipping fees, and the refund total, ending in a single question. The total
matches the store's rules. 📸

Say: "No, never mind."

Fail if: anything is submitted. Check the Gooper.io dashboard's Recent returns
and the order in Shopify admin: no new return.

### 4. Quote and confirm

New chat: "I want to return the [item] from Pied Piper." When the quote comes
back, say "Yes."

Expect:

- The assistant confirms the return was submitted and gives the refund
  amount. 📸
- Gooper.io's dashboard shows the order under Recent returns.
- Shopify admin shows a return on Order A, and, with automatic refunds on, a
  refund to the test payment. 📸

Fail if: the assistant submits before your "Yes", the amounts differ between
chat, dashboard and Shopify, or the chat says it's submitted but Shopify has
no return.

### 5. Check status

Same chat, or a new one: "What's the status of my Pied Piper return?"

Expect: the current status, and a return label or tracking if the store has
added one. Nothing new is created.

### 6. Repeat safely

Same chat as step 4: "Please submit that return again."

Expect: no second return or refund. The assistant either reports that it's
already submitted (a retry of the same quote) or that the item has nothing left
to return (a fresh quote).

Fail if: Shopify shows two returns or two refunds for the item.

### 7. A different email

New chat: "I'd like to return something from Pied Piper. I used [Email B]
there."

Expect:

- The assistant says it sent a confirmation to Email B and tells you a
  two-digit number.
- The email to Email B has a "Yes, that's me" button. It opens a page asking
  you to pick a number.
- **First try:** pick a wrong number. The request is cancelled and Email B is
  not added.
- **Second try:** ask again, pick the right number, then return to the chat.
  Order B's item appears, and `/connect/manage` now lists Email B.

Fail if: a wrong number links the email, or Email B is added before you
confirm.

### 8. Store not ready

In the dashboard, turn off "Let customers return through their AI assistant"
and save. New chat: "I'd like to return something from Pied Piper."

Expect: the assistant says kindly that the store doesn't take returns through
assistants yet and points to the store's own returns page. It doesn't ask for
an email or send one.

Then turn the setting back on and save.

### 9. Manage emails

New chat: "Which emails have I confirmed with Gooper.io?", then "Remove
[Email B]."

Expect: both emails are listed, then Email B is removed, and `/connect/manage`
agrees.

### 10. Still connected later

At least 2 hours after step 1, without reconnecting: "Any updates on my Pied
Piper return?"

Expect: it works with no reconnect prompt. Access tokens last an hour, so this
proves refresh works in this host.

Fail if: the host asks you to reconnect or reports an authorization error.

### 11. Disconnect

At `https://gooper.io/connect/manage`, disconnect. Then in the host: "Check my
Pied Piper return."

Expect: the host reports that Gooper.io needs reconnecting. The Gooper.io tools
no longer answer.

## Results

Record one row per host per run. A run passes only if every step passes. For a
failure, note the step and what happened, and attach the screenshots.

| Date | Host (and plan) | Tester | Result | Failed steps and notes |
| ---- | --------------- | ------ | ------ | ---------------------- |
|      | Claude          |        |        |                        |
|      | ChatGPT         |        |        |                        |
