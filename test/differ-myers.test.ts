import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createStash, computeDiff } from "filestash-sdk";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp_test_differ_myers");
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
  const { stash, watcher } = createStash({
    dbPath: join(TEST_DIR, `t${id}.db`),
    sessionId: `s${id}`,
    maxLines: 100_000,
    maxChars: 10_000_000,
  });
  const file = join(TEST_DIR, `f${id}.txt`);
  const close = async () => {
    watcher.close();
    await stash.close();
  };
  return { stash, file, close };
}

function oracleLinesChanged(oldContent: string, newContent: string): number {
  const a = oldContent.split("\n");
  const b = newContent.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return a.length + b.length - 2 * dp[a.length]![b.length]!;
}

function applyDiff(oldContent: string, diff: string): string {
  const oldLines = oldContent.split("\n");
  if (diff === "") return oldContent;
  const out: string[] = [];
  let pos = 0;
  let cursor = 2;
  const diffLines = diff.split("\n");
  while (cursor < diffLines.length) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(diffLines[cursor]!);
    if (!header) throw new Error(`bad hunk header: ${diffLines[cursor]}`);
    cursor++;
    const oldStart = Number(header[1]);
    while (pos < oldStart - 1) out.push(oldLines[pos++]!);
    let oldCount = 0;
    let newCount = 0;
    while (cursor < diffLines.length && !diffLines[cursor]!.startsWith("@@ ")) {
      const line = diffLines[cursor]!;
      const text = line.slice(1);
      if (line[0] === " ") {
        if (oldLines[pos] !== text) throw new Error(`context mismatch at old line ${pos + 1}`);
        out.push(text); pos++; oldCount++; newCount++;
      } else if (line[0] === "-") {
        if (oldLines[pos] !== text) throw new Error(`remove mismatch at old line ${pos + 1}`);
        pos++; oldCount++;
      } else if (line[0] === "+") {
        out.push(text); newCount++;
      } else {
        throw new Error(`bad diff line: ${line}`);
      }
      cursor++;
    }
    expect(oldCount).toBe(Number(header[2]));
    expect(newCount).toBe(Number(header[4]));
  }
  while (pos < oldLines.length) out.push(oldLines[pos++]!);
  return out.join("\n");
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPair(rand: () => number): [string, string] {
  const pick = (n: number) => Math.floor(rand() * n);
  const alphabet = 2 + pick(8);
  const oldLines = Array.from({ length: pick(61) }, () => `l${pick(alphabet)}`);
  const next = [...oldLines];
  const edits = pick(12);
  for (let e = 0; e < edits; e++) {
    const at = pick(next.length + 1);
    const kind = pick(4);
    if (kind === 0) next.splice(at, 0, `l${pick(alphabet)}`);
    else if (kind === 1 && next.length > 0) next.splice(Math.min(at, next.length - 1), 1);
    else if (kind === 2 && next.length > 0) next[Math.min(at, next.length - 1)] = `m${pick(alphabet)}`;
    else if (next.length > 0) {
      const from = Math.min(at, next.length - 1);
      next.splice(at, 0, ...next.slice(from, from + 1 + pick(3)));
    }
  }
  return [oldLines.join("\n"), next.join("\n")];
}

const numbered = (n: number, prefix = "line number") => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

function scattered(lines: string[], count: number): string[] {
  const out = [...lines];
  for (let j = 0; j < count; j++) out[Math.floor(((j + 0.5) * lines.length) / count)] = `edited ${j}`;
  return out;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe("computeDiff against a reference LCS", () => {
  test("randomized inputs match the reference and the patch reproduces the new text", () => {
    const rand = mulberry32(0xc0ffee);
    for (let i = 0; i < 600; i++) {
      const [oldContent, newContent] = randomPair(rand);
      const result = computeDiff(oldContent, newContent, "f.ts");
      const expected = oracleLinesChanged(oldContent, newContent);
      expect(result.linesChanged, `case ${i}`).toBe(expected);
      expect(result.hasChanges, `case ${i}`).toBe(oldContent !== newContent);
      expect(applyDiff(oldContent, result.diff), `case ${i}`).toBe(newContent);
    }
  });

  test("changedNewLines are exactly the added lines of the new file", () => {
    const rand = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const [oldContent, newContent] = randomPair(rand);
      const result = computeDiff(oldContent, newContent, "f.ts");
      const newLines = newContent.split("\n");
      const added = result.diff.split("\n").slice(2).filter((l) => l.startsWith("+")).length;
      expect(result.changedNewLines.size, `case ${i}`).toBe(added);
      for (const n of result.changedNewLines) {
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(newLines.length);
      }
    }
  });
});

describe("computeDiff edge cases", () => {
  test("identical inputs report no changes", () => {
    const text = numbered(50).join("\n");
    const result = computeDiff(text, text, "f.ts");
    expect(result).toMatchObject({ diff: "", linesChanged: 0, hasChanges: false });
    expect(result.changedNewLines.size).toBe(0);
  });

  test("empty old content", () => {
    const result = computeDiff("", "a\nb", "f.ts");
    expect(result.hasChanges).toBe(true);
    expect(applyDiff("", result.diff)).toBe("a\nb");
    expect(result.linesChanged).toBe(oracleLinesChanged("", "a\nb"));
  });

  test("empty new content", () => {
    const result = computeDiff("a\nb", "", "f.ts");
    expect(result.hasChanges).toBe(true);
    expect(applyDiff("a\nb", result.diff)).toBe("");
    expect(result.changedNewLines.size).toBeLessThanOrEqual(1);
  });

  test("trailing newline differences", () => {
    for (const [a, b] of [["a\nb", "a\nb\n"], ["a\nb\n", "a\nb"], ["a\n", "a\n\n"]] as const) {
      const result = computeDiff(a, b, "f.ts");
      expect(result.hasChanges).toBe(true);
      expect(result.linesChanged).toBe(oracleLinesChanged(a, b));
      expect(applyDiff(a, result.diff)).toBe(b);
    }
  });

  test("CRLF content", () => {
    const a = "one\r\ntwo\r\nthree\r\nfour";
    const b = "one\r\nTWO\r\nthree\r\nfour\r\nfive";
    const result = computeDiff(a, b, "f.ts");
    expect(result.linesChanged).toBe(oracleLinesChanged(a, b));
    expect(applyDiff(a, result.diff)).toBe(b);
    const mixed = computeDiff("a\r\nb", "a\nb", "f.ts");
    expect(mixed.linesChanged).toBe(2);
  });

  test("one huge line", () => {
    const big = "x".repeat(1_000_000);
    const a = `head\n${big}\ntail`;
    const b = `head\n${big}y\ntail`;
    const result = computeDiff(a, b, "f.ts");
    expect(result.linesChanged).toBe(2);
    expect(applyDiff(a, result.diff)).toBe(b);
  });

  test("repeated identical lines", () => {
    const cases: [string[], string[]][] = [
      [["a", "a", "a", "a"], ["a", "a"]],
      [["a", "b", "a", "b", "a"], ["b", "a", "b"]],
      [["x", "x", "x", "y", "x", "x"], ["x", "y", "x", "x", "x", "x"]],
      [["", "", "a", "", ""], ["", "a", "", "", ""]],
    ];
    for (const [a, b] of cases) {
      const oldContent = a.join("\n");
      const newContent = b.join("\n");
      const result = computeDiff(oldContent, newContent, "f.ts");
      expect(result.linesChanged).toBe(oracleLinesChanged(oldContent, newContent));
      expect(applyDiff(oldContent, result.diff)).toBe(newContent);
    }
  });

  test("common prefix and suffix are kept out of the changes", () => {
    const a = [...numbered(100, "head"), "old1", "old2", ...numbered(100, "tail")];
    const b = [...numbered(100, "head"), "new1", ...numbered(100, "tail")];
    const result = computeDiff(a.join("\n"), b.join("\n"), "f.ts");
    expect(result.linesChanged).toBe(3);
    expect([...result.changedNewLines]).toEqual([101]);
    expect(result.diff).toContain("@@ -98,8 +98,7 @@");
  });

  test("change only at the start and only at the end", () => {
    const body = numbered(30);
    const start = computeDiff(body.join("\n"), ["first", ...body.slice(1)].join("\n"), "f.ts");
    expect(start.linesChanged).toBe(2);
    expect([...start.changedNewLines]).toEqual([1]);
    const end = computeDiff(body.join("\n"), [...body.slice(0, -1), "last"].join("\n"), "f.ts");
    expect(end.linesChanged).toBe(2);
    expect([...end.changedNewLines]).toEqual([30]);
  });
});

describe("unified diff format", () => {
  test("header, context and hunk grouping", () => {
    const a = numbered(40);
    const b = [...a];
    b[5] = "CHANGED A";
    b[30] = "CHANGED B";
    const result = computeDiff(a.join("\n"), b.join("\n"), "src/f.ts");
    expect(result.diff.split("\n")).toEqual([
      "--- a/src/f.ts",
      "+++ b/src/f.ts",
      "@@ -3,7 +3,7 @@",
      " line number 2",
      " line number 3",
      " line number 4",
      "+CHANGED A",
      "-line number 5",
      " line number 6",
      " line number 7",
      " line number 8",
      "@@ -28,7 +28,7 @@",
      " line number 27",
      " line number 28",
      " line number 29",
      "+CHANGED B",
      "-line number 30",
      " line number 31",
      " line number 32",
      " line number 33",
    ]);
  });

  test("nearby changes merge into one hunk", () => {
    const a = numbered(30);
    const b = [...a];
    b[10] = "X";
    b[16] = "Y";
    const result = computeDiff(a.join("\n"), b.join("\n"), "f.ts");
    expect(result.diff.split("\n").filter((l) => l.startsWith("@@"))).toEqual(["@@ -8,13 +8,13 @@"]);
  });
});

describe("edit distance cap", () => {
  test("a fully rewritten large file falls back to remove-all add-all quickly", () => {
    const a = numbered(20_000, "old");
    const b = numbered(20_000, "new");
    const { value, ms } = timed(() => computeDiff(a.join("\n"), b.join("\n"), "f.ts"));
    expect(value.linesChanged).toBe(40_000);
    expect(value.changedNewLines.size).toBe(20_000);
    expect(ms).toBeLessThan(1500);
  });

  test("the fallback keeps the common prefix and suffix", () => {
    const a = [...numbered(10, "head"), ...numbered(20_000, "old"), ...numbered(10, "tail")];
    const b = [...numbered(10, "head"), ...numbered(20_000, "new"), ...numbered(10, "tail")];
    const result = computeDiff(a.join("\n"), b.join("\n"), "f.ts");
    expect(result.linesChanged).toBe(40_000);
    expect(result.changedNewLines.has(10)).toBe(false);
    expect(result.changedNewLines.has(11)).toBe(true);
    expect(applyDiff(a.join("\n"), result.diff)).toBe(b.join("\n"));
  });

  test("a size difference above the cap falls back", () => {
    const a = numbered(100);
    const b = [...numbered(100), ...numbered(10_000, "extra")];
    const result = computeDiff(a.join("\n"), b.join("\n"), "f.ts");
    expect(result.linesChanged).toBe(10_000);
    expect(applyDiff(a.join("\n"), result.diff)).toBe(b.join("\n"));
  });

  test("the store returns full content when the fallback diff is not smaller", async () => {
    const { stash, file, close } = setup();
    try {
      writeFileSync(file, numbered(20_000, "old").join("\n"));
      await stash.readFile(file);
      const rewritten = numbered(20_000, "new").join("\n");
      writeFileSync(file, rewritten);

      const start = performance.now();
      const result = await stash.readFile(file);
      const ms = performance.now() - start;
      expect(result.stashed).toBe(false);
      expect(result.content).toBe(rewritten);
      expect("diff" in result).toBe(false);
      expect(ms).toBeLessThan(1500);
    } finally {
      await close();
    }
  });
});

describe("partial read contract", () => {
  test("a change outside the requested range is reported as elsewhere", async () => {
    const { stash, file, close } = setup();
    try {
      writeFileSync(file, numbered(1000).join("\n"));
      await stash.readFile(file);
      const lines = numbered(1000);
      lines[500] = "CHANGED";
      writeFileSync(file, lines.join("\n"));

      const result = await stash.readFile(file, { offset: 1, limit: 100 });
      expect(result.stashed).toBe(true);
      expect(result.content).toContain("unchanged in lines 1-100, changes elsewhere in file");
    } finally {
      await close();
    }
  });

  test("a change inside the requested range returns the lines", async () => {
    const { stash, file, close } = setup();
    try {
      const lines = numbered(1000);
      writeFileSync(file, lines.join("\n"));
      await stash.readFile(file);
      lines[500] = "CHANGED";
      writeFileSync(file, lines.join("\n"));

      const result = await stash.readFile(file, { offset: 495, limit: 10 });
      expect(result.stashed).toBe(false);
      expect(result.content).toContain("CHANGED");
    } finally {
      await close();
    }
  });

  test("a deletion before the range shifts lines without marking the range changed", () => {
    const a = numbered(50);
    const b = a.filter((_, i) => i !== 5);
    const result = computeDiff(a.join("\n"), b.join("\n"), "f.ts");
    expect(result.changedNewLines.size).toBe(0);
    expect(result.linesChanged).toBe(1);
  });
});

describe("speed", () => {
  test("100k lines with 10 scattered edits", () => {
    const a = numbered(100_000);
    const { value, ms } = timed(() => computeDiff(a.join("\n"), scattered(a, 10).join("\n"), "f.ts"));
    expect(value.linesChanged).toBe(20);
    expect(ms).toBeLessThan(1500);
  });

  test("100k lines with 1000 scattered edits", () => {
    const a = numbered(100_000);
    const b = scattered(a, 1000);
    const { value, ms } = timed(() => computeDiff(a.join("\n"), b.join("\n"), "f.ts"));
    expect(value.linesChanged).toBe(2000);
    expect(ms).toBeLessThan(1500);
  });

  test("100k lines with a 100-line insertion", () => {
    const a = numbered(100_000);
    const b = [...a.slice(0, 50_000), ...numbered(100, "ins"), ...a.slice(50_000)];
    const { value, ms } = timed(() => computeDiff(a.join("\n"), b.join("\n"), "f.ts"));
    expect(value.linesChanged).toBe(100);
    expect(ms).toBeLessThan(1500);
  });

  test("100k lines completely different", () => {
    const a = numbered(100_000, "old").join("\n");
    const b = numbered(100_000, "new").join("\n");
    const { value, ms } = timed(() => computeDiff(a, b, "f.ts"));
    expect(value.linesChanged).toBe(200_000);
    expect(ms).toBeLessThan(1500);
  });

  test("a 6000-line file with scattered edits yields a minimal diff", () => {
    const a = numbered(6000);
    const { value, ms } = timed(() => computeDiff(a.join("\n"), scattered(a, 3).join("\n"), "f.ts"));
    expect(value.linesChanged).toBe(6);
    expect(ms).toBeLessThan(1500);
  });
});
