import { describe, test, expect, afterAll } from "vitest";
import { createStash, HARD_MAX_READ_BYTES, DEFAULT_MAX_LINES, DEFAULT_MAX_CHARS } from "filestash-sdk";
import type { StashConfig } from "filestash-sdk";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, cleanupAll, count, createSandbox, isAlive, query, startServer } from "./helpers/mcp.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "filestash-limits-")));
let counter = 0;

afterAll(async () => {
  await cleanupAll();
  rmSync(ROOT, { recursive: true, force: true });
});

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");
const tokens = (text: string) => Math.ceil(text.length / 4);
const notice = (a: number, b: number, n: number) => `[filestash: truncated, showing lines ${a}-${b} of ${n}; continue with offset=${b + 1}]`;

function setup(config: Partial<StashConfig> = {}) {
  const id = ++counter;
  const dir = join(ROOT, `case${id}`);
  mkdirSync(dir);
  const dbPath = join(dir, "stash.db");
  const { stash, watcher } = createStash({ dbPath, sessionId: `s${id}`, quiet: true, ...config });
  const write = (name: string, content: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  const close = async () => {
    watcher.close();
    await stash.close();
  };
  return { stash, dbPath, dir, write, close };
}

function ranges(dbPath: string): [number, number][] {
  return query<{ start_line: number; end_line: number }>(dbPath, "SELECT start_line, end_line FROM session_ranges ORDER BY start_line").map(
    (r) => [r.start_line, r.end_line],
  );
}

function expectNothingStored(dbPath: string) {
  for (const table of ["file_versions", "session_reads", "session_ranges"]) {
    expect(count(dbPath, `SELECT COUNT(*) FROM ${table}`), table).toBe(0);
  }
}

describe("line and character caps", () => {
  test("defaults are 2000 lines and 100000 characters", () => {
    expect(DEFAULT_MAX_LINES).toBe(2000);
    expect(DEFAULT_MAX_CHARS).toBe(100_000);
  });

  test("line cap cuts at the line boundary, records only the delivered lines and paginates", async () => {
    const { stash, dbPath, write, close } = setup({ maxLines: 10 });
    try {
      const file = write("f.txt", lines(50));
      const first = await stash.readFile(file);
      expect(first.stashed).toBe(false);
      expect(first.content).toBe(`${lines(10)}\n${notice(1, 10, 50)}`);
      expect(first.totalLines).toBe(50);
      expect(ranges(dbPath)).toEqual([[1, 10]]);

      const second = await stash.readFile(file, { offset: 11 });
      expect(second.stashed).toBe(false);
      expect(second.content.startsWith("line 11\nline 12")).toBe(true);
      expect(second.content.endsWith(notice(11, 20, 50))).toBe(true);
      expect(ranges(dbPath)).toEqual([[1, 20]]);

      const repeat = await stash.readFile(file);
      expect(repeat.stashed).toBe(true);
      expect(repeat.content).toContain("[filestash: unchanged, lines 1-10 of 50");

      for (const offset of [21, 31]) await stash.readFile(file, { offset });
      const last = await stash.readFile(file, { offset: 41 });
      expect(last.content).toBe(lines(50).split("\n").slice(40).join("\n"));
      expect(ranges(dbPath)).toEqual([[1, 50]]);

      const whole = await stash.readFile(file);
      expect(whole.stashed).toBe(true);
      expect(whole.content).toContain("unchanged");
      const stats = await stash.getStats();
      expect(stats.sessionTokensSaved).toBe(stats.sessionBaselineTokens - stats.sessionSentTokens);
      expect(stats.sessionSentTokens).toBeLessThanOrEqual(stats.sessionBaselineTokens);
    } finally {
      await close();
    }
  });

  test("character cap cuts at a line boundary", async () => {
    const { stash, dbPath, write, close } = setup({ maxChars: 55 });
    try {
      const file = write("f.txt", Array.from({ length: 30 }, () => "abcdefgh9").join("\n"));
      const res = await stash.readFile(file);
      expect(res.content).toBe(`${Array.from({ length: 5 }, () => "abcdefgh9").join("\n")}\n${notice(1, 5, 30)}`);
      expect(ranges(dbPath)).toEqual([[1, 5]]);
      const next = await stash.readFile(file, { offset: 6 });
      expect(next.stashed).toBe(false);
      expect(next.content.endsWith(notice(6, 10, 30))).toBe(true);
    } finally {
      await close();
    }
  });

  test("a single huge line is cut at maxChars and the notice names the next line", async () => {
    const { stash, dbPath, write, close } = setup({ maxChars: 100 });
    try {
      const file = write("f.txt", `short\n${"x".repeat(500)}\nafter`);
      const huge = await stash.readFile(file, { offset: 2 });
      const expected = `${"x".repeat(100)}\n[filestash: truncated, showing the first 100 chars of line 2 of 3; continue with offset=3]`;
      expect(huge.content).toBe(expected);
      expect(ranges(dbPath)).toEqual([]);
      const again = await stash.readFile(file, { offset: 2 });
      expect(again.stashed).toBe(false);
      expect(again.content).toBe(expected);
      const next = await stash.readFile(file, { offset: 3 });
      expect(next.content).toBe("after");
      const whole = await stash.readFile(file);
      expect(whole.content).toBe(`short\n${notice(1, 1, 3)}`);
    } finally {
      await close();
    }
  });

  test("an explicit limit above the cap is capped; one below it is not truncated", async () => {
    const { stash, write, close } = setup({ maxLines: 10 });
    try {
      const file = write("f.txt", lines(50));
      const big = await stash.readFile(file, { offset: 5, limit: 500 });
      expect(big.content).toBe(`${lines(50).split("\n").slice(4, 14).join("\n")}\n${notice(5, 14, 50)}`);
      const small = await stash.readFile(file, { offset: 5, limit: 3 });
      expect(small.content).toBe("line 5\nline 6\nline 7");
    } finally {
      await close();
    }
  });

  test("the default caps apply when nothing is configured", async () => {
    const { stash, write, close } = setup();
    try {
      const file = write("f.txt", lines(2500));
      const res = await stash.readFile(file);
      expect(res.content.endsWith(notice(1, 2000, 2500))).toBe(true);
      const wide = write("w.txt", `${"y".repeat(60)}\n`.repeat(3000));
      const wideRes = await stash.readFile(wide);
      expect(wideRes.content.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS + 120);
      expect(wideRes.content).toMatch(/\[filestash: truncated, showing lines 1-\d+ of 3001; continue with offset=\d+\]$/);
    } finally {
      await close();
    }
  });

  test("an excluded secret file is capped and never stored", async () => {
    const { stash, dbPath, write, close } = setup({ maxLines: 3 });
    try {
      const env = write(".env", lines(10, "KEY"));
      const res = await stash.readFile(env);
      expect(res.content).toBe(`${lines(3, "KEY")}\n${notice(1, 3, 10)}`);
      expectNothingStored(dbPath);
      const stats = await stash.getStats();
      expect(stats.sessionBaselineTokens).toBe(stats.sessionSentTokens);
      expect(stats.sessionBaselineTokens).toBe(tokens(res.content));
    } finally {
      await close();
    }
  });

  test("degraded mode caps plain reads and force reads", async () => {
    const root = join(ROOT, "degraded");
    mkdirSync(root);
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory");
    const file = join(root, "f.txt");
    writeFileSync(file, lines(40));
    const { stash, watcher } = createStash({ dbPath: join(blocker, "sub", "stash.db"), sessionId: "d1", quiet: true, maxLines: 5 });
    try {
      const plain = await stash.readFile(file);
      expect(plain.content).toBe(`${lines(5)}\n${notice(1, 5, 40)}`);
      const slice = await stash.readFile(file, { offset: 10, limit: 100 });
      expect(slice.content.endsWith(notice(10, 14, 40))).toBe(true);
      const full = await stash.readFileFull(file);
      expect(full.content).toBe(plain.content);
      expect(stash.isDegraded).toBe(true);
    } finally {
      watcher.close();
      await stash.close();
    }
  });

  test("force reads are capped, tracked by the delivered lines and continue with offset", async () => {
    const { stash, dbPath, write, close } = setup({ maxLines: 10 });
    try {
      const file = write("f.txt", lines(50));
      const forced = await stash.readFileFull(file);
      expect(forced.content).toBe(`${lines(10)}\n${notice(1, 10, 50)}`);
      expect(ranges(dbPath)).toEqual([[1, 10]]);
      const next = await stash.readFile(file, { offset: 11 });
      expect(next.stashed).toBe(false);
      expect(next.content.startsWith("line 11")).toBe(true);
      const stats = await stash.getStats();
      expect(stats.sessionBaselineTokens).toBe(stats.sessionSentTokens);
    } finally {
      await close();
    }
  });

  test("invalid programmatic limits fall back to the defaults", async () => {
    const { stash, write, close } = setup({ maxLines: 0, maxChars: -5 });
    try {
      const file = write("f.txt", lines(2100));
      expect((await stash.readFile(file)).content.endsWith(notice(1, 2000, 2100))).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("accounting with caps", () => {
  test("baseline is the capped slice with its notice and savings are never inflated", async () => {
    const { stash, write, close } = setup({ maxLines: 10 });
    try {
      const file = write("f.txt", lines(1000));
      const first = await stash.readFile(file);
      const cappedTokens = tokens(first.content);
      let stats = await stash.getStats();
      expect(stats.sessionBaselineTokens).toBe(cappedTokens);
      expect(stats.sessionSentTokens).toBe(cappedTokens);
      expect(stats.sessionTokensSaved).toBe(0);

      await stash.readFile(file);
      stats = await stash.getStats();
      expect(stats.sessionBaselineTokens).toBe(cappedTokens * 2);
      expect(stats.sessionSentTokens).toBeLessThan(stats.sessionBaselineTokens);
      expect(stats.sessionTokensSaved).toBe(stats.sessionBaselineTokens - stats.sessionSentTokens);
      expect(stats.sessionTokensSaved).toBeLessThan(cappedTokens);
    } finally {
      await close();
    }
  });
});

describe("binary files", () => {
  test("a NUL in the first 8 KB is shown as a notice and nothing is stored", async () => {
    const { stash, dbPath, write, close } = setup();
    try {
      const bin = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(10), Buffer.from("tail\nsecond line")]);
      const file = write("data.bin", bin);
      const expected = `[filestash: binary file (${bin.length} bytes), not shown]`;
      const plain = await stash.readFile(file);
      expect(plain).toMatchObject({ stashed: false, content: expected, totalLines: 2 });
      expect(plain.hash).toHaveLength(16);
      expect((await stash.readFile(file, { offset: 2, limit: 1 })).content).toBe(expected);
      expect((await stash.readFileFull(file)).content).toBe(expected);
      expectNothingStored(dbPath);
      const stats = await stash.getStats();
      expect(stats.sessionBaselineTokens).toBe(stats.sessionSentTokens);
      expect(stats.sessionTokensSaved).toBe(0);
      expect(stats.filesTracked).toBe(0);
    } finally {
      await close();
    }
  });

  test("a NUL beyond the first 8192 characters is not detected", async () => {
    const { stash, dbPath, write, close } = setup();
    try {
      const content = `${"a".repeat(9000)}\u0000tail`;
      const file = write("late.txt", content);
      const res = await stash.readFile(file);
      expect(res.content).toBe(content);
      expect(count(dbPath, "SELECT COUNT(*) FROM file_versions")).toBe(1);
    } finally {
      await close();
    }
  });
});

describe("size guards", () => {
  test("a file above maxStoreBytes is served capped and never stored", async () => {
    const { stash, dbPath, write, close } = setup({ maxStoreBytes: 1000, maxLines: 10 });
    try {
      const file = write("big.txt", lines(500));
      const first = await stash.readFile(file);
      expect(first.content).toBe(`${lines(10)}\n${notice(1, 10, 500)}`);
      const second = await stash.readFile(file);
      expect(second).toMatchObject({ stashed: false, content: first.content });
      const forced = await stash.readFileFull(file);
      expect(forced.content).toBe(first.content);
      expectNothingStored(dbPath);
      const stats = await stash.getStats();
      expect(stats.sessionReads).toBe(3);
      expect(stats.sessionBaselineTokens).toBe(stats.sessionSentTokens);
      expect(stats.tokensSaved).toBe(0);
    } finally {
      await close();
    }
  });

  test("a file at the limit is still stored", async () => {
    const { stash, dbPath, write, close } = setup({ maxStoreBytes: 1000 });
    try {
      const file = write("edge.txt", "a".repeat(1000));
      await stash.readFile(file);
      expect(count(dbPath, "SELECT COUNT(*) FROM file_versions")).toBe(1);
    } finally {
      await close();
    }
  });

  test("a file above 64 MiB is not read and touches no table", async () => {
    const { stash, dbPath, write, close } = setup();
    try {
      const file = write("huge.dat", "");
      truncateSync(file, HARD_MAX_READ_BYTES + 1);
      const size = statSync(file).size;
      const started = Date.now();
      const expected = `[filestash: file too large (${size} bytes); not read]`;
      expect((await stash.readFile(file)).content).toBe(expected);
      expect((await stash.readFile(file, { offset: 5, limit: 5 })).content).toBe(expected);
      expect((await stash.readFileFull(file)).content).toBe(expected);
      expect(Date.now() - started).toBeLessThan(2000);
      expectNothingStored(dbPath);
      expect((await stash.getStats()).sessionReads).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("through a real server", () => {
  test("FILESTASH_MAX_LINES and FILESTASH_MAX_CHARS override the defaults; read_files caps every file", async () => {
    const sb = createSandbox();
    const a = join(sb.project, "a.txt");
    const b = join(sb.project, "b.txt");
    writeFileSync(a, lines(40));
    writeFileSync(b, lines(30, "row"));
    const server = await startServer(sb, { env: { FILESTASH_MAX_LINES: "7" } });
    expect(await server.read(a)).toBe(`${lines(7)}\n${notice(1, 7, 40)}`);
    const both = (await server.call("read_files", { paths: [a, b] })).text;
    expect(both).toContain(`=== ${b} ===\n${lines(7, "row")}\n${notice(1, 7, 30)}`);
    expect(both.match(/\[filestash: truncated/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    const forced = (await server.call("read_file", { path: b, force: true })).text;
    expect(forced).toBe(`${lines(7, "row")}\n${notice(1, 7, 30)}`);
    expect(await server.read(b, { offset: 8, limit: 1000 })).toContain("row 8");
    await server.close();

    const chars = await startServer(sb, { env: { FILESTASH_MAX_CHARS: "30" } });
    const text = await chars.read(a);
    expect(text).toBe(`${lines(4)}\n${notice(1, 4, 40)}`);
    await chars.close();
  });

  test("invalid values are ignored with one stderr line and the defaults apply", async () => {
    const sb = createSandbox();
    const file = join(sb.project, "long.txt");
    writeFileSync(file, lines(2500));
    const server = await startServer(sb, { env: { FILESTASH_MAX_LINES: "abc", FILESTASH_MAX_CHARS: "0" } });
    expect((await server.read(file)).endsWith(notice(1, 2000, 2500))).toBe(true);
    await server.close();

    const child = spawn(process.execPath, [CLI, "serve"], {
      cwd: sb.project,
      env: { ...process.env, FILESTASH_DIR: sb.stashDir, FILESTASH_MAX_LINES: "abc", FILESTASH_MAX_CHARS: "12.5" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    try {
      const deadline = Date.now() + 5000;
      while (!stderr.includes("FILESTASH_MAX_CHARS") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const warnings = stderr.split("\n").filter((l) => l.includes("invalid"));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('FILESTASH_MAX_LINES="abc"');
      expect(warnings[1]).toContain('FILESTASH_MAX_CHARS="12.5"');
    } finally {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      expect(isAlive(child.pid!)).toBe(false);
    }
  });

  test("a 30 MB text file returns a bounded slice, stores nothing and reports no inflated savings", async () => {
    const sb = createSandbox();
    const file = join(sb.project, "huge.log");
    writeFileSync(file, `${"a".repeat(29)}\n`.repeat(1_000_000));
    const server = await startServer(sb);

    const started = Date.now();
    const text = await server.read(file);
    const elapsed = Date.now() - started;
    expect(text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS + 130);
    expect(text).toMatch(/\[filestash: truncated, showing lines 1-2000 of 1000001; continue with offset=2001\]$/);
    expect(elapsed).toBeLessThan(10_000);
    expect(isAlive(server.pid)).toBe(true);

    const next = await server.read(file, { offset: 2001, limit: 5 });
    expect(next).toBe(Array.from({ length: 5 }, () => "a".repeat(29)).join("\n"));

    const status = (await server.call("stash_status")).text;
    const baseline = Number(/Would have sent \(plain reads\): ~([\d,]+)/.exec(status)![1]!.replaceAll(",", ""));
    const sent = Number(/Actually sent: ~([\d,]+)/.exec(status)![1]!.replaceAll(",", ""));
    expect(baseline).toBe(sent);
    expect(baseline).toBeLessThan(26_000);
    expect(status).toContain("Gross saved: ~0 tokens");

    expectNothingStored(sb.dbPath);
    const dbBytes = readdirSync(sb.stashDir).reduce((sum, f) => sum + statSync(join(sb.stashDir, f)).size, 0);
    expect(dbBytes).toBeLessThan(1_000_000);
    await server.close();
  });

  test("a binary file through the server shows the notice and stores nothing", async () => {
    const sb = createSandbox();
    const file = join(sb.project, "blob.bin");
    const buf = Buffer.alloc(200_000, 7);
    buf[10] = 0;
    writeFileSync(file, buf);
    const server = await startServer(sb);
    expect(await server.read(file)).toBe("[filestash: binary file (200000 bytes), not shown]");
    expect(await server.read(file, { force: true })).toBe("[filestash: binary file (200000 bytes), not shown]");
    expectNothingStored(sb.dbPath);
    await server.close();
  });
});
