# Merchant discovery template

`templates/agents.md.liquid` is a single-file addition to a merchant's existing
Shopify theme, not a complete theme and not an app theme extension.

Before applying it, back up the active theme and inspect any existing
`agents.md.liquid`, `llms.txt.liquid`, and `llms-full.txt.liquid` templates.
Merge the Returns section into existing merchant guides rather than replacing
them. Replace `/apps/refund` in the three return links if the merchant customized
the proxy path. Keep Shopify shopping discovery intact.

Use the merchant's authenticated Shopify CLI session. Identify the actual live
theme with `shopify theme list --store YOUR_STORE.myshopify.com`, then pull it into
a separate staging directory. Copy/merge this one template there and run
`shopify theme check --path STAGING_DIRECTORY`. Upload only the reviewed file:

```sh
shopify theme push --store YOUR_STORE.myshopify.com --theme VERIFIED_THEME_ID \
  --path STAGING_DIRECTORY --only templates/agents.md.liquid --nodelete --allow-live
```

Do not upload this partial directory as an entire theme. Read back the saved file,
then check `/agents.md` in an unlocked storefront browser: merchant name, store
origin, UCP versions, and all links must render, with no unresolved Liquid. Follow
the start-return link through the app proxy to the Refund sign-in page. Do not
create a real return/refund without a designated test order and exact confirmation.

The special `agents` object is documented by Shopify but some Theme Check versions
warn that it is unknown. Inspect those warnings separately from syntax errors;
verify Shopify's actual rendered response. Do not suppress unrelated theme errors.

Shopify also uses this file for `/llms.txt` and `/llms-full.txt` unless their own
templates exist. Custom guide prose no longer follows Shopify's generated default
automatically. Maintain the shopping sections, reapply when switching themes, and
remove the Refund section after uninstall. If there was no previous custom guide,
removing only this added template restores Shopify's default discovery guide.

App Store submission is separate from this merchant theme change. Development
customer-data access still needs to be configured; production access/review must
be resolved before a broader launch. This guide neither grants those permissions
nor installs Refund's MCP endpoint in normal ChatGPT/Claude. A browser-capable
assistant or the shopper can use the no-connector browser return flow.

References: [discovery template](https://shopify.dev/docs/storefronts/themes/architecture/templates/agents-md-liquid),
[protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).
