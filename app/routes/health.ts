import prisma from "../db.server";

export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.returnDraft.findFirst({ select: { id: true, intakeKeyHash: true } });
    await prisma.merchantDirectory.findFirst({ select: { discoveryPublished: true, aliases: true } });
    await prisma.merchantOpportunity.findFirst({ select: { id: true } });
    return Response.json(
      { status: "ok", release: "chat-return-handoff-v5", commit: process.env.RENDER_GIT_COMMIT || null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
