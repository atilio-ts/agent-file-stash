import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createStash } from "filestash-sdk";
import type { StashStore, FileWatcher } from "filestash-sdk";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp_test");
const DB_PATH = join(TEST_DIR, "test.db");
const FILE_PATH = join(TEST_DIR, "example.ts");
const LONG_FILE = join(TEST_DIR, "long.ts");

describe("smoke tests", () => {
  let stash: StashStore;
  let watcher: FileWatcher;
  let stash2: StashStore;
  let watcher2: FileWatcher;

  beforeAll(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(FILE_PATH, `function hello() {\n  console.log("hello world");\n}\n`);
    ({ stash, watcher } = createStash({ dbPath: DB_PATH, sessionId: "test-session-1" }));
    await stash.init();
  });

  afterAll(async () => {
    watcher.close();
    await stash.close();
    if (watcher2) watcher2.close();
    if (stash2) await stash2.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("first read returns full content", async () => {
    const r = await stash.readFile(FILE_PATH);
    expect(r.stashed).toBe(false);
    expect(r.totalLines).toBeGreaterThan(0);
    expect(r.content).toContain("hello world");
  });

  test("second read, no changes — stashed", async () => {
    const r = await stash.readFile(FILE_PATH);
    expect(r.stashed).toBe(true);
    if (!r.stashed) throw new Error("expected stashed result");
    expect(r.linesChanged).toBe(0);
  });

  test("modified file returns diff", async () => {
    writeFileSync(FILE_PATH, `function hello() {\n  console.log("hello filestash!");\n  return true;\n}\n`);
    const r = await stash.readFile(FILE_PATH);
    expect(r.stashed).toBe(true);
    if (!r.stashed) throw new Error("expected stashed result");
    expect(r.linesChanged).toBeGreaterThan(0);
    expect(r.diff).toBeTruthy();
  });

  test("stats reflect token savings", async () => {
    const stats = await stash.getStats();
    expect(stats.filesTracked).toBe(1);
    expect(stats.sessionTokensSaved).toBeGreaterThan(0);
    expect(stats.tokensSaved).toBeGreaterThan(0);
  });

  test("new session gets full content (no cross-session stash)", async () => {
    ({ stash: stash2, watcher: watcher2 } = createStash({ dbPath: DB_PATH, sessionId: "test-session-2" }));
    await stash2.init();
    const r = await stash2.readFile(FILE_PATH);
    expect(r.stashed).toBe(false);
  });

  test("same session second read is stashed", async () => {
    const r = await stash2.readFile(FILE_PATH);
    expect(r.stashed).toBe(true);
    if (!r.stashed) throw new Error("expected stashed result");
    expect(r.linesChanged).toBe(0);
  });

  test("partial read (offset/limit) — first read not stashed", async () => {
    const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: const x${i} = ${i};`).join("\n");
    writeFileSync(LONG_FILE, longContent);
    const r = await stash.readFile(LONG_FILE, { offset: 5, limit: 3 });
    expect(r.stashed).toBe(false);
    expect(r.content).toContain("line 5");
    expect(r.content).toContain("line 7");
    expect(r.content).not.toContain("line 8");
  });

  test("partial read, file unchanged — stashed", async () => {
    const r = await stash.readFile(LONG_FILE, { offset: 5, limit: 3 });
    expect(r.stashed).toBe(true);
    if (!r.stashed) throw new Error("expected stashed result");
    expect(r.linesChanged).toBe(0);
    expect(r.content).toContain("unchanged");
  });

  test("partial read, changes outside range — still stashed", async () => {
    const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: const x${i} = ${i};`).join("\n");
    const lines = longContent.split("\n");
    lines[0] = "line 1: MODIFIED";
    lines[18] = "line 19: MODIFIED";
    writeFileSync(LONG_FILE, lines.join("\n"));
    const r = await stash.readFile(LONG_FILE, { offset: 5, limit: 3 });
    expect(r.stashed).toBe(true);
    if (!r.stashed) throw new Error("expected stashed result");
    expect(r.linesChanged).toBe(0);
    expect(r.content).toContain("unchanged");
  });

  test("partial read, changes inside range — not stashed", async () => {
    const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: const x${i} = ${i};`).join("\n");
    const lines = longContent.split("\n");
    lines[0] = "line 1: MODIFIED";
    lines[18] = "line 19: MODIFIED";
    lines[5] = "line 6: MODIFIED_IN_RANGE";
    writeFileSync(LONG_FILE, lines.join("\n"));
    const r = await stash.readFile(LONG_FILE, { offset: 5, limit: 3 });
    expect(r.stashed).toBe(false);
    expect(r.content).toContain("MODIFIED_IN_RANGE");
  });
});