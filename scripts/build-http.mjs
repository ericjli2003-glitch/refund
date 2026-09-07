import { build } from "esbuild";
await build({
  entryPoints: ["server/index.ts"],
  outfile: "build/http/index.js",
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node22",
  format: "esm",
});
