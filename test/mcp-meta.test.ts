import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createStash } from "filestash-sdk";
import type { StashStore, FileWatcher } from "filestash-sdk";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp_test_mcp");
const DB_PATH = join(TEST_DIR, "test.db");
const FILE_PATH = join(TEST_DIR, "example.ts");
const FILE_PATH_2 = join(TEST_DIR, "example2.ts");

describe("MCP _meta field", () => {
  let stash: StashStore;
  let watcher: FileWatcher;
  let expectedNamespace: string;

  beforeAll(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(FILE_PATH, `function hello() {\n  console.log("hello world");\n}\n`);
    writeFileSync(FILE_PATH_2, `function goodbye() {\n  console.log("goodbye");\n}\n`);
    ({ stash, watcher } = createStash({ dbPath: DB_PATH, sessionId: "test-session-mcp" }));
    await stash.init();

    const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf-8"));
    expectedNamespace = (packageJson.mcpName || "io.github.glommer/filestash").replace(/\//g, ".");
  });

  afterAll(async () => {
    watcher.close();
    await stash.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("namespace reads from package.json mcpName", () => {
    expect(expectedNamespace).toBe("io.github.glommer.filestash");
  });

  test("_meta key format follows reverse DNS convention", () => {
    const metaKey = `${expectedNamespace}/files`;
    const parts = metaKey.split("/");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^io\.github/);
    expect(parts[1]).toBe("files");
  });

  test("_meta value is an array of file paths", async () => {
    const result = await stash.readFile(FILE_PATH);
    expect(result.hash).toBeTruthy();
    const metaKey = `${expectedNamespace}/files`;
    const meta: Record<string, string[]> = { [metaKey]: [FILE_PATH] };
    expect(Array.isArray(meta[metaKey])).toBe(true);
    expect(meta[metaKey]).toContain(FILE_PATH);
    expect(meta[metaKey]).toHaveLength(1);
  });

  test("unchanged file read is stashed and _meta key is stable", async () => {
    const first = await stash.readFile(FILE_PATH);
    expect(first.stashed).toBe(true);
    const second = await stash.readFile(FILE_PATH);
    expect(second.stashed).toBe(true);
    const metaKey = `${expectedNamespace}/files`;
    expect(metaKey).toMatch(/^io\.github\.\w+\.\w+\/files$/);
  });

  test("_meta with multiple files covers all paths", async () => {
    const r1 = await stash.readFile(FILE_PATH);
    const r2 = await stash.readFile(FILE_PATH_2);
    expect(r1.hash).toBeTruthy();
    expect(r2.hash).toBeTruthy();
    const metaKey = `${expectedNamespace}/files`;
    const meta: Record<string, string[]> = { [metaKey]: [FILE_PATH, FILE_PATH_2] };
    expect(meta[metaKey]).toHaveLength(2);
    expect(meta[metaKey]).toContain(FILE_PATH);
    expect(meta[metaKey]).toContain(FILE_PATH_2);
  });
});