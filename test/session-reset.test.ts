import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createStash } from "filestash-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli.mjs");
const TEST_DIR = realpathSync(mkdtempSync(join(tmpdir(), "filestash-reset-")));
const FILE_PATH = join(TEST_DIR, "sample.ts");

let dirCounter = 0;

function newDir(): string {
  const dir = join(TEST_DIR, `case${dirCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function open(dbPath: string, sessionId: string) {
  return createStash({ dbPath, sessionId });
}

function count(dbPath: string, sql: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(sql).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? TEST_DIR,
    env: { ...process.env, ...opts.env },
    input: opts.input ?? "",
    encoding: "utf-8",
  });
}

beforeAll(() => {
  writeFileSync(FILE_PATH, "const x = 1;\n// padding padding padding padding padding padding padding padding padding padding padding padding \n");
});

afterAll(async () => {
  for (const h of liveSeeds) {
    h.watcher.close();
    await h.stash.close();
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("StashStore.resetReads", () => {
  test("clears session_reads only", async () => {
    const dbPath = join(newDir(), "stash.db");
    const h = open(dbPath, "a");
    try {
      await h.stash.readFile(FILE_PATH);
      await h.stash.readFile(FILE_PATH);
      const before = {
        versions: count(dbPath, "SELECT COUNT(*) c FROM file_versions"),
        stats: count(dbPath, "SELECT COUNT(*) c FROM stats WHERE value > 0"),
        sessionStats: count(dbPath, "SELECT COUNT(*) c FROM session_stats"),
        sessions: count(dbPath, "SELECT COUNT(*) c FROM sessions"),
      };
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(1);

      await h.stash.resetReads();

      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(before.versions);
      expect(count(dbPath, "SELECT COUNT(*) c FROM stats WHERE value > 0")).toBe(before.stats);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_stats")).toBe(before.sessionStats);
      expect(count(dbPath, "SELECT COUNT(*) c FROM sessions")).toBe(before.sessions);
    } finally {
      h.watcher.close();
      await h.stash.close();
    }
  });

  test("next read returns full content, then unchanged again", async () => {
    const dbPath = join(newDir(), "stash.db");
    const h = open(dbPath, "a");
    try {
      await h.stash.readFile(FILE_PATH);
      expect((await h.stash.readFile(FILE_PATH)).stashed).toBe(true);

      await h.stash.resetReads();

      const full = await h.stash.readFile(FILE_PATH);
      expect(full.stashed).toBe(false);
      expect(full.content).toContain("const x = 1;");
      const again = await h.stash.readFile(FILE_PATH);
      expect(again.stashed).toBe(true);
      expect(again.content).toContain("unchanged");
    } finally {
      h.watcher.close();
      await h.stash.close();
    }
  });

  test("affects other live sessions in the same DB without throwing", async () => {
    const dbPath = join(newDir(), "stash.db");
    const a = open(dbPath, "a");
    const b = open(dbPath, "b");
    try {
      await a.stash.readFile(FILE_PATH);
      await b.stash.readFile(FILE_PATH);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(2);

      await expect(a.stash.resetReads()).resolves.toBeUndefined();

      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(0);
      expect((await b.stash.readFile(FILE_PATH)).stashed).toBe(false);
    } finally {
      for (const h of [a, b]) {
        h.watcher.close();
        await h.stash.close();
      }
    }
  });
});

const liveSeeds: ReturnType<typeof open>[] = [];

async function seedDb(dir: string, reads = 2): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "stash.db");
  const h = open(dbPath, `seed${liveSeeds.length}`);
  liveSeeds.push(h);
  for (let i = 0; i < reads; i++) await h.stash.readFile(FILE_PATH);
  return dbPath;
}

describe("agent-file-stash reset", () => {
  test("clears read tracking of a real DB and confirms on stdout", async () => {
    const dir = newDir();
    const dbPath = await seedDb(dir);
    expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(1);

    const res = runCli(["reset"], { env: { FILESTASH_DIR: dir } });

    expect(res.status).toBe(0);
    expect(res.stdout.trim().split("\n")).toHaveLength(1);
    expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(0);
    expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBeGreaterThan(0);
  });

  test("resolves a relative FILESTASH_DIR against cwd", async () => {
    const dir = newDir();
    const dbPath = await seedDb(join(dir, "rel"), 2);

    const res = runCli(["reset"], { cwd: dir, env: { FILESTASH_DIR: "rel" } });

    expect(res.status).toBe(0);
    expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(0);
  });

  test("--from-hook resolves a relative FILESTASH_DIR against the hook cwd, silently", async () => {
    const project = newDir();
    const dbPath = await seedDb(join(project, ".fs"), 2);
    const elsewhere = newDir();

    const res = runCli(["reset", "--from-hook"], {
      cwd: elsewhere,
      env: { FILESTASH_DIR: ".fs" },
      input: JSON.stringify({ cwd: project, hook_event_name: "SessionStart" }),
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(0);
  });

  test("missing DB exits 0 and does not create one", () => {
    const dir = newDir();
    for (const args of [["reset"], ["reset", "--from-hook"]]) {
      const res = runCli(args, { env: { FILESTASH_DIR: join(dir, "none") } });
      expect(res.status).toBe(0);
      expect(res.stderr).toBe("");
      if (args.length === 2) expect(res.stdout).toBe("");
    }
    expect(existsSync(join(dir, "none"))).toBe(false);
  });

  test("--from-hook with malformed or empty stdin falls back to process cwd without crashing", async () => {
    for (const input of ["{not json", "", '{"cwd": 42}', "[]"]) {
      const dir = newDir();
      const dbPath = await seedDb(dir, 2);
      const res = runCli(["reset", "--from-hook"], { cwd: dir, env: { FILESTASH_DIR: "." }, input });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(0);
    }
  });

  test("unexpected error exits 0 with --from-hook and 1 without", () => {
    const dir = newDir();
    writeFileSync(join(dir, "stash.db"), "not a database");
    const hook = runCli(["reset", "--from-hook"], { env: { FILESTASH_DIR: dir } });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe("");
    expect(hook.stderr.trim().split("\n")).toHaveLength(1);
    const manual = runCli(["reset"], { env: { FILESTASH_DIR: dir } });
    expect(manual.status).toBe(1);
  });

  test("help lists reset", () => {
    expect(runCli(["help"]).stdout).toContain("agent-file-stash reset");
  });
});

describe("init hooks", () => {
  const hookCommand = "npx agent-file-stash reset --from-hook";

  function newHome(): string {
    return newDir();
  }

  function settingsOf(home: string) {
    return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  }

  function countHook(settings: any): number {
    return (settings.hooks.SessionStart as any[]).filter((e) =>
      e.hooks.some((h: any) => h.command === hookCommand),
    ).length;
  }

  test("prints the snippet and writes nothing without --hooks", () => {
    const home = newHome();
    mkdirSync(join(home, ".claude"));
    const res = runCli(["init"], { env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") } });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"matcher": "clear|compact"');
    expect(res.stdout).toContain(hookCommand);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  test("creates settings.json (and dirs) when absent, no backup", () => {
    const home = newHome();
    const res = runCli(["init", "--hooks"], { env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") } });
    expect(res.status).toBe(0);
    const settings = settingsOf(home);
    expect(settings.hooks.SessionStart).toEqual([
      { matcher: "clear|compact", hooks: [{ type: "command", command: hookCommand }] },
    ]);
    expect(existsSync(join(home, ".claude", "settings.json.bak"))).toBe(false);
  });

  test("merges into existing settings, preserves content, backs up, and is idempotent", () => {
    const home = newHome();
    mkdirSync(join(home, ".claude"));
    const original = {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
      },
    };
    const settingsPath = join(home, ".claude", "settings.json");
    const originalText = JSON.stringify(original, null, 2);
    writeFileSync(settingsPath, originalText);
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };

    expect(runCli(["init", "--hooks"], { env }).status).toBe(0);
    const once = settingsOf(home);
    expect(once.model).toBe("opus");
    expect(once.permissions).toEqual(original.permissions);
    expect(once.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(once.hooks.PreToolUse).toHaveLength(2);
    expect(once.hooks.SessionStart[0]).toEqual(original.hooks.SessionStart[0]);
    expect(countHook(once)).toBe(1);
    expect(readFileSync(`${settingsPath}.bak`, "utf-8")).toBe(originalText);

    expect(runCli(["init", "--hooks"], { env }).status).toBe(0);
    expect(settingsOf(home)).toEqual(once);
    expect(countHook(settingsOf(home))).toBe(1);
  });

  test("leaves a malformed settings.json untouched", () => {
    const home = newHome();
    mkdirSync(join(home, ".claude"));
    const settingsPath = join(home, ".claude", "settings.json");
    writeFileSync(settingsPath, "{broken");
    const res = runCli(["init", "--hooks"], { env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") } });
    expect(res.status).toBe(0);
    expect(readFileSync(settingsPath, "utf-8")).toBe("{broken");
    expect(existsSync(`${settingsPath}.bak`)).toBe(false);
  });

  function writeScript(home: string, name: string, body: string): string {
    const dir = join(home, ".claude", "hooks");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  }

  test("recognizes hooks that run through wrapper scripts and adds nothing", () => {
    const home = newHome();
    const reset = writeScript(home, "reset.sh", "#!/usr/bin/env bash\nexec agent-file-stash reset --from-hook\n");
    const scope = writeScript(home, "scope.sh", "#!/usr/bin/env bash\nexec agent-file-stash hook subagent-scope\n");
    const settingsPath = join(home, ".claude", "settings.json");
    const text = JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "clear|compact", hooks: [{ type: "command", command: `bash ${reset}` }] }],
        PreToolUse: [{ matcher: "mcp__(filestash|agent-file-stash)__read_files?", hooks: [{ type: "command", command: `bash ${scope}` }] }],
      },
    }, null, 2);
    writeFileSync(settingsPath, text);
    const res = runCli(["init", "--hooks"], { env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") } });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Claude Code hooks: already configured");
    expect(readFileSync(settingsPath, "utf-8")).toBe(text);
    expect(existsSync(`${settingsPath}.bak`)).toBe(false);
  });

  test("adds only the hook that is missing or does not cover clear and compact", () => {
    const home = newHome();
    const scope = writeScript(home, "scope.sh", "#!/usr/bin/env bash\nexec agent-file-stash hook subagent-scope\n");
    const other = writeScript(home, "other.sh", "#!/usr/bin/env bash\necho hi\n");
    const settingsPath = join(home, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "clear", hooks: [{ type: "command", command: "npx agent-file-stash reset --from-hook" }] }, { hooks: [{ type: "command", command: `bash ${other}` }] }],
        PreToolUse: [{ matcher: "mcp__(filestash|agent-file-stash)__read_files?", hooks: [{ type: "command", command: `bash ${scope}` }] }],
      },
    }));
    expect(runCli(["init", "--hooks"], { env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") } }).status).toBe(0);
    const after = settingsOf(home);
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(after.hooks.SessionStart).toHaveLength(3);
    expect(after.hooks.SessionStart[2]).toEqual({ matcher: "clear|compact", hooks: [{ type: "command", command: hookCommand }] });
  });
});

describe("MCP server integration", () => {
  test("repeat read is unchanged; after reset the read returns full content", async () => {
    const dir = newDir();
    const file = join(dir, "doc.ts");
    writeFileSync(file, "export const answer = 42;\n// padding padding padding padding padding padding padding padding padding padding padding padding \n");
    const stashDir = join(dir, ".stash");
    const env = { FILESTASH_DIR: stashDir };

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "serve"],
      cwd: dir,
      env: { ...(process.env as Record<string, string>), ...env },
    });
    const client = new Client({ name: "reset-test", version: "0.0.0" });
    await client.connect(transport);
    const read = async () => {
      const res = (await client.callTool({ name: "read_file", arguments: { path: file } })) as {
        content: { text: string }[];
      };
      return res.content[0]!.text;
    };

    try {
      expect(await read()).toContain("export const answer = 42;");
      expect(await read()).toContain("[filestash: unchanged");

      const reset = runCli(["reset"], { cwd: dir, env });
      expect(reset.status).toBe(0);

      expect(await read()).toContain("export const answer = 42;");
      expect(await read()).toContain("[filestash: unchanged");
    } finally {
      await client.close();
    }
  });
});
