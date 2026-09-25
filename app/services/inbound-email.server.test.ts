import assert from "node:assert/strict";
import test from "node:test";
import {
  InboundWebhookRejected,
  buildForwardPayload,
  parseInboundEmailEvent,
  signInboundWebhookBody,
  verifyInboundWebhookSignature,
} from "./inbound-email.server";

const secret = "whsec_" + Buffer.from("test-signing-key").toString("base64");

function signedHeaders(body: string, at: Date, id = "msg_1") {
  const timestamp = Math.floor(at.getTime() / 1000);
  return new Headers({
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": signInboundWebhookBody(secret, id, timestamp, body),
  });
}

test("a correctly signed body verifies", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
  const now = new Date();
  assert.doesNotThrow(() =>
    verifyInboundWebhookSignature(secret, body, signedHeaders(body, now), now),
  );
});

test("a tampered body is rejected", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
  const now = new Date();
  const headers = signedHeaders(body, now);
  assert.throws(
    () =>
      verifyInboundWebhookSignature(secret, body + "x", headers, now),
    InboundWebhookRejected,
  );
});

test("a wrong secret is rejected", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
  const now = new Date();
  const headers = signedHeaders(body, now);
  assert.throws(
    () => verifyInboundWebhookSignature("whsec_" + Buffer.from("other").toString("base64"), body, headers, now),
    InboundWebhookRejected,
  );
});

test("an expired timestamp is rejected", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
  const signedAt = new Date(Date.now() - 10 * 60 * 1000);
  const headers = signedHeaders(body, signedAt);
  assert.throws(
    () => verifyInboundWebhookSignature(secret, body, headers, new Date()),
    InboundWebhookRejected,
  );
});

test("missing headers are rejected", () => {
  const body = "{}";
  assert.throws(
    () => verifyInboundWebhookSignature(secret, body, new Headers(), new Date()),
    InboundWebhookRejected,
  );
});

test("an email.received event yields its email_id", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "abc-123" } });
  assert.deepEqual(parseInboundEmailEvent(body), { emailId: "abc-123" });
});

test("other event types are ignored, not rejected", () => {
  const body = JSON.stringify({ type: "email.delivered", data: {} });
  assert.equal(parseInboundEmailEvent(body), null);
});

test("a received-email event missing its id is rejected", () => {
  const body = JSON.stringify({ type: "email.received", data: {} });
  assert.throws(() => parseInboundEmailEvent(body), InboundWebhookRejected);
});

test("malformed JSON is rejected", () => {
  assert.throws(() => parseInboundEmailEvent("not json"), InboundWebhookRejected);
});

test("the forward preserves the original sender and the address it arrived at", () => {
  const payload = buildForwardPayload(
    {
      from: "customer@example.com",
      to: ["support@gooper.io"],
      subject: "Where is my refund",
      html: "<p>Hi</p>",
      text: "Hi",
      attachments: [],
    },
    "eric@personal.example",
    "gooper.io",
  );
  assert.equal(payload.from, "Gooper.io <support@gooper.io>");
  assert.deepEqual(payload.to, ["eric@personal.example"]);
  assert.equal(payload.subject, "[Gooper.io] Where is my refund");
  assert.deepEqual(payload.reply_to, ["customer@example.com"]);
  assert.match(payload.text, /Forwarded from support@gooper\.io/);
  assert.match(payload.text, /Original sender: customer@example\.com/);
});

test("attachments are noted rather than silently dropped", () => {
  const payload = buildForwardPayload(
    {
      from: "customer@example.com",
      to: ["support@gooper.io"],
      subject: "Photo attached",
      html: null,
      text: "See attached",
      attachments: [{ filename: "photo.png" }],
    },
    "eric@personal.example",
    "gooper.io",
  );
  assert.match(payload.text, /1 attachment\(s\) were not forwarded/);
});

test("reply_to is omitted when the original from address is not a real address", () => {
  const payload = buildForwardPayload(
    {
      from: "not-an-address",
      to: ["support@gooper.io"],
      subject: "x",
      html: null,
      text: "x",
      attachments: [],
    },
    "eric@personal.example",
    "gooper.io",
  );
  assert.equal("reply_to" in payload, false);
});
