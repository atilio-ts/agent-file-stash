import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "packages/cli/src/index.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  banner: { js: "#!/usr/bin/env node" },
  external: ["@modelcontextprotocol/sdk", "zod"],
  // tsup strips "node:" prefix by default; keep it so node:sqlite resolves correctly
  removeNodeProtocol: false,
  splitting: false,
  bundle: true,
  clean: true,
});