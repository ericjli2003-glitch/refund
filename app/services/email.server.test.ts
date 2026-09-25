import assert from "node:assert/strict";
import test from "node:test";
import {
  emailPayload,
  isEmailAddress,
  publicSupportEmail,
  replyToAddress,
} from "./email.server";

const message = {
  to: "customer@example.com",
  subject: "Confirm your return",
  html: "<p>Confirm</p>",
  text: "Confirm",
  idempotencyKey: "key-1",
};

const environment = (values: Record<string, string | undefined>) =>
  values as unknown as NodeJS.ProcessEnv;

test("a dedicated reply address wins over the published support address", () => {
  assert.equal(
    replyToAddress(
      environment({
        REFUND_EMAIL_REPLY_TO: "replies@gooper.io",
        PUBLIC_SUPPORT_EMAIL: "support@example.com",
      }),
    ),
    "replies@gooper.io",
  );
});

test("the support address is used when no dedicated address is set", () => {
  assert.equal(
    replyToAddress(
      environment({ PUBLIC_SUPPORT_EMAIL: "support@example.com" }),
    ),
    "support@example.com",
  );
});

test("surrounding whitespace is trimmed", () => {
  assert.equal(
    replyToAddress(
      environment({ PUBLIC_SUPPORT_EMAIL: "  support@example.com \n" }),
    ),
    "support@example.com",
  );
});

test("a malformed address falls through instead of being sent", () => {
  assert.equal(
    replyToAddress(
      environment({
        REFUND_EMAIL_REPLY_TO: "not-an-address",
        PUBLIC_SUPPORT_EMAIL: "support@example.com",
      }),
    ),
    "support@example.com",
  );
  for (const value of [
    "",
    "   ",
    "a@b",
    "no-at-sign.com",
    "two@@at.com",
    undefined,
  ]) {
    assert.equal(
      replyToAddress(environment({ REFUND_EMAIL_REPLY_TO: value })),
      null,
    );
  }
});

test("every sent message carries a reply address when one is configured", () => {
  const payload = emailPayload(
    message,
    environment({
      REFUND_EMAIL_FROM: "Gooper.io Returns <returns@gooper.io>",
      PUBLIC_SUPPORT_EMAIL: "support@example.com",
    }),
  );
  assert.deepEqual(payload.reply_to, ["support@example.com"]);
  assert.equal(payload.from, "Gooper.io Returns <returns@gooper.io>");
  assert.deepEqual(payload.to, ["customer@example.com"]);
});

test("reply_to is omitted rather than sent empty when nothing is configured", () => {
  const payload = emailPayload(
    message,
    environment({ REFUND_EMAIL_FROM: "Gooper.io <returns@gooper.io>" }),
  );
  assert.equal("reply_to" in payload, false);
});

test("address validation matches what the support page will publish", () => {
  assert.equal(isEmailAddress("support@example.com"), true);
  assert.equal(isEmailAddress("not-an-address"), false);
  assert.equal(isEmailAddress("spaces in@example.com"), false);
});

test("the published support address is trimmed and shown as configured", () => {
  assert.equal(
    publicSupportEmail(
      environment({ PUBLIC_SUPPORT_EMAIL: " support@example.com\n" }),
    ),
    "support@example.com",
  );
});

test("an unset or malformed support address is never published", () => {
  for (const value of [
    undefined,
    "",
    "   ",
    "a@b",
    "no-at-sign.com",
    "two@@at.com",
  ]) {
    assert.equal(
      publicSupportEmail(environment({ PUBLIC_SUPPORT_EMAIL: value })),
      null,
    );
  }
});

test("the public pages publish the support address, never the reply-to address", () => {
  // REFUND_EMAIL_REPLY_TO is for transactional mail only; the public pages
  // publish PUBLIC_SUPPORT_EMAIL or nothing.
  assert.equal(
    publicSupportEmail(
      environment({ REFUND_EMAIL_REPLY_TO: "replies@gooper.io" }),
    ),
    null,
  );
});
