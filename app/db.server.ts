import { PrismaClient } from "@prisma/client";
import { databaseUrlWithTls } from "./database-url.mjs";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

// Connections to a managed database must be encrypted in transit, and the
// connection string Render provides does not ask for that on its own.
// eslint-disable-next-line no-undef
const datasourceUrl = databaseUrlWithTls(process.env.DATABASE_URL);

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient({ datasourceUrl });
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient({ datasourceUrl });

export default prisma;
