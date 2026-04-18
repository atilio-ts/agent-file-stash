import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createCache } from "filestash-sdk";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp_test_errors");
const FILE_PATH = join(TEST_DIR, "sample.ts");

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(FILE_PATH, `const x = 1;\n`);
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("cache error paths", () => {
  test("readFile throws for non-existent file", async () => {
    const { cache, watcher } = createCache({ dbPath: join(TEST_DIR, "a.db"), sessionId: "s1" });
    try {
      await expect(cache.readFile(join(TEST_DIR, "ghost.ts"))).rejects.toThrow();
    } finally {
      watcher.close();
      await cache.close();
    }
  });

  test("clear() resets stats to zero", async () => {
    const { cache, watcher } = createCache({ dbPath: join(TEST_DIR, "b.db"), sessionId: "s2" });
    try {
      await cache.readFile(FILE_PATH); // first read — no tokens saved
      await cache.readFile(FILE_PATH); // second read — tokens saved (cached)
      const before = await cache.getStats();
      expect(before.sessionTokensSaved).toBeGreaterThan(0);

      await cache.clear();

      const after = await cache.getStats();
      expect(after.filesTracked).toBe(0);
      expect(after.tokensSaved).toBe(0);
      expect(after.sessionTokensSaved).toBe(0);
    } finally {
      watcher.close();
      await cache.close();
    }
  });

  test("onFileDeleted removes record — next read returns cached=false", async () => {
    const { cache, watcher } = createCache({ dbPath: join(TEST_DIR, "c.db"), sessionId: "s3" });
    try {
      await cache.readFile(FILE_PATH); // cache it
      await cache.onFileDeleted(FILE_PATH); // remove record
      const result = await cache.readFile(FILE_PATH); // should be a fresh read
      expect(result.cached).toBe(false);
    } finally {
      watcher.close();
      await cache.close();
    }
  });

  test("close() then readFile re-initializes and succeeds", async () => {
    const { cache, watcher } = createCache({ dbPath: join(TEST_DIR, "d.db"), sessionId: "s4" });
    try {
      await cache.readFile(FILE_PATH);
      await cache.close();
      const result = await cache.readFile(FILE_PATH); // re-init happens internally
      expect(result).toBeDefined();
    } finally {
      watcher.close();
      await cache.close();
    }
  });
});