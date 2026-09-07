import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Test-only imports must not broaden the storefront development server's access.
export default defineConfig({
  plugins: [tsconfigPaths()],
  server: { fs: { allow: ["app", "server", "tests", "node_modules"] } },
});
