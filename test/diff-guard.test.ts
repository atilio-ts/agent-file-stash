import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createStash, computeDiff } from "filestash-sdk";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp_test_diff_guard");
let counter = 0;

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function setup() {
  const id = ++counter;
  const { stash, watcher } = createStash({ dbPath: join(TEST_DIR, `t${id}.db`), sessionId: `s${id}` });
  const file = join(TEST_DIR, `f${id}.txt`);
  const close = async () => {
    watcher.close();
    await stash.close();
  };
  return { stash, file, close };
}

const tokens = (text: string) => Math.ceil(text.length / 4);

function numberedLines(n: number, edits: number[] = []): string {
  return Array.from({ length: n }, (_, i) => (edits.includes(i) ? `edited line ${i}` : `line number ${i}`)).join("\n");
}

describe("diff size guard", () => {
  test("file above the LCS limit with scattered edits returns full content", async () => {
    const { stash, file, close } = setup();
    try {
      writeFileSync(file, numberedLines(6000));
      await stash.readFile(file);
      const edited = numberedLines(6000, [10, 2500, 5900]);
      writeFileSync(file, edited);

      const result = await stash.readFile(file);
      expect(result.stashed).toBe(false);
      expect(result.content).toBe(edited);
      expect("diff" in result).toBe(false);
      expect((await stash.getStats()).sessionTokensSaved).toBe(0);

      const next = await stash.readFile(file);
      expect(next.stashed).toBe(true);
      expect(next.content).toContain("unchanged");
    } finally {
      await close();
    }
  });

  test("small edit in a big file returns a diff and saves tokens", async () => {
    const { stash, file, close } = setup();
    try {
      writeFileSync(file, numberedLines(2000));
      await stash.readFile(file);
      const edited = numberedLines(2000, [1000]);
      writeFileSync(file, edited);

      const result = await stash.readFile(file);
      if (!result.stashed) throw new Error("expected stashed result");
      const stats = await stash.getStats();
      expect(stats.sessionTokensSaved).toBe(tokens(edited) - tokens(result.diff!));
      expect(stats.sessionTokensSaved).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  test("diff tokens equal to content tokens returns full content", async () => {
    const { stash, file, close } = setup();
    try {
      let original = "";
      let edited = "";
      for (let n = 1; n < 200; n++) {
        original = `${"x\n".repeat(n)}old`;
        edited = `${"x\n".repeat(n)}new`;
        if (tokens(computeDiff(original, edited, file).diff) === tokens(edited)) break;
      }
      expect(tokens(computeDiff(original, edited, file).diff)).toBe(tokens(edited));

      writeFileSync(file, original);
      await stash.readFile(file);
      writeFileSync(file, edited);

      const result = await stash.readFile(file);
      expect(result.stashed).toBe(false);
      expect(result.content).toBe(edited);
      expect((await stash.getStats()).sessionTokensSaved).toBe(0);
    } finally {
      await close();
    }
  });

  test("total rewrite of a small file returns full content", async () => {
    const { stash, file, close } = setup();
    try {
      writeFileSync(file, "alpha\nbeta\ngamma\n");
      await stash.readFile(file);
      const rewritten = "one\ntwo\nthree\n";
      writeFileSync(file, rewritten);

      const result = await stash.readFile(file);
      expect(result.stashed).toBe(false);
      expect(result.content).toBe(rewritten);
      expect((await stash.getStats()).sessionTokensSaved).toBe(0);
    } finally {
      await close();
    }
  });

  test("tokens saved never decreases and ignores full-content returns", async () => {
    const { stash, file, close } = setup();
    try {
      writeFileSync(file, numberedLines(2000));
      await stash.readFile(file);
      let last = (await stash.getStats()).tokensSaved;

      writeFileSync(file, numberedLines(2000, [5]));
      const diffRead = await stash.readFile(file);
      expect(diffRead.stashed).toBe(true);
      let now = (await stash.getStats()).tokensSaved;
      expect(now).toBeGreaterThan(last);
      last = now;

      writeFileSync(file, "completely\ndifferent\n");
      const fullRead = await stash.readFile(file);
      expect(fullRead.stashed).toBe(false);
      now = (await stash.getStats()).tokensSaved;
      expect(now).toBe(last);
      last = now;

      await stash.readFile(file);
      now = (await stash.getStats()).tokensSaved;
      expect(now).toBeGreaterThanOrEqual(last);
    } finally {
      await close();
    }
  });
});
