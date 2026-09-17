import {
  fundedPaymentProvider,
} from "../app/services/funded-payment-intents.server";
import {
  describeFundedPaymentsCycle,
  runFundedPaymentsCycle,
} from "../app/services/funded-payments-worker.server";
import { fundedSandboxEnabled } from "../app/services/funded-return-sandbox.server";
import prisma from "../app/db.server";

// Development-only worker for the funded returns sandbox. It submits queued
// sandbox payments and reconciles unresolved ones on an interval. It never
// runs in production and never contacts a real payment provider.
if (!fundedSandboxEnabled()) {
  console.error(
    "Refusing to run: needs NODE_ENV=development or test and GOOPER_FUNDED_RETURNS_SANDBOX=1.",
  );
  process.exit(1);
}
const intervalMs = Math.max(
  5_000,
  Number(process.env.GOOPER_FUNDED_WORKER_INTERVAL_MS ?? 30_000),
);
const provider = fundedPaymentProvider();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });

console.log(
  `Funded payments sandbox worker: provider ${provider.name}, every ${intervalMs}ms. Ctrl+C to stop.`,
);
try {
  while (!stopping) {
    try {
      const cycle = await runFundedPaymentsCycle(provider);
      console.log(
        `${new Date().toISOString()} ${describeFundedPaymentsCycle(cycle)}`,
      );
    } catch (error) {
      // A failed cycle must not end the worker; the next pass retries.
      console.error(`${new Date().toISOString()} cycle failed:`, error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
} finally {
  await prisma.$disconnect();
}
