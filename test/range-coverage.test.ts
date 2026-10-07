import { describe, test, expect, afterAll } from "vitest";
import { createStash } from "filestash-sdk";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeIntervals, coversRange } from "../packages/sdk/src/stash.js";
import { cleanupAll, createSandbox, query, startServer } from "./helpers/mcp.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "filestash-ranges-")));
let counter = 0;

afterAll(async () => {
  await cleanupAll();
  rmSync(ROOT, { recursive: true, force: true });
});

function numbered(n: number, edits: Record<number, string> = {}): string {
  return Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}: const value${i + 1} = ${i + 1};`).join("\n");
}

function setup(content = numbered(301), sessionId?: string) {
  const id = ++counter;
  const dir = join(ROOT, `case${id}`);
  mkdirSync(dir);
  const dbPath = join(dir, "stash.db");
  const file = join(dir, "f.txt");
  writeFileSync(file, content);
  const { stash, watcher } = createStash({ dbPath, sessionId: sessionId ?? `s${id}` });
  const close = async () => {
    watcher.close();
    await stash.close();
  };
  return { stash, file, dir, dbPath, close };
}

function ranges(dbPath: string): [number, number][] {
  const rows = query<{ start_line: number; end_line: number }>(
    dbPath,
    "SELECT start_line, end_line FROM session_ranges ORDER BY start_line",
  );
  return rows.map((r) => [r.start_line, r.end_line]);
}

async function expectIdentity(stash: ReturnType<typeof setup>["stash"]) {
  const s = await stash.getStats();
  expect(s.sessionBaselineTokens - s.sessionSentTokens).toBe(s.sessionTokensSaved);
}

describe("interval helpers", () => {
  test("merge overlap, adjacency, containment, disjoint", () => {
    expect(mergeIntervals([[1, 5], [3, 7]])).toEqual([[1, 7]]);
    expect(mergeIntervals([[1, 100], [101, 200]])).toEqual([[1, 200]]);
    expect(mergeIntervals([[1, 50], [10, 20]])).toEqual([[1, 50]]);
    expect(mergeIntervals([[10, 20], [1, 5]])).toEqual([[1, 5], [10, 20]]);
    expect(mergeIntervals([[1, 5], [1, 5]])).toEqual([[1, 5]]);
  });

  test("coversRange needs one interval to contain the whole range", () => {
    expect(coversRange([[1, 5], [7, 9]], 1, 5)).toBe(true);
    expect(coversRange([[1, 5], [7, 9]], 4, 8)).toBe(false);
    expect(coversRange([], 1, 1)).toBe(false);
  });
});

describe("range coverage through StashStore", () => {
  test("reproduction: unseen range and whole-file reads return real content", async () => {
    const { stash, file, close } = setup();
    try {
      const a = await stash.readFile(file, { offset: 1, limit: 5 });
      expect(a.stashed).toBe(false);
      const b = await stash.readFile(file, { offset: 200, limit: 5 });
      expect(b.stashed).toBe(false);
      expect(b.content).toContain("line 200:");
      expect(b.content).toContain("line 204:");
      const c = await stash.readFile(file);
      expect(c.stashed).toBe(false);
      expect(c.content).toContain("line 301:");
      const d = await stash.readFile(file, { offset: 50, limit: 5 });
      expect(d.stashed).toBe(true);
      await expectIdentity(stash);
    } finally {
      await close();
    }
  });

  test("same range twice is unchanged; partial overlap is real content", async () => {
    const { stash, file, close } = setup();
    try {
      await stash.readFile(file, { offset: 1, limit: 5 });
      expect((await stash.readFile(file, { offset: 1, limit: 5 })).stashed).toBe(true);
      const overlap = await stash.readFile(file, { offset: 3, limit: 5 });
      expect(overlap.stashed).toBe(false);
      expect(overlap.content).toContain("line 7:");
      expect((await stash.readFile(file, { offset: 1, limit: 7 })).stashed).toBe(true);
      await expectIdentity(stash);
    } finally {
      await close();
    }
  });

  test("whole file then any sub-range is unchanged", async () => {
    const { stash, file, close } = setup();
    try {
      await stash.readFile(file);
      for (const [offset, limit] of [[1, 10], [100, 20], [295, 50]] as const) {
        const r = await stash.readFile(file, { offset, limit });
        expect(r.stashed).toBe(true);
        expect(r.content).toContain("unchanged");
      }
      await expectIdentity(stash);
    } finally {
      await close();
    }
  });

  test("adjacent reads merge: 1-100, 101-200, then 1-200 is unchanged", async () => {
    const { stash, file, dbPath, close } = setup();
    try {
      await stash.readFile(file, { offset: 1, limit: 100 });
      await stash.readFile(file, { offset: 101, limit: 100 });
      expect(ranges(dbPath)).toEqual([[1, 200]]);
      expect((await stash.readFile(file, { offset: 1, limit: 200 })).stashed).toBe(true);
      expect((await stash.readFile(file, { offset: 1, limit: 201 })).stashed).toBe(false);
      await expectIdentity(stash);
    } finally {
      await close();
    }
  });

  test("a limit past the end of the file records up to the last line", async () => {
    const { stash, file, dbPath, close } = setup();
    try {
      await stash.readFile(file, { offset: 290, limit: 100 });
      expect(ranges(dbPath)).toEqual([[290, 301]]);
      expect((await stash.readFile(file, { offset: 295, limit: 100 })).stashed).toBe(true);
    } finally {
      await close();
    }
  });

  test("edit after a partial read returns the real slice, never a diff", async () => {
    const { stash, file, dbPath, close } = setup();
    try {
      await stash.readFile(file, { offset: 1, limit: 5 });
      writeFileSync(file, numbered(301, { 250: "line 250: EDITED" }));
      const r = await stash.readFile(file, { offset: 1, limit: 5 });
      expect(r.stashed).toBe(false);
      expect(r.content).toContain("line 1:");
      expect(ranges(dbPath)).toEqual([[1, 5]]);
      const full = await stash.readFile(file);
      expect(full.stashed).toBe(false);
      expect(full.content).toContain("EDITED");
      expect(ranges(dbPath)).toEqual([[1, 301]]);
      await expectIdentity(stash);
    } finally {
      await close();
    }
  });

  test("whole-file read after an edit that followed a partial read returns full content", async () => {
    const { stash, file, close } = setup();
    try {
      await stash.readFile(file, { offset: 1, limit: 5 });
      writeFileSync(file, numbered(301, { 3: "line 3: EDITED" }));
      const r = await stash.readFile(file);
      expect(r.stashed).toBe(false);
      expect(r.content).not.toContain("[filestash:");
      expect(r.content.split("\n")).toHaveLength(301);
    } finally {
      await close();
    }
  });

  test("edit after a full read still returns a diff", async () => {
    const { stash, file, dbPath, close } = setup();
    try {
      await stash.readFile(file);
      writeFileSync(file, numbered(301, { 150: "line 150: EDITED" }));
      const r = await stash.readFile(file);
      expect(r.stashed).toBe(true);
      if (!r.stashed) throw new Error("expected stashed result");
      expect(r.diff).toContain("EDITED");
      expect(ranges(dbPath)).toEqual([[1, 301]]);
      expect((await stash.readFile(file, { offset: 10, limit: 10 })).stashed).toBe(true);
      await expectIdentity(stash);
    } finally {
      await close();
    }
  });

  test("changes elsewhere label needs the old version fully delivered", async () => {
    const { stash, file, dbPath, close } = setup();
    try {
      await stash.readFile(file);
      writeFileSync(file, numbered(301, { 250: "line 250: EDITED" }));
      const r = await stash.readFile(file, { offset: 10, limit: 10 });
      expect(r.stashed).toBe(true);
      expect(r.content).toContain("changes elsewhere");
      expect(ranges(dbPath)).toEqual([[10, 19]]);

      writeFileSync(file, numbered(301, { 250: "line 250: EDITED", 280: "line 280: EDITED" }));
      const partial = await stash.readFile(file, { offset: 10, limit: 10 });
      expect(partial.stashed).toBe(false);
      expect(partial.content).toContain("line 10:");
      await expectIdentity(stash);
    } finally {
      await close();
    }
  });

  test("a range that was edited after a full read returns the real slice", async () => {
    const { stash, file, close } = setup();
    try {
      await stash.readFile(file);
      writeFileSync(file, numbered(301, { 12: "line 12: EDITED" }));
      const r = await stash.readFile(file, { offset: 10, limit: 10 });
      expect(r.stashed).toBe(false);
      expect(r.content).toContain("EDITED");
    } finally {
      await close();
    }
  });

  test("readFileFull replaces coverage with the whole file", async () => {
    const { stash, file, dbPath, close } = setup();
    try {
      await stash.readFile(file, { offset: 1, limit: 5 });
      const full = await stash.readFileFull(file);
      expect(full.stashed).toBe(false);
      expect(ranges(dbPath)).toEqual([[1, 301]]);
      expect((await stash.readFile(file, { offset: 200, limit: 5 })).stashed).toBe(true);
      await expectIdentity(stash);
    } finally {
      await close();
    }
  });

  test("excluded paths record nothing", async () => {
    const { stash, dir, dbPath, close } = setup();
    try {
      const secret = join(dir, ".env");
      writeFileSync(secret, numbered(50));
      const r = await stash.readFile(secret, { offset: 1, limit: 5 });
      expect(r.stashed).toBe(false);
      expect(ranges(dbPath)).toEqual([]);
      await stash.readFileFull(secret);
      expect(ranges(dbPath)).toEqual([]);
    } finally {
      await close();
    }
  });

  test("ranges are tracked per session", async () => {
    const a = setup();
    const { stash: other, watcher } = createStash({ dbPath: a.dbPath, sessionId: "other" });
    try {
      await a.stash.readFile(a.file);
      const r = await other.readFile(a.file, { offset: 1, limit: 5 });
      expect(r.stashed).toBe(false);
    } finally {
      watcher.close();
      await other.close();
      await a.close();
    }
  });
});

describe("cleanup of range rows", () => {
  test("resetReads, clear and onFileDeleted remove range rows", async () => {
    const { stash, file, dbPath, close } = setup();
    try {
      await stash.readFile(file, { offset: 1, limit: 5 });
      await stash.resetReads();
      expect(ranges(dbPath)).toEqual([]);
      expect((await stash.readFile(file, { offset: 1, limit: 5 })).stashed).toBe(false);

      await stash.clear();
      expect(ranges(dbPath)).toEqual([]);

      await stash.readFile(file, { offset: 1, limit: 5 });
      await stash.onFileDeleted(file);
      expect(ranges(dbPath)).toEqual([]);
    } finally {
      await close();
    }
  });

  test("pruning a closed session removes its range rows and orphaned versions", async () => {
    const { stash, file, dbPath, close } = setup(numbered(301), "dead");
    await stash.readFile(file, { offset: 1, limit: 5 });
    await close();
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO sessions (session_id, pid) VALUES (?, ?)").run("dead", 2 ** 22 + 12345);
    db.close();
    expect(ranges(dbPath)).toHaveLength(1);

    const { stash: next, watcher } = createStash({ dbPath, sessionId: "next" });
    try {
      await next.init();
      expect(ranges(dbPath)).toEqual([]);
      expect(query(dbPath, "SELECT 1 FROM file_versions")).toHaveLength(0);
    } finally {
      watcher.close();
      await next.close();
    }
  });
});

describe("upgrade from a database without session_ranges", () => {
  test("first read after upgrading returns real content", async () => {
    const id = ++counter;
    const dir = join(ROOT, `case${id}`);
    mkdirSync(dir);
    const dbPath = join(dir, "stash.db");
    const file = join(dir, "f.txt");
    const content = numbered(301);
    writeFileSync(file, content);

    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE file_versions (path TEXT NOT NULL, hash TEXT NOT NULL, content TEXT NOT NULL, lines INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (path, hash));
      CREATE TABLE session_reads (session_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY (session_id, path));
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, pid INTEGER NOT NULL);
      CREATE TABLE stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE session_stats (session_id TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, key));
    `);
    db.prepare("INSERT INTO file_versions VALUES (?, ?, ?, ?, ?)").run(file, hash, content, 301, 1);
    db.prepare("INSERT INTO session_reads VALUES (?, ?, ?, ?)").run("up", file, hash, 1);
    db.close();

    const { stash, watcher } = createStash({ dbPath, sessionId: "up" });
    try {
      const first = await stash.readFile(file, { offset: 200, limit: 5 });
      expect(first.stashed).toBe(false);
      expect(first.content).toContain("line 200:");
      expect((await stash.readFile(file, { offset: 200, limit: 5 })).stashed).toBe(true);
      await expectIdentity(stash);
    } finally {
      watcher.close();
      await stash.close();
    }
  });
});

describe("range coverage through a real MCP server", () => {
  test("reproduction sequence returns real content for unseen ranges", async () => {
    const sb = createSandbox();
    const file = join(sb.project, "big.txt");
    writeFileSync(file, numbered(301));
    const server = await startServer(sb);

    expect(await server.read(file, { offset: 1, limit: 5 })).toContain("line 5:");
    const mid = await server.read(file, { offset: 200, limit: 5 });
    expect(mid).toContain("line 200:");
    expect(mid).toContain("line 204:");
    expect(mid).not.toContain("[filestash: unchanged");
    const whole = await server.read(file);
    expect(whole).toContain("line 301:");
    expect(whole).not.toContain("[filestash: unchanged");
    expect(await server.read(file, { offset: 200, limit: 5 })).toContain("[filestash: unchanged");
    expect(await server.read(file)).toContain("[filestash: unchanged");
    expect(query(sb.dbPath, "SELECT start_line, end_line FROM session_ranges")).toEqual([
      { start_line: 1, end_line: 301 },
    ]);
  });
});
