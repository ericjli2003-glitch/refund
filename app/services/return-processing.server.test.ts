import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReturnProcessLineItems,
  type ReturnLineItemNode,
  type ReverseFulfillmentLineItemNode,
} from "./return-processing.server";

const LINE_ITEM = "gid://shopify/LineItem/1";
const OTHER_LINE_ITEM = "gid://shopify/LineItem/2";
const LOCATION = "gid://shopify/Location/9";

function returnLineItem(
  id: string,
  lineItemId: string,
  quantity: number,
): ReturnLineItemNode {
  return { id, quantity, fulfillmentLineItem: { lineItem: { id: lineItemId } } };
}

function reverseLineItem(
  id: string,
  lineItemId: string,
  totalQuantity: number,
): ReverseFulfillmentLineItemNode {
  return {
    id,
    totalQuantity,
    fulfillmentLineItem: { lineItem: { id: lineItemId } },
  };
}

test("confirmed items restock at the resolved location", () => {
  assert.deepEqual(
    buildReturnProcessLineItems({
      items: [{ lineItemId: LINE_ITEM, quantity: 2 }],
      returnLineItems: [returnLineItem("gid://shopify/ReturnLineItem/1", LINE_ITEM, 2)],
      reverseFulfillmentLineItems: [
        reverseLineItem("gid://shopify/ReverseFulfillmentOrderLineItem/1", LINE_ITEM, 2),
      ],
      locationId: LOCATION,
    }),
    [
      {
        id: "gid://shopify/ReturnLineItem/1",
        quantity: 2,
        dispositions: [
          {
            reverseFulfillmentOrderLineItemId:
              "gid://shopify/ReverseFulfillmentOrderLineItem/1",
            quantity: 2,
            locationId: LOCATION,
            dispositionType: "RESTOCKED",
          },
        ],
      },
    ],
  );
});

test("a quantity split across reverse fulfillment orders is allocated once", () => {
  const [line] = buildReturnProcessLineItems({
    items: [{ lineItemId: LINE_ITEM, quantity: 3 }],
    returnLineItems: [returnLineItem("gid://shopify/ReturnLineItem/1", LINE_ITEM, 3)],
    reverseFulfillmentLineItems: [
      reverseLineItem("gid://shopify/ReverseFulfillmentOrderLineItem/1", LINE_ITEM, 2),
      reverseLineItem("gid://shopify/ReverseFulfillmentOrderLineItem/2", LINE_ITEM, 5),
    ],
    locationId: LOCATION,
  });
  assert.deepEqual(
    line.dispositions.map((disposition) => [
      disposition.reverseFulfillmentOrderLineItemId,
      disposition.quantity,
    ]),
    [
      ["gid://shopify/ReverseFulfillmentOrderLineItem/1", 2],
      ["gid://shopify/ReverseFulfillmentOrderLineItem/2", 1],
    ],
  );
});

test("two line items never consume each other's reverse fulfillment quantity", () => {
  const lines = buildReturnProcessLineItems({
    items: [
      { lineItemId: LINE_ITEM, quantity: 1 },
      { lineItemId: OTHER_LINE_ITEM, quantity: 1 },
    ],
    returnLineItems: [
      returnLineItem("gid://shopify/ReturnLineItem/1", LINE_ITEM, 1),
      returnLineItem("gid://shopify/ReturnLineItem/2", OTHER_LINE_ITEM, 1),
    ],
    reverseFulfillmentLineItems: [
      reverseLineItem("gid://shopify/ReverseFulfillmentOrderLineItem/1", LINE_ITEM, 1),
      reverseLineItem("gid://shopify/ReverseFulfillmentOrderLineItem/2", OTHER_LINE_ITEM, 1),
    ],
    locationId: LOCATION,
  });
  assert.deepEqual(
    lines.map((line) => line.dispositions[0].reverseFulfillmentOrderLineItemId),
    [
      "gid://shopify/ReverseFulfillmentOrderLineItem/1",
      "gid://shopify/ReverseFulfillmentOrderLineItem/2",
    ],
  );
});

test("no location means the refund still proceeds with nothing restocked", () => {
  const [line] = buildReturnProcessLineItems({
    items: [{ lineItemId: LINE_ITEM, quantity: 1 }],
    returnLineItems: [returnLineItem("gid://shopify/ReturnLineItem/1", LINE_ITEM, 1)],
    reverseFulfillmentLineItems: [
      reverseLineItem("gid://shopify/ReverseFulfillmentOrderLineItem/1", LINE_ITEM, 1),
    ],
    locationId: null,
  });
  assert.equal(line.quantity, 1);
  assert.deepEqual(line.dispositions, []);
});

test("a partly coverable quantity restocks nothing rather than a fraction", () => {
  const [line] = buildReturnProcessLineItems({
    items: [{ lineItemId: LINE_ITEM, quantity: 3 }],
    returnLineItems: [returnLineItem("gid://shopify/ReturnLineItem/1", LINE_ITEM, 3)],
    reverseFulfillmentLineItems: [
      reverseLineItem("gid://shopify/ReverseFulfillmentOrderLineItem/1", LINE_ITEM, 1),
    ],
    locationId: LOCATION,
  });
  assert.deepEqual(line.dispositions, []);
});

test("an item Shopify did not approve stops the refund", () => {
  assert.throws(
    () =>
      buildReturnProcessLineItems({
        items: [{ lineItemId: LINE_ITEM, quantity: 1 }],
        returnLineItems: [
          returnLineItem("gid://shopify/ReturnLineItem/2", OTHER_LINE_ITEM, 1),
        ],
        reverseFulfillmentLineItems: [],
        locationId: LOCATION,
      }),
    /does not cover every confirmed item/,
  );
});

test("an approved quantity below the confirmed quantity stops the refund", () => {
  assert.throws(
    () =>
      buildReturnProcessLineItems({
        items: [{ lineItemId: LINE_ITEM, quantity: 2 }],
        returnLineItems: [returnLineItem("gid://shopify/ReturnLineItem/1", LINE_ITEM, 1)],
        reverseFulfillmentLineItems: [
          reverseLineItem("gid://shopify/ReverseFulfillmentOrderLineItem/1", LINE_ITEM, 2),
        ],
        locationId: LOCATION,
      }),
    /smaller quantity than the customer confirmed/,
  );
});

test("receiving an item with no restock location records it as not restocked", () => {
  const [line] = buildReturnProcessLineItems({
    items: [{ lineItemId: LINE_ITEM, quantity: 1 }],
    returnLineItems: [returnLineItem("gid://shopify/ReturnLineItem/1", LINE_ITEM, 1)],
    reverseFulfillmentLineItems: [
      reverseLineItem("gid://shopify/ReverseFulfillmentOrderLineItem/1", LINE_ITEM, 1),
    ],
    locationId: null,
    unlocatedDisposition: "NOT_RESTOCKED",
  });
  assert.deepEqual(line.dispositions, [
    {
      reverseFulfillmentOrderLineItemId: "gid://shopify/ReverseFulfillmentOrderLineItem/1",
      quantity: 1,
      dispositionType: "NOT_RESTOCKED",
    },
  ]);
});
