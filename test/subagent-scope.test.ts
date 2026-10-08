import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createStash } from "filestash-sdk";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSubagentScopeHook, type DoctorOptions } from "../packages/cli/src/doctor.js";
import { createSandbox, startServer, runCli, query, cleanupAll } from "./helpers/mcp.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "filestash-scope-")));
let counter = 0;

function newDir(): string {
  const dir = join(ROOT, `case${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function lines(n: number, tag = "line"): string {
  return Array.from({ length: n }, (_, i) => `${tag} ${i + 1} some filler text to make the line longer`).join("\n");
}

function setup(content = lines(40)) {
  const dir = newDir();
  const dbPath = join(dir, "stash.db");
  const file = join(dir, "f.ts");
  writeFileSync(file, content);
  return { dir, dbPath, file };
}

function isUnchanged(text: string): boolean {
  return text.startsWith("[filestash: unchanged");
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("SDK scope isolation", () => {
  test("main and a scope do not see each other's reads", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    const full = (await stash.readFile(file)).content;
    const first = await stash.readFile(file, { scope: "a" });
    expect(first.content).toBe(full);
    expect(isUnchanged((await stash.readFile(file, { scope: "a" })).content)).toBe(true);
    expect(isUnchanged((await stash.readFile(file)).content)).toBe(true);
    await stash.close();
  });

  test("a scope read does not count as delivered to the main agent", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    const scoped = await stash.readFile(file, { scope: "a" });
    const main = await stash.readFile(file);
    expect(main.content).toBe(scoped.content);
    expect(isUnchanged(main.content)).toBe(false);
    await stash.close();
  });

  test("scopes are independent of each other", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    await stash.readFile(file, { scope: "a" });
    const b = await stash.readFile(file, { scope: "b" });
    expect(isUnchanged(b.content)).toBe(false);
    expect(isUnchanged((await stash.readFile(file, { scope: "a" })).content)).toBe(true);
    expect(isUnchanged((await stash.readFile(file, { scope: "b" })).content)).toBe(true);
    await stash.close();
  });

  test("a scope fully seeing the old version gets a diff, another gets real content", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    await stash.readFile(file, { scope: "a" });
    await stash.readFile(file, { scope: "b", offset: 1, limit: 5 });
    writeFileSync(file, lines(40).replace("line 3 ", "edited 3 "));
    const a = await stash.readFile(file, { scope: "a" });
    expect((a as { diff?: string }).diff).toBeDefined();
    const b = await stash.readFile(file, { scope: "b" });
    expect((b as { diff?: string }).diff).toBeUndefined();
    expect(b.content).toContain("edited 3");
    const fresh = await stash.readFile(file, { scope: "c" });
    expect((fresh as { diff?: string }).diff).toBeUndefined();
    await stash.close();
  });

  test("partial ranges are tracked per scope", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    await stash.readFile(file, { scope: "a", offset: 1, limit: 10 });
    expect(isUnchanged((await stash.readFile(file, { scope: "a", offset: 1, limit: 10 })).content)).toBe(true);
    expect(isUnchanged((await stash.readFile(file, { scope: "b", offset: 1, limit: 10 })).content)).toBe(false);
    expect(isUnchanged((await stash.readFile(file, { scope: "a", offset: 1, limit: 20 })).content)).toBe(false);
    expect(isUnchanged((await stash.readFile(file, { offset: 1, limit: 10 })).content)).toBe(false);
    await stash.close();
  });

  test("invalid scopes act as the main agent and never throw", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    await stash.readFile(file);
    for (const bad of ["", "a b", "a::b", "x".repeat(65), "../x", "a/b", "ñ"]) {
      const res = await stash.readFile(file, { scope: bad });
      expect(isUnchanged(res.content), JSON.stringify(bad)).toBe(true);
    }
    const full = await stash.readFileFull(file, "a b");
    expect(full.content).toContain("line 1 ");
    await stash.close();
    const rows = query(dbPath, "SELECT session_id FROM session_reads");
    expect(rows).toEqual([{ session_id: "s1" }]);
  });

  test("readFileFull with a scope resets only that scope", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    await stash.readFile(file);
    await stash.readFile(file, { scope: "a" });
    const full = await stash.readFileFull(file, "a");
    expect(isUnchanged(full.content)).toBe(false);
    expect(isUnchanged((await stash.readFile(file, { scope: "a" })).content)).toBe(true);
    expect(isUnchanged((await stash.readFile(file)).content)).toBe(true);
    await stash.close();
  });

  test("session ids with the scope delimiter are sanitized", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "x::y" }).stash;
    await stash.readFile(file);
    await stash.close();
    expect(query<{ session_id: string }>(dbPath, "SELECT session_id FROM session_reads")[0]!.session_id).not.toContain("::");
  });

  test("accounting stays consistent across mixed scopes", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    await stash.readFile(file);
    await stash.readFile(file, { scope: "a" });
    await stash.readFile(file, { scope: "a" });
    await stash.readFile(file);
    await stash.readFile(file, { scope: "b", offset: 1, limit: 5 });
    writeFileSync(file, lines(40).replace("line 7 ", "edited 7 "));
    await stash.readFile(file, { scope: "a" });
    await stash.readFile(file);
    const stats = await stash.getStats();
    expect(stats.sessionReads).toBe(7);
    expect(stats.sessionBaselineTokens - stats.sessionSentTokens).toBe(stats.sessionTokensSaved);
    expect(stats.sessionTokensSaved).toBeGreaterThan(0);
    await stash.close();
  });

  test("resetReads clears every scope", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    await stash.readFile(file);
    await stash.readFile(file, { scope: "a" });
    await stash.resetReads();
    expect(isUnchanged((await stash.readFile(file)).content)).toBe(false);
    expect(isUnchanged((await stash.readFile(file, { scope: "a" })).content)).toBe(false);
    await stash.close();
  });

  test("clear and onFileDeleted drop scoped rows", async () => {
    const { dbPath, file } = setup();
    const stash = createStash({ dbPath, sessionId: "s1" }).stash;
    await stash.readFile(file, { scope: "a" });
    await stash.onFileDeleted(file);
    expect(query(dbPath, "SELECT 1 FROM session_reads")).toHaveLength(0);
    expect(query(dbPath, "SELECT 1 FROM session_ranges")).toHaveLength(0);
    await stash.readFile(file, { scope: "a" });
    await stash.clear();
    expect(query(dbPath, "SELECT 1 FROM session_reads")).toHaveLength(0);
    expect(query(dbPath, "SELECT 1 FROM session_ranges")).toHaveLength(0);
    await stash.close();
  });
});

describe("scoped tracking and pruning", () => {
  function deadPid(): number {
    return spawnSync(process.execPath, ["-e", ""]).pid!;
  }

  function sessionIds(dbPath: string, table: string): string[] {
    return query<{ session_id: string }>(dbPath, `SELECT DISTINCT session_id FROM ${table} ORDER BY session_id`).map((r) => r.session_id);
  }

  test("scoped rows of a dead session are pruned, those of a live session are kept", async () => {
    const { dbPath, file, dir } = setup();
    const onlyScoped = join(dir, "only-scoped.ts");
    writeFileSync(onlyScoped, lines(30, "scoped"));
    const live = createStash({ dbPath, sessionId: "live" }).stash;
    const dead = createStash({ dbPath, sessionId: "dead" }).stash;
    await live.readFile(file, { scope: "a" });
    await live.readFile(onlyScoped, { scope: "a" });
    await dead.readFile(file);
    await dead.readFile(file, { scope: "a" });
    await dead.readFile(file, { scope: "b", offset: 1, limit: 5 });
    expect(sessionIds(dbPath, "session_reads")).toEqual(["dead", "dead::a", "dead::b", "live::a"]);

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE sessions SET pid = ? WHERE session_id = 'dead'").run(deadPid());
    db.close();

    const fresh = createStash({ dbPath, sessionId: "fresh" }).stash;
    await fresh.init();
    expect(sessionIds(dbPath, "session_reads")).toEqual(["live::a"]);
    expect(sessionIds(dbPath, "session_ranges")).toEqual(["live::a"]);
    const versions = query<{ path: string }>(dbPath, "SELECT path FROM file_versions").map((r) => r.path).sort();
    expect(versions).toEqual([file, onlyScoped].sort());
    expect(isUnchanged((await live.readFile(onlyScoped, { scope: "a" })).content)).toBe(true);
    await Promise.all([live.close(), dead.close(), fresh.close()]);
  });

  test("a live scoped row keeps its file version while the base session is alive", async () => {
    const { dbPath, file } = setup();
    const live = createStash({ dbPath, sessionId: "live" }).stash;
    await live.readFile(file, { scope: "a" });
    const other = createStash({ dbPath, sessionId: "other" }).stash;
    await other.init();
    expect(query(dbPath, "SELECT 1 FROM file_versions")).toHaveLength(1);
    await Promise.all([live.close(), other.close()]);
  });

  test("at most 32 scopes per session, the least recently used is evicted", async () => {
    const { dbPath, file } = setup();
    let clock = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (clock += 10));
    try {
      const stash = createStash({ dbPath, sessionId: "s1" }).stash;
      for (let i = 0; i < 32; i++) await stash.readFile(file, { scope: `s${i}` });
      expect(sessionIds(dbPath, "session_reads")).toHaveLength(32);
      expect(isUnchanged((await stash.readFile(file, { scope: "s0" })).content)).toBe(true);
      await stash.readFile(file, { scope: "s32" });
      const ids = sessionIds(dbPath, "session_reads");
      expect(ids).toHaveLength(32);
      expect(ids).not.toContain("s1::s1");
      expect(ids).toContain("s1::s0");
      expect(sessionIds(dbPath, "session_ranges")).toEqual(ids);
      expect(isUnchanged((await stash.readFile(file, { scope: "s0" })).content)).toBe(true);
      expect(isUnchanged((await stash.readFile(file, { scope: "s1" })).content)).toBe(false);
      expect(sessionIds(dbPath, "session_reads")).toHaveLength(32);
      await stash.close();
    } finally {
      spy.mockRestore();
    }
  });

  test("the cap does not touch the main tracking or other sessions", async () => {
    const { dbPath, file } = setup();
    const a = createStash({ dbPath, sessionId: "a" }).stash;
    const b = createStash({ dbPath, sessionId: "b" }).stash;
    await a.readFile(file);
    await b.readFile(file, { scope: "x" });
    for (let i = 0; i < 40; i++) await a.readFile(file, { scope: `n${i}` });
    expect(isUnchanged((await a.readFile(file)).content)).toBe(true);
    expect(isUnchanged((await b.readFile(file, { scope: "x" })).content)).toBe(true);
    await Promise.all([a.close(), b.close()]);
  });
});

describe("MCP agent argument", () => {
  afterEach(cleanupAll);

  test("read_file with agent isolates, without it behaves as before", async () => {
    const sb = createSandbox();
    const file = join(sb.project, "f.ts");
    writeFileSync(file, lines(40));
    const server = await startServer(sb);
    const first = await server.read(file);
    expect(isUnchanged(first)).toBe(false);
    const sub = await server.read(file, { agent: "agent1" });
    expect(isUnchanged(sub)).toBe(false);
    expect(isUnchanged(await server.read(file, { agent: "agent1" }))).toBe(true);
    expect(isUnchanged(await server.read(file, { agent: "agent2" }))).toBe(false);
    expect(isUnchanged(await server.read(file))).toBe(true);
    const full = await server.read(file, { agent: "agent1", force: true });
    expect(isUnchanged(full)).toBe(false);
    expect(isUnchanged(await server.read(file, { agent: "agent1" }))).toBe(true);
  });

  test("a subagent read is not delivered to the main agent", async () => {
    const sb = createSandbox();
    const file = join(sb.project, "only-sub.ts");
    writeFileSync(file, lines(40));
    const server = await startServer(sb);
    await server.read(file, { agent: "agent1" });
    expect(isUnchanged(await server.read(file))).toBe(false);
  });

  test("read_files accepts agent", async () => {
    const sb = createSandbox();
    const f1 = join(sb.project, "a.ts");
    const f2 = join(sb.project, "b.ts");
    writeFileSync(f1, lines(40, "a"));
    writeFileSync(f2, lines(40, "b"));
    const server = await startServer(sb);
    const paths = [f1, f2];
    await server.call("read_files", { paths });
    const sub = await server.call("read_files", { paths, agent: "agent1" });
    expect(sub.isError).toBe(false);
    expect(sub.text).not.toContain("[filestash: unchanged");
    const again = await server.call("read_files", { paths, agent: "agent1" });
    expect(again.text.match(/\[filestash: unchanged/g)).toHaveLength(2);
    const main = await server.call("read_files", { paths });
    expect(main.text.match(/\[filestash: unchanged/g)).toHaveLength(2);
  });
});

describe("hook subagent-scope", () => {
  const input = { path: "/p/f.ts", offset: 3, limit: 4, force: true };
  const payload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "sess",
      cwd: "/p",
      hook_event_name: "PreToolUse",
      tool_name: "mcp__filestash__read_file",
      tool_input: input,
      agent_id: "ab12cd",
      agent_type: "general-purpose",
      ...over,
    });
  const hook = (stdin: string) => runCli(["hook", "subagent-scope"], { input: stdin });

  test("a subagent read_file call gets its agent id added to the full tool input", () => {
    const res = hook(payload());
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, agent: "ab12cd" } },
    });
    expect(res.stdout).not.toContain("permissionDecision");
  });

  test("read_files and the alternative server key are handled", () => {
    for (const tool of ["mcp__filestash__read_files", "mcp__agent-file-stash__read_files", "mcp__agent-file-stash__read_file"]) {
      const res = hook(payload({ tool_name: tool, tool_input: { paths: ["a"] } }));
      expect(JSON.parse(res.stdout).hookSpecificOutput.updatedInput).toEqual({ paths: ["a"], agent: "ab12cd" });
    }
  });

  test("a call without agent_id prints nothing", () => {
    const body = JSON.parse(payload());
    delete body.agent_id;
    const res = hook(JSON.stringify(body));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
  });

  test("other tools print nothing", () => {
    for (const tool of ["Read", "mcp__filestash__stash_status", "mcp__filestash__stash_clear", "Bash"]) {
      const res = hook(payload({ tool_name: tool }));
      expect(res.status, tool).toBe(0);
      expect(res.stdout, tool).toBe("");
    }
  });

  test("malformed, empty or unusable input prints nothing and exits 0", () => {
    const cases = [
      "{broken",
      "",
      "null",
      "[]",
      payload({ agent_id: "has space" }),
      payload({ agent_id: "a::b" }),
      payload({ agent_id: "" }),
      payload({ agent_id: 7 }),
      payload({ agent_id: "x".repeat(65) }),
      payload({ tool_input: "text" }),
      payload({ tool_input: null }),
      payload({ tool_input: [1] }),
      payload({ tool_name: 5 }),
    ];
    for (const stdin of cases) {
      const res = hook(stdin);
      expect(res.status, stdin).toBe(0);
      expect(res.stdout, stdin).toBe("");
    }
  });

  test("never emits a permission decision", () => {
    const res = hook(payload({ tool_input: { path: "/x", permissionDecision: "deny" } }));
    expect(JSON.parse(res.stdout).hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(Object.keys(JSON.parse(res.stdout))).toEqual(["hookSpecificOutput"]);
  });

  test("does not create a database", () => {
    const dir = newDir();
    const res = runCli(["hook", "subagent-scope"], { cwd: dir, input: payload(), env: { FILESTASH_DIR: join(dir, ".stash") } });
    expect(res.status).toBe(0);
    expect(existsSync(join(dir, ".stash"))).toBe(false);
  });
});

describe("init --hooks registers the subagent hook", () => {
  const scopeCommand = "npx agent-file-stash hook subagent-scope";
  const scopeMatcher = "mcp__(filestash|agent-file-stash)__read_files?";

  function env(home: string) {
    return { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  }

  function settingsOf(home: string) {
    return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
  }

  const scopeEntries = (settings: any) =>
    (settings.hooks.PreToolUse as any[]).filter((e) => e.hooks.some((h: any) => h.command === scopeCommand));

  test("without --hooks the snippet shows both hooks and nothing is written", () => {
    const home = newDir();
    mkdirSync(join(home, ".claude"));
    const res = runCli(["init"], { env: env(home) });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("SessionStart");
    expect(res.stdout).toContain("reset --from-hook");
    expect(res.stdout).toContain("PreToolUse");
    expect(res.stdout).toContain(scopeCommand);
    expect(res.stdout).toContain(scopeMatcher);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  test("registers both hooks, keeps unrelated keys, backs up and is idempotent", () => {
    const home = newDir();
    mkdirSync(join(home, ".claude"));
    const original = {
      model: "opus",
      permissions: { deny: ["Read(.env)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
      },
    };
    const settingsPath = join(home, ".claude", "settings.json");
    const text = JSON.stringify(original, null, 2);
    writeFileSync(settingsPath, text);

    expect(runCli(["init", "--hooks"], { env: env(home) }).status).toBe(0);
    const once = settingsOf(home);
    expect(once.model).toBe("opus");
    expect(once.permissions).toEqual(original.permissions);
    expect(once.hooks.Stop).toEqual(original.hooks.Stop);
    expect(once.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(scopeEntries(once)).toEqual([{ matcher: scopeMatcher, hooks: [{ type: "command", command: scopeCommand }] }]);
    expect(once.hooks.SessionStart).toHaveLength(1);
    expect(readFileSync(`${settingsPath}.bak`, "utf-8")).toBe(text);

    expect(runCli(["init", "--hooks"], { env: env(home) }).status).toBe(0);
    expect(settingsOf(home)).toEqual(once);
  });

  test("adds only the missing hook when the reset hook already exists", () => {
    const home = newDir();
    mkdirSync(join(home, ".claude"));
    const reset = { matcher: "clear|compact", hooks: [{ type: "command", command: "npx agent-file-stash reset --from-hook" }] };
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [reset] } }));
    expect(runCli(["init", "--hooks"], { env: env(home) }).status).toBe(0);
    const settings = settingsOf(home);
    expect(settings.hooks.SessionStart).toEqual([reset]);
    expect(scopeEntries(settings)).toHaveLength(1);
  });

  test("creates settings.json when absent", () => {
    const home = newDir();
    expect(runCli(["init", "--hooks"], { env: env(home) }).status).toBe(0);
    const settings = settingsOf(home);
    expect(scopeEntries(settings)).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(existsSync(join(home, ".claude", "settings.json.bak"))).toBe(false);
  });
});

describe("doctor hook-subagent-scope check", () => {
  function opts(): { o: DoctorOptions; home: string; project: string } {
    const base = newDir();
    const home = join(base, "home");
    const project = join(base, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    const o: DoctorOptions = { nodeVersion: "26.0.0", cwd: project, home, platform: process.platform, now: Date.now(), checkUpdates: false, fetchLatest: () => undefined };
    return { o, home, project };
  }

  function writeSettings(path: string, preToolUse: unknown): void {
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: preToolUse } }));
  }

  const entry = (command: string, matcher: string | undefined = "mcp__(filestash|agent-file-stash)__read_files?") => ({
    ...(matcher !== undefined && { matcher }),
    hooks: [{ type: "command", command }],
  });

  test("ok with the direct command", () => {
    const { o, home } = opts();
    writeSettings(join(home, ".claude", "settings.json"), [entry("npx agent-file-stash hook subagent-scope")]);
    expect(checkSubagentScopeHook(o)).toEqual([expect.objectContaining({ id: "hook-subagent-scope", status: "ok" })]);
  });

  test("ok from project settings through a wrapper script", () => {
    const { o, project } = opts();
    const script = join(project, "scope.sh");
    writeFileSync(script, "#!/bin/sh\nexec npx agent-file-stash hook subagent-scope\n");
    chmodSync(script, 0o755);
    writeSettings(join(project, ".claude", "settings.local.json"), [entry(script)]);
    expect(checkSubagentScopeHook(o)[0]!.status).toBe("ok");
  });

  test("ok with a catch-all matcher or none", () => {
    const { o, home } = opts();
    writeSettings(join(home, ".claude", "settings.json"), [entry("npx agent-file-stash hook subagent-scope", undefined)]);
    expect(checkSubagentScopeHook(o)[0]!.status).toBe("ok");
  });

  test("warns when absent", () => {
    const { o } = opts();
    const [r] = checkSubagentScopeHook(o);
    expect(r).toMatchObject({ id: "hook-subagent-scope", status: "warn", hint: expect.stringContaining("agent-file-stash init --hooks") });
    expect(r!.hint).toContain("share read tracking");
  });

  test("warns when the matcher does not match the stash tools", () => {
    const { o, home } = opts();
    writeSettings(join(home, ".claude", "settings.json"), [entry("npx agent-file-stash hook subagent-scope", "Bash")]);
    expect(checkSubagentScopeHook(o)[0]!.status).toBe("warn");
  });

  test("warns when only an unrelated hook or the reset hook is configured", () => {
    const { o, home } = opts();
    writeSettings(join(home, ".claude", "settings.json"), [entry("echo hi"), entry("npx agent-file-stash reset --from-hook")]);
    expect(checkSubagentScopeHook(o)[0]!.status).toBe("warn");
  });

  test("an unreadable settings file is skipped", () => {
    const { o, home } = opts();
    writeFileSync(join(home, ".claude", "settings.json"), "{broken");
    expect(checkSubagentScopeHook(o)[0]!.status).toBe("warn");
  });
});
