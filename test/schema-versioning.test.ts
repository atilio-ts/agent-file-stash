import { describe, test, expect, afterAll } from "vitest";
import { createStash } from "filestash-sdk";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION, runMigrations, type Migration } from "../packages/sdk/src/migrations.js";
import { cleanupAll, createSandbox, query, runCli, startServer } from "./helpers/mcp.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "filestash-schema-")));
let counter = 0;

afterAll(async () => {
  await cleanupAll();
  rmSync(ROOT, { recursive: true, force: true });
});

const SCHEMA_030 = `
CREATE TABLE IF NOT EXISTS file_versions (
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  content     TEXT NOT NULL,
  lines       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (path, hash)
);

CREATE TABLE IF NOT EXISTS session_reads (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  read_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
);

CREATE TABLE IF NOT EXISTS stats (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_stats (
  session_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, key)
);

INSERT OR IGNORE INTO stats (key, value) VALUES ('tokens_saved', 0);
`;

const SCHEMA_040 = `
${SCHEMA_030}
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  pid         INTEGER NOT NULL
);
`;

const SCHEMA_050 = `
${SCHEMA_040}
CREATE TABLE IF NOT EXISTS session_ranges (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_ranges ON session_ranges (session_id, path);
`;

const FILE_CONTENT = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
const FILE_HASH = createHash("sha256").update(FILE_CONTENT).digest("hex").slice(0, 16);
const LIFETIME_TOKENS = 4321;
const TABLES = ["file_versions", "session_reads", "stats", "session_stats", "sessions", "session_ranges"];

function newCase(): { dir: string; dbPath: string; file: string } {
  const dir = join(ROOT, `case${++counter}`);
  mkdirSync(dir);
  const file = join(dir, "f.txt");
  writeFileSync(file, FILE_CONTENT);
  return { dir, dbPath: join(dir, "stash.db"), file };
}

type Era = "0.3.0" | "0.4.0" | "0.5.0";

function buildLegacy(dbPath: string, file: string, era: Era, sessionId: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(era === "0.3.0" ? SCHEMA_030 : era === "0.4.0" ? SCHEMA_040 : SCHEMA_050);
  db.prepare("INSERT INTO file_versions VALUES (?, ?, ?, ?, ?)").run(file, FILE_HASH, FILE_CONTENT, 40, 1000);
  db.prepare("INSERT INTO session_reads VALUES (?, ?, ?, ?)").run(sessionId, file, FILE_HASH, 1000);
  db.prepare("UPDATE stats SET value = ? WHERE key = 'tokens_saved'").run(LIFETIME_TOKENS);
  db.prepare("INSERT INTO session_stats VALUES (?, ?, ?)").run(sessionId, "reads", 7);
  db.prepare("INSERT INTO session_stats VALUES (?, ?, ?)").run(sessionId, "tokens_saved", 99);
  if (era !== "0.3.0") db.prepare("INSERT INTO sessions VALUES (?, ?)").run(sessionId, process.pid);
  if (era === "0.5.0") db.prepare("INSERT INTO session_ranges VALUES (?, ?, ?, ?, ?)").run(sessionId, file, FILE_HASH, 1, 40);
  db.close();
}

function dump(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseSync(dbPath);
  try {
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    const out: Record<string, unknown[]> = {};
    for (const t of TABLES) if (present.has(t)) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    return out;
  } finally {
    db.close();
  }
}

function schemaOf(dbPath: string): { sql: string[]; version: number } {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() as { name: string; sql: string }[];
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    return { sql: rows.map((r) => `${r.name}: ${r.sql.replace(/\s+/g, " ").trim()}`), version };
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  return query<{ user_version: number }>(dbPath, "PRAGMA user_version")[0]!.user_version;
}

function setVersion(dbPath: string, version: number): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${version}`);
  db.close();
}

function newerThanKnown(version = SCHEMA_VERSION + 5): { dbPath: string; file: string; dir: string } {
  const c = newCase();
  buildLegacy(c.dbPath, c.file, "0.5.0", "future");
  setVersion(c.dbPath, version);
  return c;
}

function newerReason(version: number): string {
  return `database schema version ${version} is newer than this release supports (${SCHEMA_VERSION}); upgrade agent-file-stash`;
}

describe("fresh database", () => {
  test("gets the current version and the full schema", async () => {
    const { dbPath } = newCase();
    const { stash } = createStash({ dbPath, sessionId: "fresh" });
    await stash.init();
    expect(stash.isDegraded).toBe(false);
    await stash.close();
    const { sql, version } = schemaOf(dbPath);
    expect(version).toBe(SCHEMA_VERSION);
    expect(sql.join("\n")).toContain("idx_session_ranges: CREATE INDEX idx_session_ranges ON session_ranges (session_id, path)");
    const tables = query<{ name: string }>(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
    expect(tables).toEqual([...TABLES].sort());
    expect(dump(dbPath).stats).toEqual([{ key: "tokens_saved", value: 0 }]);
  });

  test("reopening leaves the version and the schema unchanged", async () => {
    const { dbPath } = newCase();
    const first = createStash({ dbPath, sessionId: "a" });
    await first.stash.init();
    await first.stash.close();
    const before = schemaOf(dbPath);
    const second = createStash({ dbPath, sessionId: "b" });
    await second.stash.init();
    expect(second.stash.isDegraded).toBe(false);
    await second.stash.close();
    expect(schemaOf(dbPath)).toEqual(before);
  });

  test("runMigrations on an up-to-date database never calls a step", () => {
    const { dbPath } = newCase();
    const db = new DatabaseSync(dbPath);
    runMigrations(db);
    let calls = 0;
    runMigrations(db, [{ version: SCHEMA_VERSION, up: () => void calls++ }]);
    db.close();
    expect(calls).toBe(0);
  });
});

describe.each<Era>(["0.3.0", "0.4.0", "0.5.0"])("upgrade from a %s database", (era) => {
  const freshSchema = async () => {
    const { dbPath } = newCase();
    const { stash } = createStash({ dbPath, sessionId: "ref" });
    await stash.init();
    await stash.close();
    return schemaOf(dbPath);
  };

  test("produces the same schema as a fresh database and keeps every row", async () => {
    const { dbPath, file } = newCase();
    buildLegacy(dbPath, file, era, "old");
    expect(userVersion(dbPath)).toBe(0);
    const before = dump(dbPath);
    const db = new DatabaseSync(dbPath);
    runMigrations(db);
    db.close();
    const after = dump(dbPath);
    for (const [table, rows] of Object.entries(before)) expect(after[table], table).toEqual(rows);
    expect(schemaOf(dbPath)).toEqual(await freshSchema());
    expect(schemaOf(dbPath).version).toBe(SCHEMA_VERSION);
  });

  test("opens through the stash with lifetime numbers intact and works afterwards", async () => {
    const { dbPath, file } = newCase();
    buildLegacy(dbPath, file, era, "old");
    const { stash, watcher } = createStash({ dbPath, sessionId: "old" });
    try {
      await stash.init();
      expect(stash.isDegraded).toBe(false);
      expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
      expect((await stash.getStats()).tokensSaved).toBeGreaterThanOrEqual(LIFETIME_TOKENS);
      const first = await stash.readFile(file);
      if (era === "0.5.0") expect(first.stashed).toBe(true);
      else expect(first.content).toContain("line 1");
      expect((await stash.readFile(file)).stashed).toBe(true);
      await stash.resetReads();
      expect((await stash.readFile(file)).stashed).toBe(false);
    } finally {
      watcher.close();
      await stash.close();
    }
    expect(schemaOf(dbPath)).toEqual(await freshSchema());
  });

  test("keeps rows of live sessions and prunes dead ones", async () => {
    if (era === "0.3.0") return;
    const { dbPath, file } = newCase();
    buildLegacy(dbPath, file, era, "old");
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run("dead", 2 ** 22 + 12345);
    db.prepare("INSERT INTO session_reads VALUES (?, ?, ?, ?)").run("dead", file, "deadbeef", 1);
    db.close();
    const { stash } = createStash({ dbPath, sessionId: "old" });
    await stash.init();
    await stash.close();
    expect(query(dbPath, "SELECT session_id FROM sessions WHERE session_id = 'dead'")).toHaveLength(0);
    expect(query(dbPath, "SELECT session_id FROM session_reads WHERE session_id = 'dead'")).toHaveLength(0);
    expect(query(dbPath, "SELECT value FROM session_stats WHERE session_id = 'old' AND key = 'reads'")).toEqual([{ value: 7 }]);
    expect(query(dbPath, "SELECT value FROM stats WHERE key = 'tokens_saved'")).toEqual([{ value: LIFETIME_TOKENS }]);
  });
});

describe("migration runner", () => {
  const step = (version: number, sql: string): Migration => ({ version, up: (db) => db.exec(sql) });

  test("a failing step rolls back and leaves the previous version", () => {
    const { dbPath } = newCase();
    const db = new DatabaseSync(dbPath);
    const failing: Migration = {
      version: 2,
      up: (d) => {
        d.exec("CREATE TABLE partial (a INTEGER)");
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(db, [MIGRATIONS[0]!, failing])).toThrow("boom");
    db.close();
    expect(userVersion(dbPath)).toBe(1);
    expect(query(dbPath, "SELECT name FROM sqlite_master WHERE name = 'partial'")).toHaveLength(0);
    const again = new DatabaseSync(dbPath);
    runMigrations(again, [MIGRATIONS[0]!, step(2, "CREATE TABLE partial (a INTEGER)")]);
    again.close();
    expect(userVersion(dbPath)).toBe(2);
    expect(query(dbPath, "SELECT name FROM sqlite_master WHERE name = 'partial'")).toHaveLength(1);
  });

  test("steps run in order and each bumps the version", () => {
    const { dbPath } = newCase();
    const db = new DatabaseSync(dbPath);
    runMigrations(db, [step(1, "CREATE TABLE a (x)"), step(2, "ALTER TABLE a ADD COLUMN y"), step(3, "ALTER TABLE a ADD COLUMN z")]);
    db.close();
    expect(userVersion(dbPath)).toBe(3);
  });

  test("a step another connection applied in the meantime is skipped", () => {
    const { dbPath } = newCase();
    const a = new DatabaseSync(dbPath);
    const b = new DatabaseSync(dbPath);
    let calls = 0;
    const counted: Migration = {
      version: 1,
      up: (db) => {
        calls++;
        db.exec("CREATE TABLE t (x)");
      },
    };
    let raced = false;
    const racing = {
      prepare: (sql: string) => b.prepare(sql),
      exec: (sql: string) => {
        if (sql === "BEGIN IMMEDIATE" && !raced) {
          raced = true;
          runMigrations(a, [counted]);
        }
        return b.exec(sql);
      },
    } as unknown as DatabaseSync;
    runMigrations(racing, [counted]);
    a.close();
    b.close();
    expect(calls).toBe(1);
    expect(userVersion(dbPath)).toBe(1);
  });

  test("refuses a database that is newer than the migrations", () => {
    const { dbPath } = newCase();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 9");
    expect(() => runMigrations(db, [step(1, "CREATE TABLE t (x)")])).toThrow(
      "database schema version 9 is newer than this release supports (1); upgrade agent-file-stash",
    );
    db.close();
    expect(query(dbPath, "SELECT name FROM sqlite_master WHERE name = 't'")).toHaveLength(0);
  });
});

describe("concurrent upgrade", () => {
  test("several servers opening the same legacy database upgrade it once", async () => {
    const sandbox = createSandbox();
    mkdirSync(sandbox.stashDir, { recursive: true });
    buildLegacy(sandbox.dbPath, join(sandbox.project, "f.txt"), "0.4.0", "old");
    const db = new DatabaseSync(sandbox.dbPath);
    db.exec(`
      DELETE FROM stats;
      CREATE TABLE audit (n INTEGER);
      CREATE TRIGGER log_seed BEFORE INSERT ON stats WHEN NEW.key = 'tokens_saved' BEGIN INSERT INTO audit VALUES (1); END;
    `);
    db.close();

    const servers = await Promise.all(Array.from({ length: 6 }, () => startServer(sandbox)));
    for (const server of servers) {
      const status = await server.call("stash_status");
      expect(status.isError).toBe(false);
      expect(status.text).not.toContain("DEGRADED");
      expect(status.meta.degraded).not.toBe(true);
    }
    expect(userVersion(sandbox.dbPath)).toBe(SCHEMA_VERSION);
    expect(query(sandbox.dbPath, "SELECT COUNT(*) AS c FROM audit")).toEqual([{ c: 1 }]);
    expect(query(sandbox.dbPath, "SELECT path FROM file_versions")).toHaveLength(1);
    expect(query(sandbox.dbPath, "SELECT COUNT(*) AS c FROM sessions WHERE pid != ?", process.pid)).toEqual([{ c: 6 }]);
    for (const server of servers) await server.close();
  });
});

describe("database newer than this release", () => {
  const snapshot = (dbPath: string) => ({ bytes: readFileSync(dbPath), rows: dump(dbPath), version: userVersion(dbPath) });

  test("degrades with the exact reason and is not modified", async () => {
    const { dbPath, file } = newerThanKnown();
    const before = snapshot(dbPath);
    const { stash, watcher } = createStash({ dbPath, sessionId: "old", quiet: true });
    try {
      await stash.init();
      expect(stash.isDegraded).toBe(true);
      expect(stash.degradedReason).toBe(newerReason(SCHEMA_VERSION + 5));
      expect((await stash.readFile(file)).stashed).toBe(false);
      expect((await stash.getStats()).degraded).toBe(true);
    } finally {
      watcher.close();
      await stash.close();
    }
    const after = snapshot(dbPath);
    expect(after.version).toBe(before.version);
    expect(after.rows).toEqual(before.rows);
    expect(after.bytes.equals(before.bytes)).toBe(true);
  });

  test("is not moved aside as corrupt even with recovery enabled", async () => {
    const { dbPath } = newerThanKnown();
    const { stash } = createStash({ dbPath, sessionId: "old", quiet: true, recoverCorrupt: true });
    await stash.init();
    await stash.close();
    expect(stash.degradedReason).toBe(newerReason(SCHEMA_VERSION + 5));
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION + 5);
    expect(query(dbPath, "SELECT COUNT(*) AS c FROM file_versions")).toEqual([{ c: 1 }]);
  });

  test("the server reports DEGRADED in stash_status and keeps the database", async () => {
    const sandbox = createSandbox();
    mkdirSync(sandbox.stashDir, { recursive: true });
    buildLegacy(sandbox.dbPath, join(sandbox.project, "f.txt"), "0.5.0", "future");
    setVersion(sandbox.dbPath, SCHEMA_VERSION + 1);
    const server = await startServer(sandbox);
    const status = await server.call("stash_status");
    expect(status.text).toContain(`Mode: DEGRADED (${newerReason(SCHEMA_VERSION + 1)})`);
    await server.close();
    expect(userVersion(sandbox.dbPath)).toBe(SCHEMA_VERSION + 1);
  });

  test("cli status prints one line and exits 1", () => {
    const { dbPath, dir } = newerThanKnown();
    const res = runCli(["status"], { env: { FILESTASH_DIR: dir } });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr.trim().split("\n")).toEqual([`filestash status failed for ${dbPath}: ${newerReason(SCHEMA_VERSION + 5)}`]);
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION + 5);
  });

  test("cli reset prints one line and exits 1; from the hook it exits 0", () => {
    const { dir } = newerThanKnown();
    const res = runCli(["reset"], { env: { FILESTASH_DIR: dir } });
    expect(res.status).toBe(1);
    expect(res.stderr.trim().split("\n")).toEqual([`filestash reset failed: ${newerReason(SCHEMA_VERSION + 5)}`]);
    const hook = runCli(["reset", "--from-hook"], { env: { FILESTASH_DIR: dir } });
    expect(hook.status).toBe(0);
    expect(hook.stderr.trim().split("\n")).toEqual([`filestash reset failed: ${newerReason(SCHEMA_VERSION + 5)}`]);
  });

  test("cli status --all skips it and carries on", () => {
    const root = join(ROOT, `all${++counter}`);
    const bad = join(root, "bad", ".file-stash");
    const good = join(root, "good", ".file-stash");
    mkdirSync(bad, { recursive: true });
    mkdirSync(good, { recursive: true });
    buildLegacy(join(bad, "stash.db"), "/x", "0.5.0", "future");
    setVersion(join(bad, "stash.db"), SCHEMA_VERSION + 5);
    buildLegacy(join(good, "stash.db"), "/x", "0.5.0", "old");
    const res = runCli(["status", "--all", root]);
    expect(res.status).toBe(0);
    expect(res.stderr.trim().split("\n")).toEqual([`skipped ${join(bad, "stash.db")}: ${newerReason(SCHEMA_VERSION + 5)}`]);
    expect(res.stdout).toContain("1 databases");
    expect(userVersion(join(bad, "stash.db"))).toBe(SCHEMA_VERSION + 5);
  });
});

describe("corrupt database recovery", () => {
  test("the replacement database gets the current version", async () => {
    const { dbPath } = newCase();
    writeFileSync(dbPath, "this is not a database".repeat(200));
    const { stash } = createStash({ dbPath, sessionId: "r", quiet: true });
    await stash.init();
    expect(stash.isDegraded).toBe(false);
    await stash.close();
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
    expect(schemaOf(dbPath).sql.length).toBeGreaterThan(5);
  });
});
