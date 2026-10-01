import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AGENTS_STARTER_TEMPLATE } from "./agents-starter-template";

import {
  hasGooperParagraph,
  hasGooperSection,
  policyWithGooperParagraph,
  policyWithoutGooperParagraph,
  publishAgentsSection,
  publishRefundPolicyParagraph,
  DiscoveryPermissionError,
  refundPolicyParagraph,
  templateWithGooperSection,
  templateWithoutGooperSection,
} from "./agent-discovery-publish.server";
import type { AdminGraphql } from "./shopify-admin.server";

process.env.SHOPIFY_APP_URL = "https://gooper.test";

const SECTION = "## Returns through Gooper.io\n\nUse https://gooper.test/mcp.";
const MERCHANT = "# Agent Instructions - Snow\n\nHow agents use Snow.\n\n## Shipping\n\nWe ship weekly.\n";
const GUIDANCE = {
  automaticReturnWindowDays: null,
  refundTiming: null,
  returnInstructions: null,
  returnPolicyUrl: null,
};

test("without a template, the starter keeps Shopify's sections and gains the fenced section", () => {
  const template = templateWithGooperSection(null, SECTION);
  assert.ok(hasGooperSection(template));
  assert.match(template, /## Commerce Protocol \(UCP\)/);
  assert.equal(template.match(/## Returns through/g)?.length, 1);
  assert.ok(template.includes(SECTION));
});

test("a merchant's own template gains the section after its introduction, unchanged otherwise", () => {
  const template = templateWithGooperSection(MERCHANT, SECTION);
  assert.ok(template.startsWith("# Agent Instructions - Snow\n\nHow agents use Snow.\n\n{% comment %}gooper.io returns: start"));
  assert.ok(template.includes("## Shipping\n\nWe ship weekly."));
  // Publishing again refreshes in place rather than adding another copy.
  const refreshed = templateWithGooperSection(template, "## Returns through Gooper.io\n\nNew text.");
  assert.equal(refreshed.match(/gooper\.io returns: start/g)?.length, 1);
  assert.ok(refreshed.includes("New text.") && !refreshed.includes("Use https://gooper.test/mcp."));
  assert.equal(templateWithGooperSection(refreshed, "## Returns through Gooper.io\n\nNew text."), refreshed);
});

test("a hand-pasted Returns section is replaced, not duplicated", () => {
  const pasted = "# Store\n\nIntro.\n\n## Returns through Refund\n\nOld links.\n\n## Shipping\n\nWeekly.\n";
  const template = templateWithGooperSection(pasted, SECTION);
  assert.ok(!template.includes("Old links."));
  assert.equal(template.match(/## Returns through/g)?.length, 1);
  assert.ok(template.includes("## Shipping\n\nWeekly."));
});

test("removing the section restores the merchant's text, and an all-Gooper.io template empties", () => {
  const template = templateWithGooperSection(MERCHANT, SECTION);
  assert.equal(templateWithoutGooperSection(template), MERCHANT);
  const onlyGooper = templateWithGooperSection("# T", SECTION).replace("# T", "");
  assert.equal(templateWithoutGooperSection(onlyGooper), null);
});

test("the refund policy paragraph goes first, refreshes in place and comes out cleanly", () => {
  const original = "<p>Returns accepted within 30 days.</p>";
  const paragraph = refundPolicyParagraph("snow.myshopify.com");
  assert.match(paragraph, /https:\/\/gooper\.test\/returns\/snow\.myshopify\.com/);
  assert.match(paragraph, /https:\/\/gooper\.test\/mcp/);
  const body = policyWithGooperParagraph(original, paragraph);
  assert.ok(body.startsWith("<p><strong>Returns through Gooper.io:</strong>"));
  assert.ok(hasGooperParagraph(body));
  // Shopify's editor may drop the strong tag; the words still find it.
  const edited = body.replace(/<\/?strong>/g, "");
  assert.equal(policyWithGooperParagraph(edited, paragraph).match(/Returns through Gooper\.io:/g)?.length, 1);
  assert.equal(policyWithoutGooperParagraph(body), original);
  assert.ok(!hasGooperParagraph(original));
});

function fakeAdmin(responses: Array<unknown>, calls: Array<{ query: string; variables?: Record<string, unknown> }>): AdminGraphql {
  return {
    graphql: async (query, options) => {
      calls.push({ query, variables: options?.variables });
      return Response.json(responses.shift());
    },
  };
}

test("publishing writes the live theme's agents.md once and skips an unchanged file", async () => {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const theme = (content: string | null) => ({
    data: {
      themes: {
        nodes: [
          {
            id: "gid://shopify/OnlineStoreTheme/1",
            name: "Dawn",
            files: { nodes: content === null ? [] : [{ filename: "templates/agents.md.liquid", body: { __typename: "OnlineStoreThemeFileBodyText", content } }] },
          },
        ],
      },
    },
  });
  const admin = fakeAdmin(
    [theme(MERCHANT), { data: { themeFilesUpsert: { upsertedThemeFiles: [{ filename: "templates/agents.md.liquid" }], userErrors: [] } } }],
    calls,
  );
  assert.deepEqual(await publishAgentsSection(admin, "snow.myshopify.com", GUIDANCE), { themeName: "Dawn" });
  const written = (calls[1].variables!.files as Array<{ body: { value: string } }>)[0].body.value;
  assert.ok(hasGooperSection(written));
  assert.match(written, /Store to pass as `store`: snow\.myshopify\.com/);

  const again: typeof calls = [];
  await publishAgentsSection(fakeAdmin([theme(written)], again), "snow.myshopify.com", GUIDANCE);
  assert.equal(again.length, 1);
});

test("a missing theme permission or exemption becomes a clear message", async () => {
  const admin = fakeAdmin(
    [{ errors: [{ message: "Access denied for themes field. Required access: `read_themes` access scope." }] }],
    [],
  );
  await assert.rejects(publishAgentsSection(admin, "snow.myshopify.com", GUIDANCE), (error) =>
    error instanceof DiscoveryPermissionError && /Copy Returns section/.test(error.message),
  );
});

test("a store without a refund policy is asked to write one rather than given Gooper.io's text alone", async () => {
  const calls: Array<{ query: string }> = [];
  const admin = fakeAdmin([{ data: { shop: { shopPolicies: [] } } }], calls);
  await assert.rejects(publishRefundPolicyParagraph(admin, "snow.myshopify.com"), /no refund policy yet/);
  assert.equal(calls.length, 1);
});

test("the CLI starter template and the one Gooper.io publishes are the same text", () => {
  assert.equal(
    readFileSync("storefront/templates/agents.md.liquid", "utf8"),
    AGENTS_STARTER_TEMPLATE,
  );
});
