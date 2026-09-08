import prisma from "../db.server";

export const loader = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.returnDraft.findFirst({ select: { id: true, intakeKeyHash: true } });
    return Response.json(
      { status: "ok", release: "durable-site-tools-v2", commit: process.env.RENDER_GIT_COMMIT || null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
