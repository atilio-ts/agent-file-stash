import { describe, test, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkOhMyPiExtension, type DoctorOptions } from "../packages/cli/src/doctor.js";
import { OMP_EXTENSION_SOURCE, ompExtensionPath } from "../packages/cli/src/omp-extension.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.mjs");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "filestash-omp-")));
let counter = 0;

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function newHome(withOmp = true): string {
  const home = join(ROOT, `home${counter++}`);
  mkdirSync(withOmp ? join(home, ".omp", "agent") : home, { recursive: true });
  return home;
}

function runInit(home: string, args: string[] = []) {
  return spawnSync(process.execPath, [CLI, "init", ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    encoding: "utf-8",
  });
}

const doctorOpts = (home: string) => ({ home, cwd: ROOT }) as DoctorOptions;

type Handler = (event: unknown, ctx: unknown) => unknown;

async function loadExtension(): Promise<Map<string, Handler>> {
  const file = join(ROOT, `ext${counter++}.mjs`);
  writeFileSync(file, OMP_EXTENSION_SOURCE);
  const handlers = new Map<string, Handler>();
  const mod = await import(pathToFileURL(file).href);
  mod.default({ on: (name: string, fn: Handler) => handlers.set(name, fn) });
  return handlers;
}

describe("Oh My Pi extension logic", () => {
  const sub = { kind: "sub", id: "0-SwiftFox", name: "task" };

  test("subagent read gets its agent id injected", async () => {
    const h = await loadExtension();
    for (const toolName of ["mcp__filestash_read_file", "mcp__filestash_read_files", "mcp__agent_file_stash_read_file"]) {
      expect(h.get("tool_call")!({ toolName, input: { path: "a.ts" } }, { agent: sub })).toEqual({ input: { path: "a.ts", agent: "0-SwiftFox" } });
    }
  });

  test("overwrites an agent value supplied by the model", async () => {
    const h = await loadExtension();
    const r = h.get("tool_call")!({ toolName: "mcp__filestash_read_file", input: { path: "a.ts", agent: "forged" } }, { agent: sub });
    expect(r).toEqual({ input: { path: "a.ts", agent: "0-SwiftFox" } });
  });

  test("main agent, other tools and bad input pass through untouched", async () => {
    const h = await loadExtension();
    const call = h.get("tool_call")!;
    const read = { toolName: "mcp__filestash_read_file", input: { path: "a.ts" } };
    expect(call(read, { agent: { kind: "main", id: "main" } })).toBeUndefined();
    expect(call(read, {})).toBeUndefined();
    expect(call({ toolName: "mcp__filestash_stash_status", input: {} }, { agent: sub })).toBeUndefined();
    expect(call({ toolName: "read", input: { path: "a.ts" } }, { agent: sub })).toBeUndefined();
    expect(call({ toolName: "mcp__other_read_file", input: { path: "a.ts" } }, { agent: sub })).toBeUndefined();
    expect(call(read, { agent: { kind: "sub", id: "bad id/../x" } })).toBeUndefined();
    expect(call({ ...read, input: null }, { agent: sub })).toBeUndefined();
    expect(call({ ...read, input: ["a.ts"] }, { agent: sub })).toBeUndefined();
  });

  test("a malformed event never throws", async () => {
    const h = await loadExtension();
    expect(() => h.get("tool_call")!(undefined, undefined)).not.toThrow();
  });

  test("compact and switch run reset with the session cwd on stdin", async () => {
    const bin = join(ROOT, `bin${counter++}`);
    const log = join(bin, "log.txt");
    mkdirSync(bin);
    writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$@" >> "${log}"\ncat >> "${log}"\necho >> "${log}"\n`);
    chmodSync(join(bin, "npx"), 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${original}`;
    try {
      const h = await loadExtension();
      h.get("session_compact")!({}, { cwd: "/work/proj" });
      h.get("session_switch")!({}, { cwd: "/work/other" });
    } finally {
      process.env.PATH = original;
    }
    const out = readFileSync(log, "utf-8");
    expect(out.match(/agent-file-stash reset --from-hook/g)).toHaveLength(2);
    expect(out).toContain('{"cwd":"/work/proj"}');
    expect(out).toContain('{"cwd":"/work/other"}');
  });

  test("reset failure never throws", async () => {
    const original = process.env.PATH;
    process.env.PATH = join(ROOT, "nowhere");
    try {
      const h = await loadExtension();
      expect(() => h.get("session_compact")!({}, { cwd: ROOT })).not.toThrow();
    } finally {
      process.env.PATH = original;
    }
  });
});

describe("init with Oh My Pi", () => {
  test("registers the MCP server and only hints about the extension without --hooks", () => {
    const home = newHome();
    const res = runInit(home);
    expect(res.status).toBe(0);
    const config = JSON.parse(readFileSync(join(home, ".omp", "agent", "mcp.json"), "utf-8"));
    expect(config.mcpServers.filestash).toEqual({ command: "npx", args: ["agent-file-stash", "serve"] });
    expect(existsSync(ompExtensionPath(home))).toBe(false);
    expect(res.stdout).toContain("For Oh My Pi, re-run 'init --hooks'");
  });

  test("--hooks writes the extension and is idempotent", () => {
    const home = newHome();
    const first = runInit(home, ["--hooks"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Oh My Pi extension: configured");
    expect(readFileSync(ompExtensionPath(home), "utf-8")).toBe(OMP_EXTENSION_SOURCE);
    const second = runInit(home, ["--hooks"]);
    expect(second.stdout).toContain("Oh My Pi extension: already configured");
    expect(readFileSync(ompExtensionPath(home), "utf-8")).toBe(OMP_EXTENSION_SOURCE);
  });

  test("--hooks leaves an edited extension untouched", () => {
    const home = newHome();
    mkdirSync(join(home, ".omp", "agent", "extensions"), { recursive: true });
    writeFileSync(ompExtensionPath(home), "// mine\n");
    const res = runInit(home, ["--hooks"]);
    expect(res.stdout).toContain("left untouched");
    expect(readFileSync(ompExtensionPath(home), "utf-8")).toBe("// mine\n");
  });

  test("keeps existing MCP servers when merging", () => {
    const home = newHome();
    const original = { mcpServers: { other: { type: "stdio", command: "x" } } };
    writeFileSync(join(home, ".omp", "agent", "mcp.json"), JSON.stringify(original));
    expect(runInit(home, ["--hooks"]).status).toBe(0);
    const config = JSON.parse(readFileSync(join(home, ".omp", "agent", "mcp.json"), "utf-8"));
    expect(config.mcpServers.other).toEqual(original.mcpServers.other);
    expect(config.mcpServers.filestash).toBeDefined();
  });

  test("without an Oh My Pi directory nothing is written", () => {
    const home = newHome(false);
    const res = runInit(home, ["--hooks"]);
    expect(res.status).toBe(0);
    expect(existsSync(join(home, ".omp"))).toBe(false);
    expect(res.stdout).not.toContain("Oh My Pi");
  });
});

describe("doctor Oh My Pi extension check", () => {
  test("silent when Oh My Pi is not installed", () => {
    expect(checkOhMyPiExtension(doctorOpts(newHome(false)))).toEqual([]);
  });

  test("warns when the extension is missing", () => {
    const [r] = checkOhMyPiExtension(doctorOpts(newHome()));
    expect(r).toMatchObject({ id: "hook-oh-my-pi", status: "warn" });
    expect(r!.hint).toContain("init --hooks");
  });

  test("ok after init --hooks", () => {
    const home = newHome();
    runInit(home, ["--hooks"]);
    expect(checkOhMyPiExtension(doctorOpts(home))[0]).toMatchObject({ id: "hook-oh-my-pi", status: "ok" });
  });

  test("warns when the file does not run agent-file-stash", () => {
    const home = newHome();
    mkdirSync(join(home, ".omp", "agent", "extensions"), { recursive: true });
    writeFileSync(ompExtensionPath(home), "export default function () {}\n");
    expect(checkOhMyPiExtension(doctorOpts(home))[0]).toMatchObject({ status: "warn" });
  });
});
