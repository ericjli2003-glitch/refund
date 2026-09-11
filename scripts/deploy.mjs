import { spawn } from "node:child_process";
import { configureStorefront } from "./configure-storefront.mjs";

const args = process.argv.slice(2);
let config = process.env.SHOPIFY_FLAG_APP_CONFIG || "shopify.app.toml";
if (
  process.env.SHOPIFY_FLAG_PATH ||
  process.env.SHOPIFY_FLAG_CLIENT_ID ||
  args.some((arg) => ["--path", "--client-id"].includes(arg.split("=")[0]))
)
  throw new Error(
    "Run deployment from this app directory and select the app with --config, so generated URLs and the deployed app stay aligned.",
  );
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--config" || args[index] === "-c") {
    const value = args.splice(index, 2)[1];
    if (!value || value.startsWith("-"))
      throw new Error("Provide a Shopify app configuration after --config.");
    config = value;
    index--;
  } else if (
    args[index].startsWith("--config=") ||
    args[index].startsWith("-c=")
  ) {
    config = args.splice(index, 1)[0].split("=").slice(1).join("=");
    if (!config)
      throw new Error("Provide a Shopify app configuration after --config.");
    index--;
  } else if (args[index].startsWith("-c") && !args[index].startsWith("--")) {
    throw new Error(
      "Use --config staging or -c staging to select an app configuration.",
    );
  }
}
const path = config.endsWith(".toml") ? config : `shopify.app.${config}.toml`;
await configureStorefront(path);
// Pin the same configuration used above; never rely on a cached CLI selection.
const child = spawn("shopify", ["app", "deploy", ...args, "--config", path], {
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
