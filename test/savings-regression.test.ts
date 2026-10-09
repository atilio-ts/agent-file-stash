import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createStash } from "filestash-sdk";
import type { StashStats } from "filestash-sdk";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolDefinitionTokens, formatStatus } from "../packages/cli/src/mcp.js";

const MAX_DEFINITION_TOKENS = 300;
const MIN_SAVINGS_RATIO = 0.65;

let dir: string;
let counter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "filestash-savings-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const id = ++counter;
  const { stash, watcher } = createStash({ dbPath: join(dir, `t${id}.db`), sessionId: `s${id}` });
  const write = (name: string, content: string) => {
    const path = join(dir, `${id}-${name}`);
    writeFileSync(path, content);
    return path;
  };
  const close = async () => {
    watcher.close();
    await stash.close();
  };
  return { stash, write, close };
}

const body = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `export const value${i} = compute(${i}, "${tag}");`).join("\n");

function expectIdentity(stats: StashStats) {
  expect(stats.sessionTokensSaved).toBe(stats.sessionBaselineTokens - stats.sessionSentTokens);
  expect(stats.sessionSentTokens).toBeLessThanOrEqual(stats.sessionBaselineTokens);
}

describe("session accounting identity", () => {
  test("holds across first, unchanged, diff, guard, partial, excluded and force reads", async () => {
    const { stash, write, close } = setup();
    try {
      const a = write("a.ts", body(100));
      const tiny = write("tiny.ts", "x\n");
      const swapped = write("swapped.ts", body(60));
      const env = write(".env", "SECRET=1\nOTHER=2\n");

      await stash.readFile(a);
      await stash.readFile(a);
      expectIdentity(await stash.getStats());

      writeFileSync(a, body(100).replace("value5 ", "value5x "));
      await stash.readFile(a);
      expectIdentity(await stash.getStats());

      await stash.readFile(a, { offset: 10, limit: 20 });
      await stash.readFile(a, { offset: 10, limit: 20 });
      writeFileSync(a, body(100).replace("value90 ", "value90x "));
      await stash.readFile(a, { offset: 10, limit: 20 });
      await stash.readFile(a, { offset: 85, limit: 10 });
      expectIdentity(await stash.getStats());

      await stash.readFile(tiny);
      await stash.readFile(tiny);
      await stash.readFile(swapped);
      writeFileSync(swapped, body(60, "completely-different"));
      await stash.readFile(swapped);
      expectIdentity(await stash.getStats());

      await stash.readFile(env);
      await stash.readFile(env);
      await stash.readFileFull(a);
      await stash.readFileFull(env);

      const stats = await stash.getStats();
      expectIdentity(stats);
      expect(stats.sessionReads).toBe(15);
      expect(stats.sessionTokensSaved).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  test("excluded and forced reads record baseline equal to sent", async () => {
    const { stash, write, close } = setup();
    try {
      const env = write(".env", "SECRET=1\n");
      const f = write("f.ts", body(30));
      await stash.readFile(env);
      await stash.readFileFull(f);
      const stats = await stash.getStats();
      expect(stats.sessionReads).toBe(2);
      expect(stats.sessionBaselineTokens).toBe(stats.sessionSentTokens);
      expect(stats.sessionBaselineTokens).toBeGreaterThan(0);
      expect(stats.sessionTokensSaved).toBe(0);
      expect(stats.tokensSaved).toBe(0);
    } finally {
      await close();
    }
  });

  test("the saved figure in an unchanged label matches the real saving", async () => {
    const { stash, write, close } = setup();
    try {
      const f = write("f.ts", body(120));
      const first = await stash.readFile(f);
      const before = await stash.getStats();
      const again = await stash.readFile(f);
      const after = await stash.getStats();
      const labelled = Number(/(\d+) tokens saved/.exec(again.content)?.[1]);
      const realSaving = after.sessionTokensSaved - before.sessionTokensSaved;
      expect(first.stashed).toBe(false);
      expect(Math.abs(labelled - realSaving)).toBeLessThanOrEqual(1);
      expect(labelled).toBeLessThan(Math.ceil(first.content.length / 4));
    } finally {
      await close();
    }
  });
});

describe("savings regression workload", () => {
  test("gross saving ratio stays above the threshold", async () => {
    const { stash, write, close } = setup();
    try {
      const files = Array.from({ length: 20 }, (_, i) => ({ path: write(`w${i}.ts`, body(200, `f${i}`)), i }));
      const edit = (pass: number) => {
        for (const { path, i } of files.slice(0, 4)) {
          writeFileSync(path, body(200, `f${i}`).replace("value50 ", `value50p${pass} `));
        }
      };

      for (const { path } of files) await stash.readFile(path);
      for (let pass = 1; pass <= 3; pass++) {
        if (pass > 1) edit(pass);
        for (const { path } of files) await stash.readFile(path);
        await stash.readFile(files[5]!.path, { offset: 100, limit: 30 });
        await stash.readFile(files[0]!.path, { offset: 100, limit: 30 });
      }

      const stats = await stash.getStats();
      expectIdentity(stats);
      const ratio = stats.sessionTokensSaved / stats.sessionBaselineTokens;
      expect(ratio).toBeGreaterThan(MIN_SAVINGS_RATIO);
    } finally {
      await close();
    }
  });
});

describe("tool definition overhead", () => {
  test("estimate is positive and within the recorded upper bound", () => {
    const tokens = toolDefinitionTokens();
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(MAX_DEFINITION_TOKENS);
  });

  test("status output reports net savings, negative included, labelled est.", () => {
    const stats: StashStats = {
      filesTracked: 2,
      tokensSaved: 10,
      sessionTokensSaved: 10,
      sessionReads: 3,
      sessionBaselineTokens: 40,
      sessionSentTokens: 30,
      lifetimeSessions: 0,
      lifetimeReads: 0,
      lifetimeBaselineTokens: 0,
      lifetimeSentTokens: 0,
      lifetimeOverheadTokens: 0,
      degraded: false,
    };
    const text = formatStatus(stats, 100);
    expect(text).toContain("Files tracked: 2");
    expect(text).toContain("This session: 3 reads");
    expect(text).toContain("Would have sent (plain reads): ~40 tokens");
    expect(text).toContain("Actually sent: ~30 tokens");
    expect(text).toContain("Gross saved: ~10 tokens");
    expect(text).toContain("Tool definitions overhead: ~100 tokens (est.)");
    expect(text).toMatch(/Net saved: ~-90 tokens \(est\.\)/);
    expect(text).toContain("Gross saved (all sessions): ~10 tokens");
  });
});
