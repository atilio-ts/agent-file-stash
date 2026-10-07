import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createStash } from "filestash-sdk";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp_test_prune");
const FILE_PATH = join(TEST_DIR, "sample.ts");
const OTHER_PATH = join(TEST_DIR, "other.ts");

let dbCounter = 0;
const children: ChildProcess[] = [];

function newDbPath(): string {
  return join(TEST_DIR, `db${dbCounter++}.db`);
}

function open(dbPath: string, sessionId: string) {
  return createStash({ dbPath, sessionId });
}

async function shutdown(...handles: ReturnType<typeof open>[]) {
  for (const h of handles) {
    h.watcher.close();
    await h.stash.close();
  }
}

function count(dbPath: string, sql: string, ...params: string[]): number {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(sql).get(...params) as { c: number }).c;
  } finally {
    db.close();
  }
}

function exec(dbPath: string, sql: string, ...params: (string | number)[]) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function deadPid(): number {
  const res = spawnSync(process.execPath, ["-e", ""]);
  if (!res.pid) throw new Error("could not spawn helper process");
  return res.pid;
}

function liveChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

async function killAndWait(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGKILL");
  await exited;
}

async function seedClosedSession(dbPath: string, sessionId: string, pid: number) {
  const h = open(dbPath, sessionId);
  await h.stash.readFile(FILE_PATH);
  await h.stash.readFile(FILE_PATH);
  await shutdown(h);
  exec(dbPath, "INSERT OR REPLACE INTO sessions (session_id, pid) VALUES (?, ?)", sessionId, pid);
}

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(FILE_PATH, "const x = 1;\n// padding padding padding padding padding padding padding padding padding padding padding padding \n");
  writeFileSync(OTHER_PATH, "const y = 2;\n");
});

afterAll(async () => {
  for (const c of children) await killAndWait(c);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("pruning closed sessions", () => {
  test("data of a session whose process is dead is removed on next init", async () => {
    const dbPath = newDbPath();
    await seedClosedSession(dbPath, "closed", deadPid());
    expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "closed")).toBe(1);
    expect(count(dbPath, "SELECT COUNT(*) c FROM session_stats WHERE session_id = ?", "closed")).toBeGreaterThan(0);

    const h = open(dbPath, "fresh");
    try {
      await h.stash.init();
      expect(count(dbPath, "SELECT COUNT(*) c FROM sessions WHERE session_id = ?", "closed")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "closed")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_stats WHERE session_id = ?", "closed")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(0);
    } finally {
      await shutdown(h);
    }
  });

  test("data of a session running in another live process is preserved", async () => {
    const dbPath = newDbPath();
    const child = liveChild();
    await seedClosedSession(dbPath, "remote", child.pid!);

    const h = open(dbPath, "fresh");
    try {
      await h.stash.init();
      expect(count(dbPath, "SELECT COUNT(*) c FROM sessions WHERE session_id = ?", "remote")).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "remote")).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(1);
    } finally {
      await shutdown(h);
    }
  });

  test("a session is pruned once its process exits", async () => {
    const dbPath = newDbPath();
    const child = liveChild();
    await seedClosedSession(dbPath, "remote", child.pid!);

    const alive = open(dbPath, "while-alive");
    await alive.stash.init();
    await shutdown(alive);
    expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "remote")).toBe(1);

    await killAndWait(child);

    const after = open(dbPath, "after-exit");
    try {
      await after.stash.init();
      expect(count(dbPath, "SELECT COUNT(*) c FROM sessions WHERE session_id = ?", "remote")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "remote")).toBe(0);
    } finally {
      await shutdown(after);
    }
  });

  test("an active session keeps stashing after another session starts", async () => {
    const dbPath = newDbPath();
    const a = open(dbPath, "active-a");
    await a.stash.readFile(FILE_PATH);

    const b = open(dbPath, "active-b");
    try {
      await b.stash.init();
      const r = await a.stash.readFile(FILE_PATH);
      expect(r.stashed).toBe(true);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "active-a")).toBe(1);
    } finally {
      await shutdown(a, b);
    }
  });

  test("an active session can still diff after another session starts", async () => {
    const dbPath = newDbPath();
    const file = join(TEST_DIR, "diffable.ts");
    const padding = "filler\n".repeat(200);
    writeFileSync(file, `line1\nline2\nline3\n${padding}`);
    const a = open(dbPath, "active-a");
    await a.stash.readFile(file);

    const b = open(dbPath, "active-b");
    try {
      await b.stash.init();
      writeFileSync(file, `line1\nCHANGED\nline3\n${padding}`);
      const r = await a.stash.readFile(file);
      expect(r.stashed).toBe(true);
      expect(r.content).toContain("CHANGED");
      expect(r.content).not.toContain("line3\nline3");
    } finally {
      await shutdown(a, b);
    }
  });

  test("the lifetime tokens_saved counter survives pruning", async () => {
    const dbPath = newDbPath();
    await seedClosedSession(dbPath, "closed", deadPid());
    const before = count(dbPath, "SELECT value c FROM stats WHERE key = 'tokens_saved'");
    expect(before).toBeGreaterThan(0);

    const h = open(dbPath, "fresh");
    try {
      const stats = await h.stash.getStats();
      expect(stats.tokensSaved).toBe(before);
      expect(stats.sessionTokensSaved).toBe(0);
    } finally {
      await shutdown(h);
    }
  });

  test("versions no longer referenced by any live session are dropped", async () => {
    const dbPath = newDbPath();
    const file = join(TEST_DIR, "evolving.ts");
    writeFileSync(file, "v1\n");
    const a = open(dbPath, "a");
    await a.stash.readFile(file);
    writeFileSync(file, "v2\n");
    await a.stash.readFile(file);
    expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions WHERE path LIKE '%evolving.ts'")).toBe(2);

    const b = open(dbPath, "b");
    try {
      await b.stash.init();
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions WHERE path LIKE '%evolving.ts'")).toBe(1);
      const r = await a.stash.readFile(file);
      expect(r.stashed).toBe(true);
    } finally {
      await shutdown(a, b);
    }
  });

  test("versions of files read only by closed sessions are dropped, others kept", async () => {
    const dbPath = newDbPath();
    const closed = open(dbPath, "closed");
    await closed.stash.readFile(OTHER_PATH);
    await shutdown(closed);

    const live = open(dbPath, "live");
    await live.stash.readFile(FILE_PATH);

    const fresh = open(dbPath, "fresh");
    try {
      await fresh.stash.init();
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions WHERE path LIKE '%other.ts'")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions WHERE path LIKE '%sample.ts'")).toBe(1);
    } finally {
      await shutdown(live, fresh);
    }
  });

  test("close() releases the session so it is pruned by the next init", async () => {
    const dbPath = newDbPath();
    const a = open(dbPath, "gracefully-closed");
    await a.stash.readFile(FILE_PATH);
    await shutdown(a);
    expect(count(dbPath, "SELECT COUNT(*) c FROM sessions WHERE session_id = ?", "gracefully-closed")).toBe(0);
    expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "gracefully-closed")).toBe(1);

    const b = open(dbPath, "next");
    try {
      await b.stash.init();
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "gracefully-closed")).toBe(0);
    } finally {
      await shutdown(b);
    }
  });

  test("re-opening the same session id keeps its own data", async () => {
    const dbPath = newDbPath();
    const first = open(dbPath, "same");
    await first.stash.readFile(FILE_PATH);
    await shutdown(first);

    const second = open(dbPath, "same");
    try {
      const r = await second.stash.readFile(FILE_PATH);
      expect(r.stashed).toBe(true);
    } finally {
      await shutdown(second);
    }
  });

  test("a session row with an invalid pid is treated as closed", async () => {
    const dbPath = newDbPath();
    const seed = open(dbPath, "seed");
    await seed.stash.readFile(FILE_PATH);
    await shutdown(seed);
    exec(dbPath, "INSERT OR REPLACE INTO sessions (session_id, pid) VALUES (?, ?)", "zero", 0);
    exec(dbPath, "INSERT OR REPLACE INTO sessions (session_id, pid) VALUES (?, ?)", "negative", -1);
    exec(dbPath, "INSERT OR REPLACE INTO session_reads (session_id, path, hash, read_at) VALUES (?, ?, ?, ?)", "zero", "/x", "h", 1);

    const h = open(dbPath, "fresh");
    try {
      await h.stash.init();
      expect(count(dbPath, "SELECT COUNT(*) c FROM sessions WHERE session_id IN ('zero', 'negative')")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "zero")).toBe(0);
    } finally {
      await shutdown(h);
    }
  });

  test("a database created before the sessions table existed is migrated and its orphan rows dropped", async () => {
    const dbPath = newDbPath();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE file_versions (path TEXT NOT NULL, hash TEXT NOT NULL, content TEXT NOT NULL, lines INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (path, hash));
      CREATE TABLE session_reads (session_id TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY (session_id, path));
      CREATE TABLE stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE session_stats (session_id TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, key));
      INSERT INTO stats (key, value) VALUES ('tokens_saved', 500);
      INSERT INTO file_versions VALUES ('/old.ts', 'abc', 'old', 1, 1);
      INSERT INTO session_reads VALUES ('legacy', '/old.ts', 'abc', 1);
      INSERT INTO session_stats VALUES ('legacy', 'tokens_saved', 500);
    `);
    legacy.close();

    const h = open(dbPath, "fresh");
    try {
      const stats = await h.stash.getStats();
      expect(stats.tokensSaved).toBe(500);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads WHERE session_id = ?", "legacy")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_stats WHERE session_id = ?", "legacy")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM sessions WHERE session_id = ?", "fresh")).toBe(1);
    } finally {
      await shutdown(h);
    }
  });

  test("init registers the current process pid for the session", async () => {
    const dbPath = newDbPath();
    const h = open(dbPath, "me");
    try {
      await h.stash.init();
      expect(count(dbPath, "SELECT pid c FROM sessions WHERE session_id = ?", "me")).toBe(process.pid);
    } finally {
      await shutdown(h);
    }
  });

  test("pruning does nothing harmful when there is nothing to prune", async () => {
    const dbPath = newDbPath();
    const a = open(dbPath, "a");
    const b = open(dbPath, "b");
    try {
      await a.stash.init();
      await b.stash.init();
      expect(count(dbPath, "SELECT COUNT(*) c FROM sessions")).toBe(2);
    } finally {
      await shutdown(a, b);
    }
  });
});
