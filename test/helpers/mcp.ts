import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..");
export const CLI = join(ROOT, "dist", "cli.mjs");

export interface Sandbox {
  root: string;
  project: string;
  stashDir: string;
  dbPath: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  meta: Record<string, unknown>;
}

export interface ServerHandle {
  pid: number;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  read(path: string, args?: Record<string, unknown>): Promise<string>;
  sessionId(): string;
  kill(): Promise<void>;
  close(): Promise<void>;
}

const sandboxes: string[] = [];
const servers = new Set<ServerHandle>();

export function createSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "filestash-e2e-")));
  sandboxes.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const stashDir = join(project, ".stash");
  return { root, project, stashDir, dbPath: join(stashDir, "stash.db") };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`process ${pid} did not exit`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function query<T = Record<string, unknown>>(dbPath: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

export function count(dbPath: string, sql: string, ...params: (string | number)[]): number {
  return Object.values(query<Record<string, number>>(dbPath, sql, ...params)[0]!)[0]!;
}

export function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? tmpdir(),
    env: { ...process.env, ...opts.env },
    input: opts.input ?? "",
    encoding: "utf-8",
  });
}

export async function startServer(
  sandbox: Sandbox,
  opts: { env?: Record<string, string>; cwd?: string } = {},
): Promise<ServerHandle> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "serve"],
    cwd: opts.cwd ?? sandbox.project,
    env: { ...(process.env as Record<string, string>), FILESTASH_DIR: sandbox.stashDir, ...opts.env },
  });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  const pid = transport.pid!;

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    return { text: res.content[0]!.text, isError: res.isError === true, meta: res._meta ?? {} };
  };

  const handle: ServerHandle = {
    pid,
    call,
    read: async (path, args = {}) => (await call("read_file", { path, ...args })).text,
    sessionId: () => {
      const rows = query<{ session_id: string }>(sandbox.dbPath, "SELECT session_id FROM sessions WHERE pid = ?", pid);
      if (rows.length !== 1) throw new Error(`expected one session for pid ${pid}, found ${rows.length}`);
      return rows[0]!.session_id;
    },
    kill: async () => {
      process.kill(pid, "SIGKILL");
      await waitUntilDead(pid);
      servers.delete(handle);
    },
    close: async () => {
      await client.close();
      await waitUntilDead(pid);
      servers.delete(handle);
    },
  };
  servers.add(handle);
  return handle;
}

export async function cleanupAll(): Promise<void> {
  const pids = [...servers].map((s) => s.pid);
  servers.clear();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
  await Promise.all(pids.map((pid) => waitUntilDead(pid).catch(() => undefined)));
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
}
