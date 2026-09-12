import assert from "node:assert/strict";
import test from "node:test";

import {
  customerIdentityHash,
  customerIdentityHashes,
  refundSecrets,
  seal,
  signQuote,
  unseal,
  unsealWithRotation,
  verifyQuoteSignature,
} from "./customer-security.server";
import { hashCustomerId } from "./return-guards.server";

const SECRET_VARIABLES = [
  "REFUND_SECRET",
  "REFUND_PREVIOUS_SECRETS",
  "SHOPIFY_API_SECRET",
] as const;
type SecretEnv = Partial<Record<(typeof SECRET_VARIABLES)[number], string>>;

// Other suites share this process, so every variable is restored afterwards.
function withSecrets<T>(env: SecretEnv, run: () => T): T {
  const saved = SECRET_VARIABLES.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of SECRET_VARIABLES) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const CUSTOMER = "gid://shopify/Customer/71";
const PAYLOAD = { version: 1, id: "quote-1", subject: "customer-a" };

test("an existing deployment keeps using the Shopify app secret until REFUND_SECRET is set", () => {
  withSecrets({ SHOPIFY_API_SECRET: "shopify-original" }, () => {
    assert.deepEqual(refundSecrets(), ["shopify-original"]);
    assert.equal(
      customerIdentityHash(CUSTOMER),
      hashCustomerId(CUSTOMER, "shopify-original"),
    );
  });
});

test("REFUND_SECRET takes over writes while a listed retired secret stays readable", () => {
  const legacy = withSecrets({ SHOPIFY_API_SECRET: "shopify-original" }, () => ({
    sealed: seal("customer-token", "session:shop"),
    quote: signQuote(PAYLOAD),
  }));
  withSecrets(
    {
      SHOPIFY_API_SECRET: "shopify-rotated",
      REFUND_SECRET: "refund-new",
      REFUND_PREVIOUS_SECRETS: "shopify-original",
    },
    () => {
      assert.deepEqual(unsealWithRotation(legacy.sealed, "session:shop"), {
        value: "customer-token",
        current: false,
      });
      assert.deepEqual(verifyQuoteSignature(legacy.quote), PAYLOAD);
      assert.deepEqual(customerIdentityHashes(CUSTOMER), [
        hashCustomerId(CUSTOMER, "refund-new"),
        hashCustomerId(CUSTOMER, "shopify-original"),
      ]);
      assert.equal(
        unsealWithRotation(seal("fresh", "session:shop"), "session:shop").current,
        true,
      );
    },
  );
});

test("rotating only the Shopify app secret no longer breaks Refund data", () => {
  const before = withSecrets(
    { SHOPIFY_API_SECRET: "shopify-a", REFUND_SECRET: "refund" },
    () => ({
      sealed: seal("value", "context"),
      quote: signQuote(PAYLOAD),
      identity: customerIdentityHash(CUSTOMER),
    }),
  );
  withSecrets({ SHOPIFY_API_SECRET: "shopify-b", REFUND_SECRET: "refund" }, () => {
    assert.equal(unseal(before.sealed, "context"), "value");
    assert.deepEqual(verifyQuoteSignature(before.quote), PAYLOAD);
    assert.equal(customerIdentityHash(CUSTOMER), before.identity);
  });
});

test("values from a secret that is no longer listed are rejected", () => {
  const sealed = withSecrets({ REFUND_SECRET: "old" }, () => ({
    value: seal("value", "context"),
    quote: signQuote(PAYLOAD),
  }));
  withSecrets({ REFUND_SECRET: "new" }, () => {
    assert.throws(() => unseal(sealed.value, "context"));
    assert.throws(() => verifyQuoteSignature(sealed.quote), /Invalid return quote/);
  });
});

test("secret lists are trimmed and deduplicated, and missing configuration fails closed", () => {
  withSecrets(
    { REFUND_SECRET: "refund", REFUND_PREVIOUS_SECRETS: " refund , old,, " },
    () => assert.deepEqual(refundSecrets(), ["refund", "old"]),
  );
  withSecrets({}, () =>
    assert.throws(() => refundSecrets(), /not configured/),
  );
});
