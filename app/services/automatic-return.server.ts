import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { customerAccountGraphql } from "./customer-account.server";

export type RequestedItem = {
  lineItemId: string;
  quantity: number;
};

type Money = { amount: string; currencyCode: string };
type UserError = { field?: string[]; message: string };

type CustomerOrdersResponse = {
  customer: {
    id: string;
    orders: {
      nodes: Array<{
        id: string;
        name: string;
        processedAt: string;
        returnInformation: {
          nonReturnableSummary: { nonReturnableReasons: string[] };
          returnableLineItems: {
            nodes: Array<{
              quantity: number;
              lineItem: {
                id: string;
                presentmentTitle: string;
                currentTotalPrice: Money;
              };
            }>;
          };
        };
      }>;
    };
  };
};

type ReturnCalculationResponse = {
  returnCalculate: {
    financialSummary: {
      returnTotalSet: { presentmentMoney: Money };
    };
    returnLineItems: {
      nodes: Array<{ lineItem: { id: string }; quantity: number }>;
    };
  };
};

const CUSTOMER_ORDERS_QUERY = `#graphql
  query CustomerReturnableOrders($first: Int!) {
    customer {
      id
      orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          id
          name
          processedAt
          returnInformation {
            nonReturnableSummary { nonReturnableReasons }
            returnableLineItems(first: 50) {
              nodes {
                lineItem {
                  id
                  presentmentTitle
                  currentTotalPrice { amount currencyCode }
                }
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

const CALCULATE_RETURN_QUERY = `#graphql
  query CalculateCustomerReturn(
    $orderId: ID!
    $returnLineItems: [CalculateReturnLineItemInput!]!
  ) {
    returnCalculate(input: {
      orderId: $orderId
      returnLineItems: $returnLineItems
    }) {
      financialSummary {
        returnTotalSet { presentmentMoney { amount currencyCode } }
      }
      returnLineItems(first: 50) {
        nodes { lineItem { id } quantity }
      }
    }
  }
`;

const REQUEST_RETURN_MUTATION = `#graphql
  mutation RequestCustomerReturn(
    $orderId: ID!
    $requestedLineItems: [RequestedLineItemInput!]!
  ) {
    orderRequestReturn(
      orderId: $orderId
      requestedLineItems: $requestedLineItems
    ) {
      return { id status }
      userErrors { field message }
    }
  }
`;

const APPROVE_RETURN_MUTATION = `#graphql
  mutation ApproveReturnRequest($input: ReturnApproveRequestInput!) {
    returnApproveRequest(input: $input) {
      return { id status order { id } }
      userErrors { field message }
    }
  }
`;

const SUGGESTED_REFUND_QUERY = `#graphql
  query SuggestedRefund(
    $orderId: ID!
    $refundLineItems: [RefundLineItemInput!]!
  ) {
    order(id: $orderId) {
      suggestedRefund(refundLineItems: $refundLineItems) {
        amountSet { presentmentMoney { amount currencyCode } }
        suggestedTransactions {
          amountSet { presentmentMoney { amount currencyCode } }
          gateway
          kind
          parentTransaction { id }
        }
      }
    }
  }
`;

const CREATE_REFUND_MUTATION = `#graphql
  mutation CreateAutomaticRefund($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
      refund {
        id
        totalRefundedSet { presentmentMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

function throwOnUserErrors(errors: UserError[], action: string) {
  if (!errors.length) return;
  throw new Error(
    `${action}: ${errors.map((error) => error.message).join("; ")}`,
  );
}

function customerHash(customerId: string) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET is required for customer identity hashing.");
  }
  return createHmac("sha256", secret).update(customerId).digest("hex");
}

function moneyIsAbove(amount: string, maximum: string) {
  const value = Number(amount);
  const limit = Number(maximum);
  return !Number.isFinite(value) || !Number.isFinite(limit) || value > limit;
}

function sameItems(left: unknown, right: RequestedItem[]) {
  const normalize = (items: RequestedItem[]) =>
    [...items].sort((a, b) =>
      a.lineItemId === b.lineItemId
        ? a.quantity - b.quantity
        : a.lineItemId.localeCompare(b.lineItemId),
    );

  if (!Array.isArray(left)) return false;
  return (
    JSON.stringify(normalize(left as RequestedItem[])) ===
    JSON.stringify(normalize(right))
  );
}

export async function getReturnableOrders(
  shop: string,
  customerToken: string,
) {
  const result = await customerAccountGraphql<CustomerOrdersResponse>(
    shop,
    customerToken,
    CUSTOMER_ORDERS_QUERY,
    { first: 20 },
  );

  return {
    customerId: result.customer.id,
    orders: result.customer.orders.nodes,
  };
}

export async function calculateReturn(
  shop: string,
  customerToken: string,
  orderId: string,
  items: RequestedItem[],
) {
  const result = await customerAccountGraphql<ReturnCalculationResponse>(
    shop,
    customerToken,
    CALCULATE_RETURN_QUERY,
    { orderId, returnLineItems: items },
  );

  return result.returnCalculate;
}

export async function executeAutomaticReturn({
  shop,
  customerToken,
  orderId,
  items,
  customerNote,
  idempotencyKey,
}: {
  shop: string;
  customerToken: string;
  orderId: string;
  items: RequestedItem[];
  customerNote?: string;
  idempotencyKey: string;
}) {
  const policy = await prisma.storePolicy.findUnique({ where: { shop } });
  if (!policy?.automaticRefundsEnabled) {
    throw new Error(
      "Automatic refunds are not enabled for this store. No return or refund was created.",
    );
  }

  const { customerId, orders } = await getReturnableOrders(shop, customerToken);
  const subjectHash = customerHash(customerId);
  const existing = await prisma.agentReturn.findUnique({
    where: { shop_idempotencyKey: { shop, idempotencyKey } },
  });
  if (existing) {
    if (
      existing.customerSubjectHash !== subjectHash ||
      existing.orderId !== orderId ||
      !sameItems(existing.requestedLineItems, items)
    ) {
      throw new Error(
        "This idempotency key belongs to a different customer return request.",
      );
    }
    return existing;
  }

  const order = orders.find((candidate) => candidate.id === orderId);
  if (!order) {
    throw new Error(
      "That order is not available in the authenticated customer's account.",
    );
  }

  const ageInDays =
    (Date.now() - new Date(order.processedAt).getTime()) / 86_400_000;
  if (ageInDays > policy.returnWindowDays) {
    throw new Error(
      `This order is outside the store's ${policy.returnWindowDays}-day return window.`,
    );
  }

  const returnable = new Map(
    order.returnInformation.returnableLineItems.nodes.map((entry) => [
      entry.lineItem.id,
      entry.quantity,
    ]),
  );
  if (new Set(items.map((item) => item.lineItemId)).size !== items.length) {
    throw new Error("Each line item can appear only once in a return request.");
  }
  for (const item of items) {
    const available = returnable.get(item.lineItemId) ?? 0;
    if (item.quantity < 1 || item.quantity > available) {
      throw new Error(
        "One or more requested quantities are not currently returnable.",
      );
    }
  }

  const calculation = await calculateReturn(shop, customerToken, orderId, items);
  const quote = calculation.financialSummary.returnTotalSet.presentmentMoney;
  if (quote.currencyCode !== policy.currencyCode) {
    throw new Error(
      `Automatic refunds are currently limited to ${policy.currencyCode} orders.`,
    );
  }
  if (moneyIsAbove(quote.amount, policy.maxAutoRefundAmount)) {
    throw new Error(
      `The ${quote.amount} ${quote.currencyCode} refund exceeds this store's automatic refund limit.`,
    );
  }

  let record;
  try {
    record = await prisma.agentReturn.create({
      data: {
        shop,
        orderId,
        orderName: order.name,
        idempotencyKey,
        requestedLineItems: items,
        customerSubjectHash: subjectHash,
        amount: quote.amount,
        currencyCode: quote.currencyCode,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const concurrent = await prisma.agentReturn.findUnique({
        where: { shop_idempotencyKey: { shop, idempotencyKey } },
      });
      if (
        concurrent?.customerSubjectHash === subjectHash &&
        concurrent.orderId === orderId &&
        sameItems(concurrent.requestedLineItems, items)
      ) {
        return concurrent;
      }
    }
    throw error;
  }

  try {
    const requestResult = await customerAccountGraphql<{
      orderRequestReturn: {
        return: { id: string; status: string } | null;
        userErrors: UserError[];
      };
    }>(shop, customerToken, REQUEST_RETURN_MUTATION, {
      orderId,
      requestedLineItems: items.map((item) => ({
        ...item,
        customerNote: customerNote?.slice(0, 300),
      })),
    });
    throwOnUserErrors(
      requestResult.orderRequestReturn.userErrors,
      "Shopify could not request the return",
    );
    const returnId = requestResult.orderRequestReturn.return?.id;
    if (!returnId) throw new Error("Shopify did not create a return.");

    await prisma.agentReturn.update({
      where: { id: record.id },
      data: { returnId, status: "RETURN_REQUESTED" },
    });

    const { admin } = await unauthenticated.admin(shop);
    const approvalResponse = await admin.graphql(APPROVE_RETURN_MUTATION, {
      variables: { input: { returnId } },
    });
    const approvalResult = (await approvalResponse.json()) as {
      data?: {
        returnApproveRequest: {
          return: { id: string; status: string; order: { id: string } } | null;
          userErrors: UserError[];
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (!approvalResult.data || approvalResult.errors?.length) {
      throw new Error(
        approvalResult.errors?.map((error) => error.message).join("; ") ||
          "Shopify could not approve the return.",
      );
    }
    throwOnUserErrors(
      approvalResult.data.returnApproveRequest.userErrors,
      "Shopify could not approve the return",
    );

    await prisma.agentReturn.update({
      where: { id: record.id },
      data: { status: "RETURN_OPEN" },
    });

    const refundLineItems = items.map((item) => ({
      lineItemId: item.lineItemId,
      quantity: item.quantity,
    }));
    const suggestionResponse = await admin.graphql(SUGGESTED_REFUND_QUERY, {
      variables: { orderId, refundLineItems },
    });
    const suggestionResult = (await suggestionResponse.json()) as {
      data?: {
        order: {
          suggestedRefund: {
            amountSet: { presentmentMoney: Money };
            suggestedTransactions: Array<{
              amountSet: { presentmentMoney: Money };
              gateway: string;
              kind: string;
              parentTransaction: { id: string } | null;
            }>;
          } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    const suggestion = suggestionResult.data?.order?.suggestedRefund;
    if (!suggestion || suggestionResult.errors?.length) {
      throw new Error(
        suggestionResult.errors?.map((error) => error.message).join("; ") ||
          "Shopify could not calculate the payment refund.",
      );
    }

    if (
      Number(suggestion.amountSet.presentmentMoney.amount) !==
        Number(quote.amount) ||
      suggestion.amountSet.presentmentMoney.currencyCode !== quote.currencyCode
    ) {
      throw new Error(
        "The refund amount changed after confirmation. The return is open, but no refund was issued.",
      );
    }

    const transactions = suggestion.suggestedTransactions.map((transaction) => ({
      amount: transaction.amountSet.presentmentMoney.amount,
      gateway: transaction.gateway,
      kind: transaction.kind,
      orderId,
      parentId: transaction.parentTransaction?.id,
    }));
    if (!transactions.length || transactions.some((item) => !item.parentId)) {
      throw new Error(
        "Shopify could not identify the original payment transaction. The return is open, but no refund was issued.",
      );
    }

    const refundResponse = await admin.graphql(CREATE_REFUND_MUTATION, {
      variables: {
        idempotencyKey,
        input: {
          orderId,
          notify: true,
          note: "Customer-confirmed automatic return",
          currency: quote.currencyCode,
          refundLineItems,
          transactions,
        },
      },
    });
    const refundResult = (await refundResponse.json()) as {
      data?: {
        refundCreate: {
          refund: { id: string } | null;
          userErrors: UserError[];
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (!refundResult.data || refundResult.errors?.length) {
      throw new Error(
        refundResult.errors?.map((error) => error.message).join("; ") ||
          "Shopify could not create the refund.",
      );
    }
    throwOnUserErrors(
      refundResult.data.refundCreate.userErrors,
      "Shopify could not create the refund",
    );
    const refundId = refundResult.data.refundCreate.refund?.id;
    if (!refundId) throw new Error("Shopify did not create a refund.");

    return prisma.agentReturn.update({
      where: { id: record.id },
      data: { refundId, status: "REFUND_SUBMITTED" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown automatic return error.";
    await prisma.agentReturn.update({
      where: { id: record.id },
      data: { status: "NEEDS_ATTENTION", failureReason: message.slice(0, 1_000) },
    });
    throw error;
  }
}
