import { Prisma } from "@prisma/client";

import prisma from "../db.server";

export async function processWebhookOnce({
  webhookId,
  shop,
  topic,
  process,
}: {
  webhookId: string;
  shop: string;
  topic: string;
  process: (transaction: Prisma.TransactionClient) => Promise<void>;
}) {
  try {
    return await prisma.$transaction(async (transaction) => {
      const duplicate = await transaction.webhookReceipt.findUnique({
        where: { id: webhookId },
        select: { id: true },
      });
      if (duplicate) return false;

      await process(transaction);
      await transaction.webhookReceipt.create({
        data: { id: webhookId, shop, topic },
      });
      return true;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    throw error;
  }
}
