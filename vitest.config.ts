import { defineConfig } from "vitest/config";

export default defineConfig({ test: { globalSetup: ["test/global-setup.ts"], testTimeout: 15_000, hookTimeout: 10_000 } });
