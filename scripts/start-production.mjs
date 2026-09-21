// Production entrypoint. Migrations and the server both open Postgres, so the
// TLS requirement is applied once, here, before either of them runs: the
// migration child process inherits the rewritten environment, and the server is
// imported into this process so signals from the platform still reach it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireDatabaseTls } from "../app/database-url.mjs";

const url = requireDatabaseTls(process.env);
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// The installed binary, rather than npx, so the container never needs a
// writable npm cache to run migrations.
const prisma = fileURLToPath(
  new URL("../node_modules/.bin/prisma", import.meta.url),
);
const migrate = spawnSync(prisma, ["migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
});
if (migrate.error) {
  console.error(migrate.error.message);
  process.exit(1);
}
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

await import("../build/http/index.js");
