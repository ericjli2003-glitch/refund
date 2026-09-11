import assert from "node:assert/strict";
import test from "node:test";
import { storefrontConfig } from "./configure-storefront.mjs";

test("storefront origin follows the selected app configuration", () => {
  const config = storefrontConfig(
    'application_url = "https://staging.example.com/"\n[auth]\nredirect_urls = ["https://other.example.com"]',
  );
  assert.match(config, /https:\/\/staging.example.com/);
  assert.ok(!config.includes("other.example.com"));
  assert.equal(
    config,
    storefrontConfig(
      "application_url = 'https://staging.example.com' # staging\n",
    ),
  );
});

test("unsafe or ambiguous deployment URLs cannot be published to the storefront", () => {
  for (const url of [
    "http://example.com",
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com?key=secret",
    "https://example.com#fragment",
  ]) {
    assert.throws(() =>
      storefrontConfig(`application_url = ${JSON.stringify(url)}`),
    );
  }
  assert.throws(() =>
    storefrontConfig('[auth]\napplication_url = "https://example.com"'),
  );
  assert.throws(() =>
    storefrontConfig(
      'application_url = "https://a.example.com"\napplication_url = "https://b.example.com"',
    ),
  );
});
