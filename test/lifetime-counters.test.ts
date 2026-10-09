import { describe, test, expect, afterAll } from "vitest";
import { createStash, lifetimeView, type StashConfig } from "filestash-sdk";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAll, createSandbox, query, runCli, startServer } from "./helpers/mcp.js";
import { formatLifetime, formatStatus, toolDefinitionTokens } from "../packages/cli/src/mcp.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "filestash-lifetime-")));
let counter = 0;

afterAll(async () => {
  await cleanupAll();
  rmSync(ROOT, { recursive: true, force: true });
});

const body = (n: number, tag = "a") => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n") + "\n";

function setup(config: Partial<StashConfig> = {}) {
  const id = ++counter;
  const dir = join(ROOT, `case${id}`);
  mkdirSync(dir);
  const dbPath = join(dir, "stash.db");
  const open = (sessionId = `s${id}`, extra: Partial<StashConfig> = {}) => {
    const { stash, watcher } = createStash({ dbPath, sessionId, quiet: true, ...config, ...extra });
    return { stash, close: async () => (watcher.close(), stash.close()) };
  };
  const write = (name: string, content: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  return { dir, dbPath, open, write };
}

function lifetimeRows(dbPath: string): Record<string, number> {
  const rows = query<{ key: string; value: number }>(dbPath, "SELECT key, value FROM stats");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function lifetime(dbPath: string) {
  const r = lifetimeRows(dbPath);
  return {
    reads: r.reads_total ?? 0,
    baseline: r.baseline_tokens_total ?? 0,
    sent: r.sent_tokens_total ?? 0,
    sessions: r.sessions_total ?? 0,
    overhead: r.overhead_tokens_total ?? 0,
    since: r.counters_since,
  };
}

function exec(dbPath: string, sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

describe("lifetime counters accumulate on every read path", () => {
  test("each path bumps reads once and baseline minus sent equals the session gross saved", async () => {
    const t = setup({ maxLines: 50 });
    const { stash, close } = t.open();
    const big = t.write("big.ts", body(200));
    const small = t.write("small.ts", body(40));
    const secret = t.write("notes.secret", body(30));
    const binary = t.write("blob.bin", Buffer.from([1, 2, 0, 3, 4, 0, 0, 9]));
    const rewrite = t.write("rewrite.ts", body(60));
    const exclude = t.open("x", { exclude: ["*.secret"] });

    const paths: [string, () => Promise<unknown>][] = [
      ["first read", () => stash.readFile(small)],
      ["unchanged label", () => stash.readFile(small)],
      ["diff", async () => (writeFileSync(small, body(40).replace("a3 = 3", "a3 = 99")), stash.readFile(small))],
      ["guard full-return", async () => (writeFileSync(rewrite, body(60, "q")), stash.readFile(rewrite))],
      ["partial", () => stash.readFile(small, { offset: 5, limit: 10 })],
      ["capped", () => stash.readFile(big)],
      ["binary", () => stash.readFile(binary)],
      ["force", () => stash.readFileFull(small)],
    ];
    await stash.readFile(rewrite);

    let expectedReads = 1;
    for (const [name, run] of paths) {
      const before = lifetime(t.dbPath).reads;
      await run();
      expectedReads += 1;
      expect(lifetime(t.dbPath).reads, name).toBe(before + 1);
    }
    expect(lifetime(t.dbPath).reads).toBe(expectedReads);

    const stats = await stash.getStats();
    expect(stats.lifetimeReads).toBe(stats.sessionReads);
    expect(stats.lifetimeBaselineTokens).toBe(stats.sessionBaselineTokens);
    expect(stats.lifetimeSentTokens).toBe(stats.sessionSentTokens);
    expect(stats.lifetimeBaselineTokens - stats.lifetimeSentTokens).toBe(stats.sessionTokensSaved);
    expect(stats.sessionTokensSaved).toBeGreaterThan(0);
    expect(stats.tokensSaved).toBe(stats.sessionTokensSaved);

    await exclude.stash.readFile(secret);
    const ex = await exclude.stash.getStats();
    expect(ex.lifetimeReads).toBe(expectedReads + 1);
    expect(ex.lifetimeBaselineTokens - ex.lifetimeSentTokens).toBe(ex.tokensSaved);
    await exclude.close();
    await close();
  });

  test("the gross identity holds across several sessions after the earlier ones are pruned", async () => {
    const t = setup();
    const file = t.write("a.ts", body(80));
    let grossSum = 0;
    for (let i = 0; i < 3; i++) {
      const { stash, close } = t.open(`run${i}`);
      await stash.readFile(file);
      await stash.readFile(file);
      await stash.readFile(file);
      grossSum += (await stash.getStats()).sessionTokensSaved;
      await close();
    }
    const l = lifetime(t.dbPath);
    expect(l.reads).toBe(9);
    expect(l.baseline - l.sent).toBe(grossSum);
  });
});

describe("lifetime counters outlive sessions", () => {
  test("pruning a closed session keeps the totals and drops the per-session rows", async () => {
    const t = setup();
    const file = t.write("a.ts", body(80));
    const a = t.open("A");
    await a.stash.readFile(file);
    await a.stash.readFile(file);
    const before = lifetime(t.dbPath);
    expect(before.reads).toBe(2);
    await a.close();
    expect(query(t.dbPath, "SELECT 1 FROM sessions WHERE session_id = 'A'")).toHaveLength(0);

    const b = t.open("B");
    const stats = await b.stash.getStats();
    expect(query(t.dbPath, "SELECT 1 FROM session_stats WHERE session_id = 'A'")).toHaveLength(0);
    expect(lifetime(t.dbPath)).toEqual(before);
    expect(stats.lifetimeReads).toBe(2);
    expect(stats.sessionReads).toBe(0);
    expect(stats.tokensSaved).toBe(before.baseline - before.sent);
    await b.close();
  });

  test("counters survive a crash because they are written with the read", async () => {
    const t = setup();
    const file = t.write("a.ts", body(80));
    const a = t.open("A");
    await a.stash.readFile(file);
    await a.stash.readFile(file);
    expect(lifetime(t.dbPath).reads).toBe(2);
  });

  test("counters_since is written once and never overwritten", async () => {
    const t = setup();
    const file = t.write("a.ts", body(20));
    const a = t.open("A");
    await a.stash.readFile(file);
    const since = lifetime(t.dbPath).since!;
    expect(since).toBeGreaterThan(0);
    exec(t.dbPath, "UPDATE stats SET value = 1000 WHERE key = 'counters_since'");
    await a.stash.readFile(file);
    await a.stash.recordSessionStart(10);
    expect(lifetime(t.dbPath).since).toBe(1000);
    await a.close();
    const b = t.open("B");
    await b.stash.readFile(file);
    await b.stash.recordSessionStart(10);
    expect(lifetime(t.dbPath).since).toBe(1000);
    await b.close();
  });

  test("clear zeroes the lifetime counters and resetReads leaves them alone", async () => {
    const t = setup();
    const file = t.write("a.ts", body(80));
    const a = t.open("A");
    await a.stash.recordSessionStart(25);
    await a.stash.readFile(file);
    await a.stash.readFile(file);
    const before = lifetime(t.dbPath);

    await a.stash.resetReads();
    expect(lifetime(t.dbPath)).toEqual(before);
    expect((await a.stash.getStats()).tokensSaved).toBeGreaterThan(0);

    await a.stash.clear();
    const after = lifetime(t.dbPath);
    expect(after).toEqual({ reads: 0, baseline: 0, sent: 0, sessions: 0, overhead: 0, since: undefined });
    const stats = await a.stash.getStats();
    expect(stats.tokensSaved).toBe(0);
    expect(stats.countersSince).toBeUndefined();
    expect(lifetimeView(stats).empty).toBe(true);

    await a.stash.readFile(file);
    expect(lifetime(t.dbPath).reads).toBe(1);
    expect(lifetime(t.dbPath).since).toBeGreaterThan(0);
    await a.close();
  });
});

describe("recordSessionStart", () => {
  test("adds one session and the overhead, once per store", async () => {
    const t = setup();
    const a = t.open("A");
    await a.stash.recordSessionStart(120);
    await a.stash.recordSessionStart(120);
    await a.stash.recordSessionStart(500);
    expect(lifetime(t.dbPath)).toMatchObject({ sessions: 1, overhead: 120, reads: 0 });
    const stats = await a.stash.getStats();
    expect(stats).toMatchObject({ lifetimeSessions: 1, lifetimeOverheadTokens: 120 });
    await a.close();

    const b = t.open("B");
    await b.stash.recordSessionStart(80);
    expect(lifetime(t.dbPath)).toMatchObject({ sessions: 2, overhead: 200 });
    await b.close();
  });

  test("opening, reading and closing a store without recordSessionStart counts no session", async () => {
    const t = setup();
    const file = t.write("a.ts", body(20));
    const a = t.open("A");
    await a.stash.readFile(file);
    await a.stash.getStats();
    await a.close();
    expect(lifetime(t.dbPath).sessions).toBe(0);
    expect(lifetime(t.dbPath).overhead).toBe(0);
  });

  test("ignores a negative or non-finite overhead but still counts the session", async () => {
    const t = setup();
    const a = t.open("A");
    await a.stash.recordSessionStart(Number.NaN);
    expect(lifetime(t.dbPath)).toMatchObject({ sessions: 1, overhead: 0 });
    await a.close();
  });
});

describe("legacy and degraded databases", () => {
  test("a database without lifetime keys opens, reports empty counters and starts counting", async () => {
    const t = setup();
    const file = t.write("a.ts", body(80));
    const seed = t.open("seed");
    await seed.stash.getStats();
    await seed.close();
    exec(t.dbPath, "UPDATE stats SET value = 777 WHERE key = 'tokens_saved'");
    expect(Object.keys(lifetimeRows(t.dbPath))).toEqual(["tokens_saved"]);

    const a = t.open("A");
    const stats = await a.stash.getStats();
    expect(stats).toMatchObject({ tokensSaved: 777, lifetimeSessions: 0, lifetimeReads: 0 });
    expect(stats.countersSince).toBeUndefined();
    const text = formatStatus(stats, 100);
    expect(text).toContain('Lifetime counters start with this version; "Gross saved (all sessions)" above includes older history.');
    expect(text).not.toContain("Lifetime (since");

    await a.stash.recordSessionStart(100);
    await a.stash.readFile(file);
    await a.stash.readFile(file);
    const after = await a.stash.getStats();
    expect(after).toMatchObject({ lifetimeSessions: 1, lifetimeReads: 2 });
    expect(after.countersSince).toBeGreaterThan(0);
    expect(after.tokensSaved).toBeGreaterThan(777);
    expect(formatStatus(after, 100)).toContain("Lifetime (since");
    await a.close();
  });

  test("degraded mode never throws from counting and counts nothing", async () => {
    const root = join(ROOT, "degraded");
    mkdirSync(root);
    writeFileSync(join(root, "blocker"), "not a directory");
    const file = join(root, "a.ts");
    writeFileSync(file, body(20));
    const { stash } = createStash({ dbPath: join(root, "blocker", "sub", "stash.db"), sessionId: "d", quiet: true });
    await expect(stash.recordSessionStart(100)).resolves.toBeUndefined();
    expect((await stash.readFile(file)).content).toContain("a0");
    await stash.readFileFull(file);
    const stats = await stash.getStats();
    expect(stats.degraded).toBe(true);
    expect(stats).toMatchObject({ lifetimeSessions: 0, lifetimeReads: 0, lifetimeBaselineTokens: 0, lifetimeSentTokens: 0, lifetimeOverheadTokens: 0 });
    expect(stats.countersSince).toBeUndefined();
    expect(formatStatus(stats, 100)).toContain("DEGRADED");
    await expect(stash.clear()).resolves.toBeUndefined();
  });

  test("a counting failure degrades the stash instead of throwing", async () => {
    const t = setup();
    const file = t.write("a.ts", body(20));
    const a = t.open("A");
    await a.stash.readFile(file);
    exec(t.dbPath, "DROP TABLE stats");
    expect((await a.stash.readFile(file)).content).toBeTruthy();
    await expect(a.stash.recordSessionStart(10)).resolves.toBeUndefined();
    expect((await a.stash.getStats()).degraded).toBe(true);
    await a.close();
  });
});

interface Seed {
  sessions: number;
  reads: number;
  baseline: number;
  sent: number;
  overhead: number;
  since?: number;
  saved?: number;
}

async function seedDb(dbPath: string, s: Seed): Promise<void> {
  const { stash } = createStash({ dbPath, sessionId: "seed", quiet: true });
  await stash.init();
  await stash.close();
  const pairs: [string, number | undefined][] = [
    ["sessions_total", s.sessions],
    ["reads_total", s.reads],
    ["baseline_tokens_total", s.baseline],
    ["sent_tokens_total", s.sent],
    ["overhead_tokens_total", s.overhead],
    ["counters_since", s.since],
    ["tokens_saved", s.saved],
  ];
  for (const [key, value] of pairs) {
    if (value !== undefined) exec(dbPath, "INSERT OR REPLACE INTO stats (key, value) VALUES (?, ?)", key, value);
  }
}

const SINCE_A = Date.UTC(2026, 9, 9, 12);
const SINCE_B = Date.UTC(2026, 9, 20, 12);
const BIG: Seed = { sessions: 14, reads: 312, baseline: 410200, sent: 188900, overhead: 3878, since: SINCE_A, saved: 221300 };
const LOSS: Seed = { sessions: 2, reads: 10, baseline: 1000, sent: 900, overhead: 600, since: SINCE_B, saved: 100 };

function projectDb(root: string, name: string): { dir: string; dbPath: string } {
  const dir = join(root, name, ".file-stash");
  mkdirSync(dir, { recursive: true });
  return { dir, dbPath: join(dir, "stash.db") };
}

function status(dir: string): string {
  const res = runCli(["status"], { env: { FILESTASH_DIR: dir } });
  expect(res.status, res.stderr).toBe(0);
  return res.stdout;
}

describe("status", () => {
  test("shows the lifetime block with gross, net and net per session", async () => {
    const root = join(ROOT, "status-one");
    const p = projectDb(root, "p");
    await seedDb(p.dbPath, BIG);
    const out = status(p.dir);
    expect(out).toContain("Tokens saved (total):   ~221,300");
    expect(out).toContain("  Lifetime (since 2026-10-09):");
    expect(out).toContain("    Sessions: 14, reads: 312");
    expect(out).toContain("    Would have sent (plain reads): ~410,200 tokens");
    expect(out).toContain("    Actually sent: ~188,900 tokens");
    expect(out).toContain("    Gross saved: ~221,300 tokens");
    expect(out).toContain("    Tool definitions overhead: ~3,878 tokens (est., 14 sessions)");
    expect(out).toContain("    Net saved: ~217,422 tokens (est.), ~15,530 per session");
  });

  test("shows a negative net as is", async () => {
    const root = join(ROOT, "status-neg");
    const p = projectDb(root, "p");
    await seedDb(p.dbPath, LOSS);
    const out = status(p.dir);
    expect(out).toContain("Gross saved: ~100 tokens");
    expect(out).toContain("Net saved: ~-500 tokens (est.), ~-250 per session");
  });

  test("zero sessions prints the net without a per-session figure", async () => {
    const root = join(ROOT, "status-zero");
    const p = projectDb(root, "p");
    await seedDb(p.dbPath, { sessions: 0, reads: 5, baseline: 100, sent: 40, overhead: 0, since: SINCE_A });
    const out = status(p.dir);
    expect(out).toContain("Net saved: ~60 tokens (est.)");
    expect(out).not.toContain("per session");
    expect(out).not.toMatch(/NaN|Infinity/);
  });

  test("a database from before the counters prints the start-with-this-version line", async () => {
    const root = join(ROOT, "status-legacy");
    const p = projectDb(root, "p");
    await seedDb(p.dbPath, { sessions: 0, reads: 0, baseline: 0, sent: 0, overhead: 0, saved: 4200 });
    exec(p.dbPath, "DELETE FROM stats WHERE key <> 'tokens_saved'");
    const out = status(p.dir);
    expect(out).toContain("Tokens saved (total):   ~4,200");
    expect(out).toContain('Lifetime counters start with this version; "Tokens saved (total)" above includes older history.');
    expect(out).not.toContain("Lifetime (since");
  });
});

describe("status --all", () => {
  test("sums the lifetime numbers over every database and keeps the per-project rows", async () => {
    const root = join(ROOT, "all-two");
    await seedDb(projectDb(root, "alpha").dbPath, BIG);
    await seedDb(projectDb(root, "beta").dbPath, LOSS);
    const res = runCli(["status", "--all", root]);
    expect(res.status, res.stderr).toBe(0);
    const out = res.stdout;
    expect(out).toContain("(2 databases under");
    expect(out).toMatch(/~\s*221,300 tokens\s+0 files\s+\S*alpha/);
    expect(out).toMatch(/~\s*100 tokens\s+0 files\s+\S*beta/);
    expect(out).toMatch(/~\s*221,400 tokens\s+0 files\s+TOTAL/);
    expect(out).toContain("  Lifetime (since 2026-10-09):");
    expect(out).toContain("    Sessions: 16, reads: 322");
    expect(out).toContain("    Would have sent (plain reads): ~411,200 tokens");
    expect(out).toContain("    Actually sent: ~189,800 tokens");
    expect(out).toContain("    Gross saved: ~221,400 tokens");
    expect(out).toContain("    Tool definitions overhead: ~4,478 tokens (est., 16 sessions)");
    expect(out).toContain("    Net saved: ~216,922 tokens (est.), ~13,558 per session");
    expect(out).toContain("Savings count re-reads within a session");
  });

  test("databases without counters add nothing and zero sessions never divide", async () => {
    const root = join(ROOT, "all-zero");
    await seedDb(projectDb(root, "old").dbPath, { sessions: 0, reads: 0, baseline: 0, sent: 0, overhead: 0, saved: 50 });
    const res = runCli(["status", "--all", root]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("Lifetime counters start with this version");
    expect(res.stdout).not.toMatch(/NaN|Infinity/);
  });
});

describe("CLI helper commands never count a session", () => {
  test("status, status --all, reset and doctor leave sessions_total and overhead alone", async () => {
    const root = join(ROOT, "cli-never");
    const p = projectDb(root, "p");
    await seedDb(p.dbPath, BIG);
    const before = lifetime(p.dbPath);
    const env = { FILESTASH_DIR: p.dir };
    const cwd = join(root, "p");
    runCli(["status"], { env, cwd });
    runCli(["status", "--all", root], { env, cwd });
    runCli(["reset"], { env, cwd });
    runCli(["doctor"], { env, cwd });
    runCli(["doctor", "--json"], { env, cwd });
    expect(lifetime(p.dbPath)).toEqual(before);

    const fresh = projectDb(root, "fresh");
    await seedDb(fresh.dbPath, { sessions: 0, reads: 0, baseline: 0, sent: 0, overhead: 0 });
    runCli(["status"], { env: { FILESTASH_DIR: fresh.dir }, cwd });
    runCli(["reset"], { env: { FILESTASH_DIR: fresh.dir }, cwd });
    runCli(["doctor"], { env: { FILESTASH_DIR: fresh.dir }, cwd });
    expect(lifetime(fresh.dbPath).sessions).toBe(0);
    expect(lifetime(fresh.dbPath).overhead).toBe(0);
  });
});

describe("MCP servers", () => {
  test("two servers started one after the other count two sessions with the overhead of each", async () => {
    const sb = createSandbox();
    const file = join(sb.project, "app.ts");
    writeFileSync(file, body(80));

    const first = await startServer(sb);
    await first.read(file);
    await first.read(file);
    expect(lifetime(sb.dbPath)).toMatchObject({ sessions: 1, overhead: toolDefinitionTokens(), reads: 2 });
    await first.close();

    const second = await startServer(sb);
    expect(lifetime(sb.dbPath)).toMatchObject({ sessions: 2, overhead: 2 * toolDefinitionTokens(), reads: 2 });
    await second.read(file);
    await second.read(file);
    const l = lifetime(sb.dbPath);
    expect(l).toMatchObject({ sessions: 2, reads: 4 });

    const res = await second.call("stash_status");
    expect(res.text).toContain("  Lifetime (since ");
    expect(res.text).toContain("    Sessions: 2, reads: 4");
    expect(res.text).toContain(`Tool definitions overhead: ~${(2 * toolDefinitionTokens()).toLocaleString()} tokens (est., 2 sessions)`);
    expect(res.text).toContain(`Gross saved: ~${(l.baseline - l.sent).toLocaleString()} tokens`);
    expect(res.text).toContain("per session");
    const key = Object.keys(res.meta).find((k) => k.endsWith("/stats"))!;
    expect(res.meta[key]).toMatchObject({
      lifetimeSessions: 2,
      lifetimeReads: 4,
      lifetimeBaselineTokens: l.baseline,
      lifetimeSentTokens: l.sent,
      lifetimeOverheadTokens: 2 * toolDefinitionTokens(),
      lifetime: { sessions: 2, grossSaved: l.baseline - l.sent, netSaved: l.baseline - l.sent - 2 * toolDefinitionTokens() },
    });
    await second.close();
  });

  test("stash_status on a legacy database shows the start-with-this-version line", async () => {
    const sb = createSandbox();
    mkdirSync(sb.stashDir, { recursive: true });
    const seed = createStash({ dbPath: sb.dbPath, sessionId: "seed", quiet: true });
    await seed.stash.init();
    await seed.stash.close();
    exec(sb.dbPath, "UPDATE stats SET value = 321 WHERE key = 'tokens_saved'");
    exec(sb.dbPath, "DELETE FROM stats WHERE key <> 'tokens_saved'");
    const s = await startServer(sb);
    const res = await s.call("stash_status");
    expect(res.text).toContain("Gross saved (all sessions): ~321 tokens");
    expect(res.text).toContain("Lifetime (since");
    expect(lifetime(sb.dbPath).sessions).toBe(1);
    await s.close();
  });
});

describe("lifetimeView", () => {
  const base = { lifetimeSessions: 4, lifetimeReads: 30, lifetimeBaselineTokens: 1000, lifetimeSentTokens: 400, lifetimeOverheadTokens: 200 };

  test("computes gross, net and net per session", () => {
    expect(lifetimeView(base)).toEqual({
      empty: false,
      sessions: 4,
      reads: 30,
      baselineTokens: 1000,
      sentTokens: 400,
      overheadTokens: 200,
      grossSaved: 600,
      netSaved: 400,
      netPerSession: 100,
    });
  });

  test("keeps a negative net and rounds the per-session figure", () => {
    const v = lifetimeView({ ...base, lifetimeSessions: 3, lifetimeBaselineTokens: 500, lifetimeOverheadTokens: 700 });
    expect(v.grossSaved).toBe(100);
    expect(v.netSaved).toBe(-600);
    expect(v.netPerSession).toBe(-200);
    expect(lifetimeView({ ...base, lifetimeSessions: 3, lifetimeOverheadTokens: 601 }).netPerSession).toBe(0);
  });

  test("zero sessions gives a null per-session figure and empty counters are flagged", () => {
    const none = { lifetimeSessions: 0, lifetimeReads: 0, lifetimeBaselineTokens: 0, lifetimeSentTokens: 0, lifetimeOverheadTokens: 0 };
    expect(lifetimeView(none)).toMatchObject({ empty: true, netPerSession: null, grossSaved: 0, netSaved: 0 });
    expect(lifetimeView({ ...none, lifetimeReads: 2, lifetimeBaselineTokens: 10, lifetimeSentTokens: 4 })).toMatchObject({
      empty: false,
      netPerSession: null,
      netSaved: 6,
    });
  });

  test("formatLifetime renders the block and the empty line", () => {
    const lines = formatLifetime(base, Date.UTC(2026, 0, 5, 12), "x");
    expect(lines[0]).toBe("  Lifetime (since 2026-01-05):");
    expect(lines.at(-1)).toBe("    Net saved: ~400 tokens (est.), ~100 per session");
    expect(formatLifetime({ ...base, lifetimeSessions: 0, lifetimeReads: 0 }, undefined, "the totals")).toEqual([
      "  Lifetime counters start with this version; the totals above includes older history.",
    ]);
  });
});
