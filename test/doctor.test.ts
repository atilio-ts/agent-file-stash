import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from "../packages/sdk/src/migrations.js";
import {
  CHECKS,
  checkDatabase,
  checkEnv,
  checkMcpRegistration,
  checkNode,
  checkResetHook,
  checkStashDir,
  checkUpdates,
  formatHuman,
  runChecks,
  summarize,
  type CheckResult,
  type DoctorOptions,
} from "../packages/cli/src/doctor.js";
import { cleanupAll, createSandbox, runCli, startServer } from "./helpers/mcp.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "filestash-doctor-")));
const PKG_VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")) as { version: string }).version;
const POSIX = process.platform !== "win32";
let counter = 0;

interface Case {
  home: string;
  project: string;
  stashDir: string;
  dbPath: string;
}

function newCase(): Case {
  const base = join(ROOT, `case${counter++}`);
  const c = { home: join(base, "home"), project: join(base, "project"), stashDir: join(base, "project", ".stash"), dbPath: join(base, "project", ".stash", "stash.db") };
  mkdirSync(c.home, { recursive: true });
  mkdirSync(c.project, { recursive: true });
  vi.stubEnv("FILESTASH_DIR", c.stashDir);
  vi.stubEnv("XDG_CONFIG_HOME", join(c.home, ".config"));
  return c;
}

function opts(c: Case, over: Partial<DoctorOptions> = {}): DoctorOptions {
  return { nodeVersion: "26.0.0", cwd: c.project, home: c.home, platform: process.platform, now: Date.now(), checkUpdates: false, fetchLatest: () => undefined, ...over };
}

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

function buildDb(c: Case, userVersion = SCHEMA_VERSION, sessions: number[] = []): void {
  mkdirSync(c.stashDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(c.dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  runMigrations(db, MIGRATIONS);
  db.prepare("INSERT INTO file_versions (path, hash, content, lines, created_at) VALUES ('/a.ts', 'h1', 'x', 1, 1)").run();
  sessions.forEach((pid, i) => db.prepare("INSERT INTO sessions (session_id, pid) VALUES (?, ?)").run(`s${i}`, pid));
  if (userVersion !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${userVersion}`);
  db.close();
  if (POSIX) chmodSync(c.dbPath, 0o600);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function find(results: CheckResult[], id: string): CheckResult {
  const r = results.find((x) => x.id === id);
  if (!r) throw new Error(`no ${id} result in ${JSON.stringify(results.map((x) => x.id))}`);
  return r;
}

function withoutShmMtime(rows: string[]): string[] {
  return rows.map((r) => r.replace(/(-shm\|f\|\d+\|)[\d.]+(\|)/, "$1*$2"));
}

function snapshot(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (root: string, dir: string): void => {
    const st = statSync(dir);
    out.push(`${root}|${relative(root, dir) || "."}|d|${st.mtimeMs}|${(st.mode & 0o777).toString(8)}`);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(root, p);
      else {
        const s = statSync(p);
        out.push(`${root}|${relative(root, p)}|f|${s.size}|${s.mtimeMs}|${(s.mode & 0o777).toString(8)}`);
      }
    }
  };
  for (const r of roots) walk(r, r);
  return out.sort();
}

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await cleanupAll();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("node check", () => {
  test("accepts a supported version and rejects an older one", () => {
    const c = newCase();
    expect(checkNode(opts(c, { nodeVersion: "24.0.0" }))[0]).toMatchObject({ id: "node", status: "ok" });
    const old = checkNode(opts(c, { nodeVersion: "22.12.0" }))[0]!;
    expect(old.status).toBe("error");
    expect(old.message).toContain(">=24");
    expect(old.hint).toBeTruthy();
  });
});

describe("stash directory check", () => {
  test("missing directory is informational", () => {
    const r = checkStashDir(opts(newCase()))[0]!;
    expect(r.status).toBe("info");
    expect(r.message).toContain("will be created on first read");
  });

  test.runIf(POSIX)("mode wider than 700 warns, 700 does not", () => {
    const c = newCase();
    mkdirSync(c.stashDir);
    chmodSync(c.stashDir, 0o755);
    const warn = checkStashDir(opts(c))[0]!;
    expect(warn.status).toBe("warn");
    expect(warn.hint).toContain("chmod 700");
    chmodSync(c.stashDir, 0o700);
    expect(checkStashDir(opts(c))[0]).toMatchObject({ status: "info", message: expect.stringContaining(c.stashDir) });
  });
});

describe("database check", () => {
  test("no database yet", async () => {
    const c = newCase();
    mkdirSync(c.stashDir);
    expect((await checkDatabase(opts(c)))[0]).toMatchObject({ id: "database", status: "info" });
    expect(readdirSync(c.stashDir)).toEqual([]);
  });

  test("healthy database reports schema, counters and live/dead sessions", async () => {
    const c = newCase();
    buildDb(c, SCHEMA_VERSION, [process.pid, deadPid()]);
    const results = await checkDatabase(opts(c));
    expect(find(results, "database-schema").status).toBe("ok");
    const stats = find(results, "database-stats");
    expect(stats.status).toBe("info");
    expect(stats.message).toContain("1 files tracked");
    expect(stats.message).toContain("1 live and 1 dead");
    expect(results.some((r) => r.status === "warn" || r.status === "error")).toBe(false);
  });

  test("older schema will be upgraded", async () => {
    const c = newCase();
    mkdirSync(c.stashDir, { recursive: true });
    const db = new DatabaseSync(c.dbPath);
    db.exec("CREATE TABLE file_versions (path TEXT, hash TEXT); PRAGMA user_version = 0");
    db.close();
    const r = find(await checkDatabase(opts(c)), "database-schema");
    expect(r.status).toBe("info");
    expect(r.message).toContain("will be upgraded");
  });

  test("newer schema is an error with the newer-release message", async () => {
    const c = newCase();
    buildDb(c, SCHEMA_VERSION + 1);
    const r = find(await checkDatabase(opts(c)), "database-schema");
    expect(r.status).toBe("error");
    expect(r.message).toContain("is newer than this release supports");
    expect(r.hint).toBeTruthy();
  });

  test("corrupt bytes are an error that mentions the move-aside recovery", async () => {
    const c = newCase();
    mkdirSync(c.stashDir, { recursive: true });
    writeFileSync(c.dbPath, Buffer.from("this is definitely not a sqlite database ".repeat(200)));
    const r = find(await checkDatabase(opts(c)), "database");
    expect(r.status).toBe("error");
    expect(r.hint).toContain("stash.db.corrupt-<ms>");
  });

  test.runIf(POSIX)("database file mode wider than 600 warns", async () => {
    const c = newCase();
    buildDb(c);
    chmodSync(c.dbPath, 0o644);
    const r = find(await checkDatabase(opts(c)), "database-mode");
    expect(r.status).toBe("warn");
    expect(r.hint).toContain("chmod 600");
  });

  test("leftover corrupt files are reported, sidecar files are not counted", async () => {
    const c = newCase();
    buildDb(c);
    writeFileSync(`${c.dbPath}.corrupt-1700000000000`, "x");
    writeFileSync(`${c.dbPath}.corrupt-1700000000000-wal`, "x");
    const r = find(await checkDatabase(opts(c)), "database-leftovers");
    expect(r.status).toBe("info");
    expect(r.message).toContain("1 moved-aside");
  });

  test("stale recovery lock warns, fresh lock is informational", async () => {
    const c = newCase();
    buildDb(c);
    const lock = `${c.dbPath}.recover.lock`;
    writeFileSync(lock, "1");
    expect(find(await checkDatabase(opts(c)), "database-lock").status).toBe("info");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const stale = find(await checkDatabase(opts(c)), "database-lock");
    expect(stale.status).toBe("warn");
    expect(stale.hint).toContain(lock);
  });

  test("a database held open by a writer is inspected without touching the directory", async () => {
    const c = newCase();
    buildDb(c);
    const writer = new DatabaseSync(c.dbPath);
    try {
      writer.exec("PRAGMA journal_mode=WAL");
      writer.exec("INSERT INTO file_versions (path, hash, content, lines, created_at) VALUES ('/b.ts', 'h2', 'y', 1, 2)");
      const before = snapshot(c.stashDir);
      const results = await checkDatabase(opts(c));
      expect(find(results, "database-schema").status).toBe("ok");
      expect(find(results, "database-stats").message).toContain("2 files tracked");
      expect(snapshot(c.stashDir)).toEqual(before);
    } finally {
      writer.close();
    }
  });
});

describe("MCP registration check", () => {
  const entry = (extra: Record<string, unknown> = {}) => ({ mcpServers: { filestash: { command: process.execPath, args: ["agent-file-stash", "serve"], ...extra } } });

  test("no editor config at all is informational", () => {
    expect(checkMcpRegistration(opts(newCase()))).toEqual([expect.objectContaining({ id: "mcp", status: "info" })]);
  });

  test("valid entry is ok and prints nothing from env", () => {
    const c = newCase();
    writeJson(join(c.home, ".claude.json"), { ...entry({ env: { API_TOKEN: "hunter2" } }), otherKey: "secret-value" });
    const results = checkMcpRegistration(opts(c));
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
    expect(JSON.stringify(results)).not.toMatch(/hunter2|secret-value|API_TOKEN/);
  });

  test("config without a filestash entry warns with the init hint", () => {
    const c = newCase();
    writeJson(join(c.home, ".claude.json"), { mcpServers: { other: { command: "x" } } });
    const r = checkMcpRegistration(opts(c))[0]!;
    expect(r.status).toBe("warn");
    expect(r.hint).toBe("run: agent-file-stash init");
  });

  test("command that does not exist warns", () => {
    const c = newCase();
    writeJson(join(c.home, ".claude.json"), { mcpServers: { filestash: { command: join(c.home, "nope", "bin"), args: ["serve"] } } });
    const r = checkMcpRegistration(opts(c))[0]!;
    expect(r.status).toBe("warn");
    expect(r.message).toContain("not found");
  });

  test("command resolved through PATH is ok", () => {
    const c = newCase();
    vi.stubEnv("PATH", dirname(process.execPath));
    writeJson(join(c.home, ".claude.json"), { mcpServers: { filestash: { command: basename(process.execPath), args: ["serve"] } } });
    expect(checkMcpRegistration(opts(c))[0]!.status).toBe("ok");
  });

  test("args without serve warn", () => {
    const c = newCase();
    writeJson(join(c.home, ".cursor", "mcp.json"), { mcpServers: { filestash: { command: process.execPath, args: ["status"] } } });
    const r = checkMcpRegistration(opts(c))[0]!;
    expect(r.status).toBe("warn");
    expect(r.message).toContain("serve");
  });

  test("OpenCode array command is understood", () => {
    const c = newCase();
    writeJson(join(c.home, ".config", "opencode", "opencode.json"), { mcp: { filestash: { type: "local", command: [process.execPath, "agent-file-stash", "serve"] } } });
    const r = checkMcpRegistration(opts(c))[0]!;
    expect(r).toMatchObject({ id: "mcp-opencode", status: "ok" });
  });

  test("invalid JSON warns", () => {
    const c = newCase();
    writeJson(join(c.home, ".claude.json"), "{broken");
    expect(checkMcpRegistration(opts(c))[0]!.status).toBe("warn");
  });
});

describe("context-reset hook check", () => {
  const hook = (matcher: string | undefined, command: string) => ({
    hooks: { SessionStart: [{ ...(matcher !== undefined && { matcher }), hooks: [{ type: "command", command }] }] },
  });
  const userSettings = (c: Case) => join(c.home, ".claude", "settings.json");
  const DIRECT = "npx agent-file-stash reset --from-hook";

  function script(c: Case, body = "#!/usr/bin/env bash\nexec agent-file-stash reset --from-hook\n"): string {
    const path = join(c.home, ".claude", "hooks", "reset.sh");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  }

  test("direct command with clear|compact is ok", () => {
    const c = newCase();
    writeJson(userSettings(c), hook("clear|compact", DIRECT));
    expect(checkResetHook(opts(c))).toEqual([expect.objectContaining({ id: "hook", status: "ok" })]);
  });

  test("bash wrapper script is followed", () => {
    const c = newCase();
    writeJson(userSettings(c), hook("clear|compact", `bash ${script(c)}`));
    expect(checkResetHook(opts(c))[0]!.status).toBe("ok");
  });

  test("script path run directly is followed", () => {
    const c = newCase();
    writeJson(userSettings(c), hook("clear|compact", script(c)));
    expect(checkResetHook(opts(c))[0]!.status).toBe("ok");
  });

  test("script that does not reset is not a match", () => {
    const c = newCase();
    writeJson(userSettings(c), hook("clear|compact", `bash ${script(c, "echo hello\n")}`));
    expect(checkResetHook(opts(c))[0]!.status).toBe("warn");
  });

  test("matcher without compact warns naming compact", () => {
    const c = newCase();
    writeJson(userSettings(c), hook("clear", DIRECT));
    const r = checkResetHook(opts(c))[0]!;
    expect(r.status).toBe("warn");
    expect(r.message).toContain("compact");
    expect(r.message).not.toContain("clear or");
  });

  test("matcher without clear warns naming clear", () => {
    const c = newCase();
    writeJson(userSettings(c), hook("compact", DIRECT));
    const r = checkResetHook(opts(c))[0]!;
    expect(r.status).toBe("warn");
    expect(r.message).toContain("match clear");
  });

  test.each([[""], ["*"], [undefined]])("matcher %j covers everything", (matcher) => {
    const c = newCase();
    writeJson(userSettings(c), hook(matcher, DIRECT));
    expect(checkResetHook(opts(c))[0]!.status).toBe("ok");
  });

  test("absent hook warns with the init --hooks hint", () => {
    const r = checkResetHook(opts(newCase()))[0]!;
    expect(r.status).toBe("warn");
    expect(r.hint).toContain("agent-file-stash init --hooks");
    expect(r.hint).toContain("/clear");
  });

  test("malformed settings warn naming the file and the check carries on", () => {
    const c = newCase();
    writeJson(userSettings(c), "{broken");
    writeJson(join(c.project, ".claude", "settings.json"), hook("clear|compact", DIRECT));
    const results = checkResetHook(opts(c));
    expect(results[0]).toMatchObject({ status: "warn", message: expect.stringContaining(userSettings(c)) });
    expect(results[1]!.status).toBe("ok");
  });

  test.each(["settings.json", "settings.local.json"])("project level %s counts", (name) => {
    const c = newCase();
    writeJson(join(c.project, ".claude", name), hook("clear|compact", DIRECT));
    expect(checkResetHook(opts(c))[0]!.status).toBe("ok");
  });

  test("clear in one file and compact in another together cover both", () => {
    const c = newCase();
    writeJson(userSettings(c), hook("clear", DIRECT));
    writeJson(join(c.project, ".claude", "settings.local.json"), hook("compact", DIRECT));
    expect(checkResetHook(opts(c))[0]!.status).toBe("ok");
  });

  test("the hook written by init --hooks is recognised", () => {
    const c = newCase();
    const init = runCli(["init", "--hooks"], { cwd: c.project, env: { HOME: c.home, XDG_CONFIG_HOME: join(c.home, ".config") } });
    expect(init.status).toBe(0);
    expect(checkResetHook(opts(c))[0]!.status).toBe("ok");
  });
});

describe("environment variable check", () => {
  test("prints nothing when no variable is set", () => {
    newCase();
    vi.stubEnv("FILESTASH_EXCLUDE", "");
    expect(checkEnv()).toEqual([]);
  });

  test("valid values are ok", () => {
    newCase();
    vi.stubEnv("FILESTASH_EXCLUDE", "*.pem, secrets.*");
    vi.stubEnv("FILESTASH_MAX_LINES", "500");
    vi.stubEnv("FILESTASH_MAX_CHARS", "20000");
    const results = checkEnv();
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(results[0]!.message).toContain("2 pattern");
  });

  test.each(["abc", "0", "-5", "1.5", "12px"])("MAX_LINES=%s warns", (value) => {
    newCase();
    vi.stubEnv("FILESTASH_MAX_LINES", value);
    const r = checkEnv()[0]!;
    expect(r.status).toBe("warn");
    expect(r.hint).toContain("FILESTASH_MAX_LINES");
  });
});

describe("update check", () => {
  test("prints nothing and never calls npm without the flag", () => {
    const fetchLatest = vi.fn(() => "9.9.9");
    expect(checkUpdates(opts(newCase(), { fetchLatest }))).toEqual([]);
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  test("reports a newer release", () => {
    const r = checkUpdates(opts(newCase(), { checkUpdates: true, fetchLatest: () => "99.0.0" }))[0]!;
    expect(r.status).toBe("info");
    expect(r.message).toContain(`${PKG_VERSION} -> 99.0.0`);
  });

  test("same version is ok", () => {
    expect(checkUpdates(opts(newCase(), { checkUpdates: true, fetchLatest: () => PKG_VERSION }))[0]!.status).toBe("ok");
  });

  test("network failure is informational", () => {
    const r = checkUpdates(opts(newCase(), { checkUpdates: true, fetchLatest: () => undefined }))[0]!;
    expect(r).toMatchObject({ status: "info", message: "could not check for updates" });
  });
});

describe("runner and formatting", () => {
  test("one throwing check becomes a warning and the rest still run", async () => {
    const ok: CheckResult = { id: "b", status: "ok", message: "fine" };
    const results = await runChecks(opts(newCase()), [
      ["a", () => { throw new Error("boom"); }],
      ["async", async () => { throw new Error("late"); }],
      ["b", () => [ok]],
    ]);
    expect(results).toEqual([
      { id: "a", status: "warn", message: "check failed: boom" },
      { id: "async", status: "warn", message: "check failed: late" },
      ok,
    ]);
  });

  test("human format indents hints for warnings and errors and ends with a summary", () => {
    const text = formatHuman([
      { id: "a", status: "ok", message: "good" },
      { id: "b", status: "warn", message: "meh", hint: "do this" },
      { id: "c", status: "error", message: "bad", hint: "do that" },
      { id: "d", status: "info", message: "fyi" },
    ]);
    expect(text).toBe("[ok] good\n[warn] meh\n    do this\n[error] bad\n    do that\n[info] fyi\n\n1 ok, 1 warnings, 1 errors");
    expect(summarize([])).toEqual({ ok: 0, warnings: 0, errors: 0 });
  });

  test("the default check list covers every area", () => {
    expect(CHECKS.map(([id]) => id)).toEqual(["node", "stash-dir", "database", "mcp", "hook", "env", "updates"]);
  });
});

describe("doctor command", () => {
  function env(c: Case): Record<string, string> {
    return { HOME: c.home, XDG_CONFIG_HOME: join(c.home, ".config"), FILESTASH_DIR: c.stashDir };
  }

  function configure(c: Case): void {
    writeJson(join(c.home, ".claude.json"), { mcpServers: { filestash: { command: process.execPath, args: ["agent-file-stash", "serve"] } } });
    writeJson(join(c.home, ".claude", "settings.json"), { hooks: { SessionStart: [{ matcher: "clear|compact", hooks: [{ type: "command", command: "npx agent-file-stash reset --from-hook" }] }] } });
  }

  test("healthy setup exits 0 with a summary", () => {
    const c = newCase();
    configure(c);
    buildDb(c);
    const res = runCli(["doctor"], { cwd: c.project, env: env(c) });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^\[ok\] Node /);
    expect(res.stdout).toMatch(/\n\d+ ok, 0 warnings, 0 errors\n$/);
    expect(res.stdout).not.toContain("update");
  });

  test("warnings alone keep exit code 0", () => {
    const c = newCase();
    const res = runCli(["doctor"], { cwd: c.project, env: env(c) });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("[warn] no SessionStart hook");
    expect(res.stdout).toMatch(/\n\d+ ok, [1-9]\d* warnings, 0 errors\n$/);
  });

  test("an error exits 1", () => {
    const c = newCase();
    configure(c);
    buildDb(c, SCHEMA_VERSION + 1);
    const res = runCli(["doctor"], { cwd: c.project, env: env(c) });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("[error] ");
    expect(res.stdout).toMatch(/[1-9]\d* errors\n$/);
  });

  test("--json prints only a JSON array on stdout", () => {
    const c = newCase();
    configure(c);
    buildDb(c);
    const res = runCli(["doctor", "--json"], { cwd: c.project, env: { ...env(c), FILESTASH_MAX_LINES: "abc" } });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as CheckResult[];
    expect(Array.isArray(parsed)).toBe(true);
    for (const r of parsed) {
      expect(Object.keys(r).every((k) => ["id", "status", "message", "hint"].includes(k))).toBe(true);
      expect(["ok", "warn", "error", "info"]).toContain(r.status);
    }
    const warn = parsed.find((r) => r.id === "env-filestash_max_lines")!;
    expect(warn.status).toBe("warn");
    expect(warn.hint).toBeTruthy();
  });

  test("help lists the command and its flags", () => {
    const res = runCli(["help"]);
    expect(res.stdout).toContain("agent-file-stash doctor");
    expect(res.stdout).toContain("--json");
    expect(res.stdout).toContain("--check-updates");
  });
});

describe("read-only guarantee", () => {
  function fullCase(): Case {
    const c = newCase();
    writeJson(join(c.home, ".claude.json"), { mcpServers: { filestash: { command: process.execPath, args: ["agent-file-stash", "serve"] } } });
    writeJson(join(c.home, ".claude", "settings.json"), { hooks: { SessionStart: [{ matcher: "clear|compact", hooks: [{ type: "command", command: "npx agent-file-stash reset --from-hook" }] }] } });
    return c;
  }

  function doctorEnv(c: Case): Record<string, string> {
    return { HOME: c.home, XDG_CONFIG_HOME: join(c.home, ".config"), FILESTASH_DIR: c.stashDir };
  }

  test.each([
    ["missing stash directory", (_c: Case) => undefined],
    ["healthy database at rest", (c: Case) => buildDb(c)],
    ["older schema", (c: Case) => buildDb(c, 0)],
    ["newer schema", (c: Case) => buildDb(c, SCHEMA_VERSION + 1)],
    ["corrupt database", (c: Case) => { mkdirSync(c.stashDir, { recursive: true }); writeFileSync(c.dbPath, "garbage".repeat(500)); }],
    ["wide modes, leftovers and a stale lock", (c: Case) => {
      buildDb(c);
      writeFileSync(`${c.dbPath}.corrupt-1700000000000`, "x");
      writeFileSync(`${c.dbPath}.recover.lock`, "1");
      const old = new Date(Date.now() - 60_000);
      utimesSync(`${c.dbPath}.recover.lock`, old, old);
      if (POSIX) { chmodSync(c.dbPath, 0o666); chmodSync(c.stashDir, 0o777); }
    }],
  ])("%s: nothing changes", async (_name, prepare) => {
    const c = fullCase();
    prepare(c);
    const before = snapshot(c.home, c.project);
    await runChecks(opts(c, { checkUpdates: false }));
    expect(snapshot(c.home, c.project)).toEqual(before);
    const res = runCli(["doctor"], { cwd: c.project, env: doctorEnv(c) });
    expect([0, 1]).toContain(res.status);
    expect(snapshot(c.home, c.project)).toEqual(before);
  });

  test("while a real server holds the database open", async () => {
    const sb = createSandbox();
    const home = join(sb.root, "home");
    mkdirSync(home);
    const c: Case = { home, project: sb.project, stashDir: sb.stashDir, dbPath: sb.dbPath };
    vi.stubEnv("FILESTASH_DIR", sb.stashDir);
    writeFileSync(join(sb.project, "app.ts"), "export const a = 1;\n".repeat(30));
    const server = await startServer(sb);
    await server.read(join(sb.project, "app.ts"));
    const before = withoutShmMtime(snapshot(home, sb.project));
    expect(readdirSync(sb.stashDir)).toEqual(expect.arrayContaining(["stash.db", "stash.db-wal", "stash.db-shm"]));

    const inProcess = await checkDatabase(opts(c));
    expect(find(inProcess, "database-schema").status).toBe("ok");
    expect(find(inProcess, "database-stats").message).toContain("1 live and 0 dead");

    const res = runCli(["doctor", "--json"], { cwd: sb.project, env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), FILESTASH_DIR: sb.stashDir } });
    expect((JSON.parse(res.stdout) as CheckResult[]).find((r) => r.id === "database-schema")!.status).toBe("ok");
    expect(withoutShmMtime(snapshot(home, sb.project))).toEqual(before);

    expect(await server.read(join(sb.project, "app.ts"))).toContain("[filestash: unchanged");
    await server.close();
  });
});
