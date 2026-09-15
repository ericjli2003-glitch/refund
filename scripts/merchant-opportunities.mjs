import { PrismaClient } from "@prisma/client";

// Run only in the owner's trusted backend shell. Existing database credentials
// are the access boundary; never add this report to a merchant-facing route.
const prisma = new PrismaClient();
try {
  const records = await prisma.merchantOpportunity.findMany({
    where: { expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    take: 100,
    select: {
      merchantLabel: true,
      kind: true,
      knownShop: true,
      source: true,
      reviewStatus: true,
      firstSeenAt: true,
      lastSeenAt: true,
    },
  });
  console.log(
    "Private Gooper.io opportunities — unverified reports, not customer counts. No merchant outreach has been sent.",
  );
  console.table(records);
} finally {
  await prisma.$disconnect();
}
