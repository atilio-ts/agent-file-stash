import { SCHEMA_VERSION, SchemaTooNewError } from "filestash-sdk";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveStashDir } from "./mcp.js";
import { editorTargets } from "./editors.js";

export type Status = "ok" | "warn" | "error" | "info";

export interface CheckResult {
  id: string;
  status: Status;
  message: string;
  hint?: string;
}

export interface DoctorOptions {
  nodeVersion: string;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  now: number;
  checkUpdates: boolean;
  fetchLatest: () => string | undefined;
}

type Check = (o: DoctorOptions) => CheckResult[] | Promise<CheckResult[]>;

const PACKAGE_NAME = "agent-file-stash";
const RECOVERY_LOCK_STALE_MS = 15_000;
const DEFAULT_MIN_NODE = "24";
const NPM_TIMEOUT_MS = 5000;
const MAX_SCRIPT_BYTES = 64 * 1024;
const SESSION_START_TARGETS = ["clear", "compact"];

const result = (id: string, status: Status, message: string, hint?: string): CheckResult => ({
  id,
  status,
  message,
  ...(hint !== undefined && { hint }),
});

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

interface OwnPackage {
  name?: string;
  version?: string;
  engines?: { node?: string };
}

function ownPackageJson(): OwnPackage | undefined {
  for (const rel of ["../package.json", "../../../package.json"]) {
    try {
      const pkg = readJson(join(import.meta.dirname, rel)) as OwnPackage;
      if (pkg.name === PACKAGE_NAME) return pkg;
    } catch {
      continue;
    }
  }
  return undefined;
}

function wide(mode: number, mask: number): boolean {
  return (mode & mask) !== 0;
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

export function checkNode(o: DoctorOptions): CheckResult[] {
  const range = ownPackageJson()?.engines?.node;
  const required = Number(/\d+/.exec(range ?? "")?.[0] ?? DEFAULT_MIN_NODE);
  const major = Number(o.nodeVersion.split(".")[0]);
  if (major >= required) return [result("node", "ok", `Node ${o.nodeVersion} (requires >=${required})`)];
  return [
    result("node", "error", `Node ${o.nodeVersion} is older than the required >=${required}`, `install Node ${required} or newer`),
  ];
}

export function checkStashDir(o: DoctorOptions): CheckResult[] {
  const dir = resolveStashDir(o.cwd);
  if (!existsSync(dir)) return [result("stash-dir", "info", `stash directory ${dir} does not exist yet; it will be created on first read`)];
  const st = statSync(dir);
  if (!st.isDirectory()) {
    return [result("stash-dir", "error", `${dir} exists but is not a directory`, `remove it or point FILESTASH_DIR elsewhere`)];
  }
  if (o.platform !== "win32" && wide(st.mode, 0o077)) {
    return [result("stash-dir", "warn", `stash directory ${dir} has mode ${octal(st.mode)}, expected 700`, `run: chmod 700 ${dir}`)];
  }
  return [result("stash-dir", "info", `stash directory ${dir}`)];
}

function isCorruptMessage(err: unknown): boolean {
  const code = (err as { errcode?: number }).errcode;
  if (typeof code === "number" && [11, 26].includes(code & 0xff)) return true;
  return /not a database|malformed|corrupt/i.test(reason(err));
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface DbFacts {
  userVersion: number;
  integrity: string;
  filesTracked?: number;
  pids?: number[];
}

async function inspectDatabase(dbPath: string): Promise<DbFacts> {
  const { DatabaseSync } = await import("node:sqlite");
  const url = pathToFileURL(dbPath);
  url.search = existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`) ? "mode=ro" : "mode=ro&immutable=1";
  const db = new DatabaseSync(url.href, { readOnly: true });
  try {
    const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const first = (db.prepare("PRAGMA quick_check").all()[0] ?? {}) as Record<string, unknown>;
    const integrity = String(Object.values(first)[0] ?? "no result");
    const facts: DbFacts = { userVersion, integrity };
    if (integrity === "ok" && userVersion >= 1 && userVersion <= SCHEMA_VERSION) {
      facts.filesTracked = (db.prepare("SELECT COUNT(DISTINCT path) AS c FROM file_versions").get() as { c: number }).c;
      facts.pids = (db.prepare("SELECT pid FROM sessions").all() as { pid: number }[]).map((r) => r.pid);
    }
    return facts;
  } finally {
    db.close();
  }
}

function checkDatabaseFiles(dir: string, now: number): CheckResult[] {
  const out: CheckResult[] = [];
  const names = readdirSync(dir);
  const leftovers = names.filter((n) => /^stash\.db\.corrupt-\d+$/.test(n));
  if (leftovers.length > 0) {
    out.push(result("database-leftovers", "info", `${leftovers.length} moved-aside corrupt database file(s) in ${dir} (stash.db.corrupt-*); delete them when no longer needed`));
  }
  if (names.includes("stash.db.recover.lock")) {
    const lock = join(dir, "stash.db.recover.lock");
    const age = now - statSync(lock).mtimeMs;
    if (age > RECOVERY_LOCK_STALE_MS) {
      out.push(result("database-lock", "warn", `stale recovery lock ${lock} (${Math.round(age / 1000)}s old)`, `remove ${lock}; the next start also clears it`));
    } else {
      out.push(result("database-lock", "info", `a recovery is in progress (${lock})`));
    }
  }
  return out;
}

export async function checkDatabase(o: DoctorOptions): Promise<CheckResult[]> {
  const dir = resolveStashDir(o.cwd);
  const dbPath = join(dir, "stash.db");
  const out: CheckResult[] = [];
  if (existsSync(dir)) out.push(...checkDatabaseFiles(dir, o.now));
  if (!existsSync(dbPath)) return [result("database", "info", `no database at ${dbPath} yet; it will be created on first read`), ...out];

  const st = statSync(dbPath);
  let facts: DbFacts;
  try {
    facts = await inspectDatabase(dbPath);
  } catch (e) {
    if (isCorruptMessage(e)) {
      return [
        result("database", "error", `${dbPath} is corrupt (${reason(e)})`, `it will be moved aside to stash.db.corrupt-<ms> on next start; or delete it`),
        ...out,
      ];
    }
    return [result("database", "warn", `could not inspect ${dbPath} without writing (${reason(e)})`, `stop running servers and re-run doctor`), ...out];
  }

  if (facts.integrity !== "ok") {
    out.unshift(result("database", "error", `${dbPath} failed quick_check (${facts.integrity})`, `it will be moved aside to stash.db.corrupt-<ms> on next start; or delete it`));
    return out;
  }
  if (facts.userVersion > SCHEMA_VERSION) {
    out.unshift(result("database-schema", "error", new SchemaTooNewError(facts.userVersion, SCHEMA_VERSION).message, "upgrade agent-file-stash or point FILESTASH_DIR at another directory"));
  } else if (facts.userVersion < SCHEMA_VERSION) {
    out.unshift(result("database-schema", "info", `schema version ${facts.userVersion} will be upgraded to ${SCHEMA_VERSION} on next start`));
  } else {
    out.unshift(result("database-schema", "ok", `database schema version ${facts.userVersion}, quick_check passed`));
  }
  if (o.platform !== "win32" && wide(st.mode, 0o077)) {
    out.push(result("database-mode", "warn", `${dbPath} has mode ${octal(st.mode)}, expected 600`, `run: chmod 600 ${dbPath}`));
  }
  const parts = [formatBytes(st.size)];
  if (facts.filesTracked !== undefined) parts.push(`${facts.filesTracked} files tracked`);
  if (facts.pids) {
    const live = facts.pids.filter(pidAlive).length;
    parts.push(`${live} live and ${facts.pids.length - live} dead session(s)`);
  }
  out.push(result("database-stats", "info", `database ${parts.join(", ")}`));
  return out;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandResolves(command: string, platform: NodeJS.Platform): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return isExecutable(command);
  const exts = platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => exts.some((ext) => isExecutable(join(dir, command + ext))));
}

function splitCommand(entry: Record<string, unknown>): { command: string; args: string[] } | undefined {
  const raw = entry.command;
  if (Array.isArray(raw) && typeof raw[0] === "string") return { command: raw[0], args: raw.slice(1).map(String) };
  if (typeof raw !== "string") return undefined;
  return { command: raw, args: Array.isArray(entry.args) ? entry.args.map(String) : [] };
}

export function checkMcpRegistration(o: DoctorOptions): CheckResult[] {
  const out: CheckResult[] = [];
  let found = 0;
  for (const t of editorTargets(o.home)) {
    if (!existsSync(t.path)) continue;
    found++;
    const id = `mcp-${t.name.toLowerCase().replace(/\s+/g, "-")}`;
    let config: unknown;
    try {
      config = readJson(t.path);
    } catch {
      out.push(result(id, "warn", `${t.name}: ${t.path} is not valid JSON`, `fix the file, then run: agent-file-stash init`));
      continue;
    }
    const entry = asRecord(asRecord(asRecord(config)?.[t.key])?.filestash);
    if (!entry) {
      out.push(result(id, "warn", `${t.name}: no filestash entry in ${t.path}`, "run: agent-file-stash init"));
      continue;
    }
    const cmd = splitCommand(entry);
    if (!cmd) {
      out.push(result(id, "warn", `${t.name}: the filestash entry in ${t.path} has no command`, "run: agent-file-stash init"));
    } else if (!commandResolves(cmd.command, o.platform)) {
      out.push(result(id, "warn", `${t.name}: command "${cmd.command}" was not found or is not executable`, `install it or fix the command in ${t.path}`));
    } else if (!cmd.args.includes("serve")) {
      out.push(result(id, "warn", `${t.name}: the filestash entry does not run "serve"`, `set the arguments to: agent-file-stash serve`));
    } else {
      out.push(result(id, "ok", `${t.name}: filestash registered in ${t.path}`));
    }
  }
  if (found === 0) return [result("mcp", "info", "no editor configuration found (Claude Code, Cursor, OpenCode)")];
  return out;
}

function matcherCovers(matcher: unknown, event: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(event);
  } catch {
    return matcher.split("|").includes(event);
  }
}

function commandRunsReset(command: string, o: DoctorOptions): boolean {
  const mentions = (text: string) => text.includes(PACKAGE_NAME) && /\breset\b/.test(text);
  if (mentions(command)) return true;
  const target = command
    .trim()
    .replace(/^(?:ba|z)?sh\s+/, "")
    .split(/\s+/)[0]!
    .replace(/^["']|["']$/g, "")
    .replace(/^~(?=\/)/, o.home)
    .replace(/\$\{?(?:HOME)\}?/, o.home)
    .replace(/\$\{?CLAUDE_PROJECT_DIR\}?/, o.cwd);
  try {
    const path = resolve(o.cwd, target);
    if (!statSync(path).isFile() || statSync(path).size > MAX_SCRIPT_BYTES) return false;
    return mentions(readFileSync(path, "utf-8"));
  } catch {
    return false;
  }
}

export function checkResetHook(o: DoctorOptions): CheckResult[] {
  const out: CheckResult[] = [];
  const covered = new Set<string>();
  let hookFile: string | undefined;
  let hookFound = false;
  const files = [
    join(o.home, ".claude", "settings.json"),
    join(o.cwd, ".claude", "settings.json"),
    join(o.cwd, ".claude", "settings.local.json"),
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let settings: unknown;
    try {
      settings = readJson(file);
    } catch {
      out.push(result("hook-settings", "warn", `${file} is not valid JSON`, "fix the file so hooks in it can be checked"));
      continue;
    }
    const sessionStart = asRecord(asRecord(settings)?.hooks)?.SessionStart;
    for (const entry of Array.isArray(sessionStart) ? sessionStart : []) {
      const e = asRecord(entry);
      const hooks = Array.isArray(e?.hooks) ? e.hooks : [];
      const runs = hooks.some((h) => typeof asRecord(h)?.command === "string" && commandRunsReset(asRecord(h)!.command as string, o));
      if (!runs) continue;
      hookFound = true;
      hookFile ??= file;
      for (const ev of SESSION_START_TARGETS) if (matcherCovers(e?.matcher, ev)) covered.add(ev);
    }
  }
  if (!hookFound) {
    out.push(result("hook", "warn", "no SessionStart hook runs 'agent-file-stash reset'", "run: agent-file-stash init --hooks (without it a read after /clear or /compact can come back as unchanged)"));
    return out;
  }
  const missing = SESSION_START_TARGETS.filter((ev) => !covered.has(ev));
  if (missing.length > 0) {
    out.push(result("hook", "warn", `reset hook in ${hookFile} does not match ${missing.join(" or ")}`, `set the matcher to "clear|compact"`));
  } else {
    out.push(result("hook", "ok", `reset hook configured for clear and compact (${hookFile})`));
  }
  return out;
}

export function checkEnv(): CheckResult[] {
  const out: CheckResult[] = [];
  const exclude = process.env.FILESTASH_EXCLUDE;
  if (exclude !== undefined && exclude !== "") {
    const n = exclude.split(",").filter((p) => p.trim()).length;
    out.push(result("env-exclude", "ok", `FILESTASH_EXCLUDE: ${n} pattern(s)`));
  }
  for (const name of ["FILESTASH_MAX_LINES", "FILESTASH_MAX_CHARS"]) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") continue;
    const valid = /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw));
    out.push(
      valid
        ? result(`env-${name.toLowerCase()}`, "ok", `${name}=${raw}`)
        : result(`env-${name.toLowerCase()}`, "warn", `${name}=${JSON.stringify(raw)} is not a positive integer and is ignored`, `set ${name} to a positive integer or unset it`),
    );
  }
  return out;
}

export function npmLatestVersion(): string | undefined {
  const res = spawnSync("npm", ["view", PACKAGE_NAME, "version"], {
    encoding: "utf-8",
    timeout: NPM_TIMEOUT_MS,
    shell: process.platform === "win32",
  });
  const version = res.status === 0 ? res.stdout.trim() : "";
  return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
}

function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export function checkUpdates(o: DoctorOptions): CheckResult[] {
  if (!o.checkUpdates) return [];
  const installed = ownPackageJson()?.version;
  const latest = o.fetchLatest();
  if (!installed || !latest) return [result("updates", "info", "could not check for updates")];
  if (newer(latest, installed)) return [result("updates", "info", `update available: ${installed} -> ${latest} (npm install -g ${PACKAGE_NAME})`)];
  return [result("updates", "ok", `agent-file-stash ${installed} is up to date`)];
}

export const CHECKS: [string, Check][] = [
  ["node", checkNode],
  ["stash-dir", checkStashDir],
  ["database", checkDatabase],
  ["mcp", checkMcpRegistration],
  ["hook", checkResetHook],
  ["env", checkEnv],
  ["updates", checkUpdates],
];

export function defaultOptions(argv: string[] = []): DoctorOptions {
  return {
    nodeVersion: process.versions.node,
    cwd: process.cwd(),
    home: homedir(),
    platform: process.platform,
    now: Date.now(),
    checkUpdates: argv.includes("--check-updates"),
    fetchLatest: npmLatestVersion,
  };
}

export async function runChecks(o: DoctorOptions, checks: [string, Check][] = CHECKS): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const [id, check] of checks) {
    try {
      results.push(...(await check(o)));
    } catch (e) {
      results.push(result(id, "warn", `check failed: ${reason(e)}`));
    }
  }
  return results;
}

export function summarize(results: CheckResult[]): { ok: number; warnings: number; errors: number } {
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  return { ok: count("ok"), warnings: count("warn"), errors: count("error") };
}

export function formatHuman(results: CheckResult[]): string {
  const lines = results.flatMap((r) => [`[${r.status}] ${r.message}`, ...(r.hint ? [`    ${r.hint}`] : [])]);
  const s = summarize(results);
  return [...lines, "", `${s.ok} ok, ${s.warnings} warnings, ${s.errors} errors`].join("\n");
}

export async function runDoctor(argv: string[], overrides: Partial<DoctorOptions> = {}): Promise<number> {
  const results = await runChecks({ ...defaultOptions(argv), ...overrides });
  console.log(argv.includes("--json") ? JSON.stringify(results, null, 2) : formatHuman(results));
  return summarize(results).errors > 0 ? 1 : 0;
}
