import assert from "node:assert/strict";
import test from "node:test";
import { otherReturnReasonId } from "./return-reasons.server";
import type { AdminGraphql } from "./shopify-admin.server";

const OTHER_DELETED = "other-reason-old";

const reason = (id: number, handle: string, name: string, deleted = false) => ({
  id: `gid://shopify/ReturnReasonDefinition/${id}`,
  handle,
  name,
  deleted,
});

function pages(...nodes: Array<ReturnType<typeof reason>[]>) {
  const calls: Array<Record<string, unknown>> = [];
  const admin: AdminGraphql = {
    graphql: async (_query, options) => {
      calls.push(options?.variables ?? {});
      const index = calls.length - 1;
      return Response.json({
        data: {
          returnReasonDefinitions: {
            nodes: nodes[index] ?? [],
            pageInfo: {
              hasNextPage: index < nodes.length - 1,
              endCursor: index < nodes.length - 1 ? `cursor-${index}` : null,
            },
          },
        },
      });
    },
  };
  return { admin, calls };
}

test("returns are filed under Shopify's Other reason, found once per store", async () => {
  const { admin, calls } = pages(
    [reason(1, "too-small", "Too Small"), reason(2, OTHER_DELETED, "Other", true)],
    [reason(3, "other-reason", "Other")],
  );
  assert.equal(
    await otherReturnReasonId("reasons-a.myshopify.com", admin),
    "gid://shopify/ReturnReasonDefinition/3",
  );
  assert.deepEqual(calls, [{ after: null }, { after: "cursor-0" }]);
  // Remembered for the store, so later returns don't look it up again.
  await otherReturnReasonId("reasons-a.myshopify.com", admin);
  assert.equal(calls.length, 2);
});

test("a store without the standard handle uses a reason named Other, never a deleted one", async () => {
  const { admin } = pages([reason(4, "legacy-other", "Other", true), reason(5, "misc", " other ")]);
  assert.equal(
    await otherReturnReasonId("reasons-b.myshopify.com", admin),
    "gid://shopify/ReturnReasonDefinition/5",
  );
  const none = pages([reason(6, "too-big", "Too Big")]);
  await assert.rejects(
    otherReturnReasonId("reasons-c.myshopify.com", none.admin),
    /no "Other" return reason/,
  );
});

