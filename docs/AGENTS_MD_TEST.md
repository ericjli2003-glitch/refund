# agents.md test: Gooper.io as the store's returns provider

Checks that a store's `/agents.md` names Gooper.io as its returns provider and
that an AI assistant reading it can run the return through the Gooper.io
connector. Shopify Support confirmed (2026-10-01) that `agents.md` may name an
app's MCP endpoint this way, but that it is informational: whether an assistant
follows it depends on the assistant. This test records what each host actually
does.

Use only the test store, Pied Piper (`testing-bl7vdfur.myshopify.com`), and its
test payment gateway. Confirming a return refunds the original payment method.

## What the guide says

There are three copies, all generated from the same wording:

- **The store's own `/agents.md`**, from the theme's `agents.md.liquid`. The
  dashboard's "Copy Returns section" button produces it with the store's
  return guidance, the connector address and the store's myshopify domain
  filled in. `storefront/templates/agents.md.liquid` is a full starter.
- **`/apps/refund/agents.md`**, served by Gooper.io through the app proxy and
  always current.
- **`/apps/refund/manifest.json`**, the same in JSON. `returnsProvider` names
  Gooper.io; `connector` gives the endpoint, the `store` value and
  `readyForThisStore`.

Each tells an assistant, in order:

1. This store handles returns through Gooper.io; use it rather than another
   return path.
2. If it can call remote MCP tools, use `https://gooper.io/mcp` with
   `store` set to this store: `find_returnable_items`, then `quote_return`,
   ask the customer once, then `confirm_return` after a clear yes. If the
   connector isn't added, ask the customer to add it or send them to
   `https://gooper.io/connect`.
3. Otherwise open the browser entry `/apps/refund/start-return`, or give the
   shopper the link.

## Before you start

1. **Deploy.** Render deploys the default branch, so merge this change to
   `main` and wait for the deploy to finish.
2. **Store setup**, in the Gooper.io dashboard in the Pied Piper admin: return
   rules saved, "Let customers return through their AI assistant" on, and
   automatic refunds on for the submission step. See
   [ASSISTANT_E2E_TEST.md](ASSISTANT_E2E_TEST.md#before-you-start) for the test
   orders and emails; one fulfilled test order is enough here.
3. **Storefront password.** A password-protected storefront redirects
   `/agents.md` and `/apps/refund/*` to `/password`, so an assistant can't read
   them. Either remove the password for the test (Online Store > Preferences),
   or use the fallback in step 6 and note it in the results. Don't change it
   without deciding to.

## Steps

### 1. Publish with the dashboard buttons

First, once: run `npm run deploy` so Shopify knows the optional scopes, and
request the `write_themes` exemption in the Partner Dashboard (see
[PROJECT_STATE.md](PROJECT_STATE.md), decision 18).

In the Gooper.io dashboard, section "Tell AI assistants that Gooper.io handles
your returns":

1. **Add Gooper.io to agents.md.** Shopify asks for permission to edit themes
   the first time; accept. Expect the success banner and "Added to <theme>".
   If it says Shopify hasn't allowed theme edits yet, the exemption isn't
   approved: use **Copy Returns section** under "Prefer to add it yourself?"
   and paste it into Online Store > Themes > Edit code >
   `templates/agents.md.liquid` for now.
2. **Add to refund policy.** Accept the policy permission. Check Settings >
   Policies: the refund policy starts with "Returns through Gooper.io:" and
   the rest is unchanged.
3. **Turn on in theme editor** for the site tools embed, and save the theme.
4. Change the return instructions and save the policy; `/agents.md` should
   show the new text without clicking again.
5. Click each **Remove** and check both come out cleanly, then add them back.

### 2. Read the published files

In a browser that can see the storefront:

- `https://testing-bl7vdfur.myshopify.com/agents.md`: shows "Returns through
  Gooper.io", `https://gooper.io/mcp`, the store's myshopify domain, and no
  raw `{{` or `{%`.
- `/apps/refund/agents.md`: the same connector section, numbered 1 and 2.
- `/apps/refund/manifest.json`: `connector.readyForThisStore` is `true`. If it
  is `false`, fix the store setup above first.
- `/policies/refund-policy`: the Gooper.io paragraph is first.
- Any product page's source: the `MerchantReturnPolicy` script names
  `https://gooper.io/mcp` and the store.

With the storefront public, the read-only script checks all of this:

```sh
REFUND_TEST_APP_URL=https://gooper.io \
REFUND_TEST_SHOP=testing-bl7vdfur.myshopify.com \
npm run test:live-proxy
```

### 3. Assistant with the connector

In Claude with the Gooper.io connector added (setup in
[ASSISTANT_E2E_TEST.md](ASSISTANT_E2E_TEST.md#host-setup)), new chat:

> I bought something from https://testing-bl7vdfur.myshopify.com and want to
> return it. Check the store's agents.md for how they handle returns.

Expect: it reads `/agents.md`, uses the Gooper.io tools for this store, finds
the item without asking for an order number, states the items, fees and refund
total, asks once, and submits only after "yes". Check the return and refund in
the Pied Piper admin.

### 4. Assistant without the connector

Remove or turn off the Gooper.io connector, new chat, same prompt.

Expect: it says the store uses Gooper.io and either asks you to add
`https://gooper.io/mcp` as a connector (or visit `https://gooper.io/connect`)
or gives the start-return link. It must not invent another return path or ask
for a password or card.

Repeat steps 3 and 4 in ChatGPT if you have developer mode.

### 5. Similar store names

With the connector, ask to return something from a slightly misspelled store
name ("Pied Pipr"). Expect "Did you mean Pied Piper?" before it goes ahead.
If you have a second test store with a similar name, ask by the shared part
of the name: it should pick the store your confirmed email has orders at.

### 6. Fallback if the storefront stays locked

Open `/agents.md` in an unlocked browser, copy the page text, and paste it into
the chat with the prompt from step 3. This tests how an assistant acts on the
guide, not whether it can fetch it. Record that the fetch wasn't tested.

## Results

| Date | Host | Connector added | Storefront public | Read agents.md itself | Used Gooper.io | Return submitted | Notes |
| ---- | ---- | --------------- | ----------------- | --------------------- | -------------- | ---------------- | ----- |
