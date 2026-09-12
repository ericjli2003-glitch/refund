import assert from "node:assert/strict";
import test from "node:test";
import { describeRefundProgress, refundPaymentStatus } from "./refund-status";

const refund = (status: string) => ({ kind: "REFUND", status });

test("refund status requires evidence from all refund transactions", () => {
  assert.equal(refundPaymentStatus([]), "UNKNOWN");
  assert.equal(refundPaymentStatus([{ kind: "SALE", status: "SUCCESS" }]), "UNKNOWN");
  assert.equal(refundPaymentStatus([refund("SUCCESS")]), "SUCCESS");
  assert.equal(refundPaymentStatus([refund("SUCCESS")], true), "UNKNOWN");
  assert.equal(refundPaymentStatus([refund("SUCCESS"), refund("PENDING")]), "PENDING");
  assert.equal(refundPaymentStatus([refund("AWAITING_RESPONSE")]), "PENDING");
  assert.equal(refundPaymentStatus([refund("SUCCESS"), refund("FAILURE")]), "FAILED");
  assert.equal(refundPaymentStatus([{ kind: "refund", status: "error" }]), "FAILED");
  assert.equal(refundPaymentStatus([refund("unknown_future_status")]), "UNKNOWN");
});

test("customer messages distinguish processor success, pending funds, and merchant attention", () => {
  const pending = describeRefundProgress({ status: "REFUND_RECORDED", refundStatus: "PENDING" });
  assert.equal(pending.title, "Refund submitted");
  assert.match(pending.message, /not yet confirmed/);
  const successful = describeRefundProgress({ status: "REFUND_SUBMITTED", refundStatus: "SUCCESS" });
  assert.match(successful.message, /bank may still take time/);
  const failed = describeRefundProgress({ status: "NEEDS_ATTENTION", refundStatus: "SUCCESS" });
  assert.equal(failed.title, "Merchant review needed");
  assert.match(failed.message, /do not submit another/);
});
