import assert from "node:assert/strict";
import test from "node:test";

import {
  FORMER_NAME_RETENTION_MS,
  mergeFormerAliases,
} from "./merchant-directory.server";

const TESTING = ["testing", "testing storefront"];
const PIED = ["pied piper", "pied piper storefront"];
const NOW = new Date("2026-09-22T00:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

test("a store's first sync has no former names", () => {
  assert.deepEqual(mergeFormerAliases(TESTING, [], undefined, NOW), {
    aliases: TESTING,
    formerAliases: {},
  });
});

test("a rename keeps the old name searchable and records when it retired", () => {
  const merged = mergeFormerAliases(PIED, TESTING, {}, NOW);

  // A customer who bought under the old name still finds the store.
  assert.deepEqual(merged.aliases, [...PIED, ...TESTING]);
  assert.deepEqual(merged.formerAliases, {
    testing: NOW.toISOString(),
    "testing storefront": NOW.toISOString(),
  });
});

test("syncing again without a rename changes nothing", () => {
  const once = mergeFormerAliases(PIED, TESTING, {}, NOW);
  const later = new Date(NOW.getTime() + 86_400_000);
  const twice = mergeFormerAliases(PIED, once.aliases, once.formerAliases, later);

  // The retirement date is the rename, not the most recent sync, so a store
  // that syncs every six hours cannot hold an old name forever.
  assert.deepEqual(twice.formerAliases, once.formerAliases);
  assert.deepEqual(twice.aliases, once.aliases);
});

test("a former name stops being searchable once it has outlived its window", () => {
  const stored = {
    testing: ago(FORMER_NAME_RETENTION_MS + 1),
    "testing storefront": ago(FORMER_NAME_RETENTION_MS - 86_400_000),
  };
  const merged = mergeFormerAliases(PIED, PIED, stored, NOW);

  assert.deepEqual(merged.aliases, [...PIED, "testing storefront"]);
  assert.equal("testing" in merged.formerAliases, false);
});

test("renaming back makes the name current again rather than former", () => {
  const renamed = mergeFormerAliases(PIED, TESTING, {}, NOW);
  const back = mergeFormerAliases(TESTING, renamed.aliases, renamed.formerAliases, NOW);

  assert.deepEqual(back.aliases, [...TESTING, ...PIED]);
  // "testing" is the store's name again, so it is not held as a retired one.
  assert.equal("testing" in back.formerAliases, false);
  assert.deepEqual(Object.keys(back.formerAliases).sort(), PIED);
});

test("a corrupt or missing column is treated as no former names", () => {
  for (const stored of [null, undefined, "nonsense", 42, ["testing"], { testing: 5 }, { testing: "not a date" }]) {
    assert.deepEqual(mergeFormerAliases(PIED, [], stored, NOW), {
      aliases: PIED,
      formerAliases: {},
    });
  }
});
