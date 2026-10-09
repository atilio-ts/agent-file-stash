import { createStash, type LifetimeCounters, type StashStore } from "filestash-sdk";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { startMcpServer, resolveStashDir, formatLifetime } from "./mcp.js";
import { findStashDatabases } from "./scan.js";
import { editorTargets } from "./editors.js";
import { runDoctor } from "./doctor.js";
import { readHookStdin, runSubagentScopeHook } from "./hook.js";
import { OMP_AGENT_DIR, OMP_EXTENSION_SOURCE, ompExtensionPath } from "./omp-extension.js";

// Suppress the node:sqlite experimental warning before sqlite is dynamically loaded
const _origEmitWarning = process.emitWarning;
(process as NodeJS.Process).emitWarning = function (msg, ...args) {
  if (typeof msg === "string" && msg.includes("SQLite")) return;
  return _origEmitWarning.apply(process, [msg, ...(args as [])] as Parameters<typeof process.emitWarning>);
};

const CLI_STATUS_SESSION = "cli-status";
const RESET_HOOK_COMMAND = "npx agent-file-stash reset --from-hook";
const RESET_HOOK_ENTRY = {
  matcher: "clear|compact",
  hooks: [{ type: "command", command: RESET_HOOK_COMMAND }],
};
const SCOPE_HOOK_COMMAND = "npx agent-file-stash hook subagent-scope";
const SCOPE_HOOK_ENTRY = {
  matcher: "mcp__(filestash|agent-file-stash)__read_files?",
  hooks: [{ type: "command", command: SCOPE_HOOK_COMMAND }],
};

function assertHealthy(stash: StashStore): void {
  if (stash.isDegraded) throw new Error(stash.degradedReason);
}

async function readHookCwd(): Promise<string | undefined> {
  const raw = await readHookStdin();
  if (!raw) return undefined;
  try {
    const cwd = (JSON.parse(raw) as { cwd?: unknown })?.cwd;
    return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

async function runReset(fromHook: boolean): Promise<void> {
  try {
    const hookCwd = fromHook ? await readHookCwd() : undefined;
    const dbPath = join(resolveStashDir(hookCwd), "stash.db");
    if (!existsSync(dbPath)) {
      if (!fromHook) console.log("No filestash database found. Nothing to reset.");
      return;
    }
    const { stash } = createStash({ dbPath, sessionId: CLI_STATUS_SESSION, recoverCorrupt: false, quiet: true });
    try {
      await stash.init();
      assertHealthy(stash);
      await stash.resetReads();
      assertHealthy(stash);
    } finally {
      await stash.close();
    }
    if (!fromHook) console.log("Read tracking reset. The next read of each file returns full content.");
  } catch (e: unknown) {
    console.error(`filestash reset failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(fromHook ? 0 : 1);
  }
}

function hooksSnippet(): string {
  return JSON.stringify({ hooks: { SessionStart: [RESET_HOOK_ENTRY], PreToolUse: [SCOPE_HOOK_ENTRY] } }, null, 2);
}

const HOOK_INSTALLS = [
  { event: "SessionStart", entry: RESET_HOOK_ENTRY },
  { event: "PreToolUse", entry: SCOPE_HOOK_ENTRY },
];

function hasHookCommand(entries: unknown, command: string): boolean {
  return Array.isArray(entries) && entries.some((e: { hooks?: { command?: string }[] }) => e?.hooks?.some((h) => h?.command === command));
}

function installClaudeHook(home: string): void {
  const settingsPath = join(home, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  const existed = existsSync(settingsPath);
  if (existed) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error(`  Claude Code hooks: ${settingsPath} is not valid JSON, left untouched`);
      return;
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const missing = HOOK_INSTALLS.filter(({ event, entry }) => !hasHookCommand(hooks[event], entry.hooks[0]!.command));
  if (missing.length === 0) {
    console.log("  Claude Code hooks: already configured");
    return;
  }

  if (existed) copyFileSync(settingsPath, `${settingsPath}.bak`);
  else mkdirSync(join(home, ".claude"), { recursive: true });
  const merged = { ...hooks };
  for (const { event, entry } of missing) {
    merged[event] = [...(Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []), entry];
  }
  settings.hooks = merged;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  Claude Code hooks: configured (${settingsPath})`);
}

function installOmpExtension(home: string): void {
  if (!existsSync(OMP_AGENT_DIR(home))) return;
  const path = ompExtensionPath(home);
  if (existsSync(path)) {
    const current = readFileSync(path, "utf-8");
    console.log(current === OMP_EXTENSION_SOURCE ? "  Oh My Pi extension: already configured" : `  Oh My Pi extension: ${path} differs from the bundled one, left untouched`);
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, OMP_EXTENSION_SOURCE);
  console.log(`  Oh My Pi extension: configured (${path})`);
}

async function runStatus(): Promise<void> {
  const stashDir = resolve(process.env.FILESTASH_DIR ?? ".file-stash");
  const dbPath = join(stashDir, "stash.db");

  if (!existsSync(dbPath)) {
    console.log("No filestash database found. Run 'agent-file-stash serve' to start stashing.");
    process.exit(0);
  }

  const { stash } = createStash({ dbPath, sessionId: CLI_STATUS_SESSION, recoverCorrupt: false, quiet: true });
  try {
    await stash.init();
    assertHealthy(stash);
    const stats = await stash.getStats();
    assertHealthy(stash);

    console.log(`filestash status:`);
    console.log(`  Files tracked:          ${stats.filesTracked}`);
    console.log(`  Tokens saved (total):   ~${stats.tokensSaved.toLocaleString()}`);
    console.log(formatLifetime(stats, stats.countersSince, `"Tokens saved (total)"`).join("\n"));
  } catch (e: unknown) {
    console.error(`filestash status failed for ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    await stash.close();
  }
}

async function runStatusAll(root: string): Promise<void> {
  const databases = findStashDatabases(resolve(root));
  if (databases.length === 0) {
    console.log(`No filestash databases found under ${resolve(root)}.`);
    return;
  }

  const rows: { project: string; files: number; tokens: number }[] = [];
  const lifetime: LifetimeCounters = { lifetimeSessions: 0, lifetimeReads: 0, lifetimeBaselineTokens: 0, lifetimeSentTokens: 0, lifetimeOverheadTokens: 0 };
  let since: number | undefined;
  for (const dbPath of databases) {
    const { stash } = createStash({ dbPath, sessionId: CLI_STATUS_SESSION, recoverCorrupt: false, quiet: true });
    try {
      await stash.init();
      const stats = await stash.getStats();
      assertHealthy(stash);
      lifetime.lifetimeSessions += stats.lifetimeSessions;
      lifetime.lifetimeReads += stats.lifetimeReads;
      lifetime.lifetimeBaselineTokens += stats.lifetimeBaselineTokens;
      lifetime.lifetimeSentTokens += stats.lifetimeSentTokens;
      lifetime.lifetimeOverheadTokens += stats.lifetimeOverheadTokens;
      if (stats.countersSince !== undefined) since = Math.min(since ?? Infinity, stats.countersSince);
      rows.push({ project: resolve(dbPath, "../..").replace(/\/\.vscode$/, ""), files: stats.filesTracked, tokens: stats.tokensSaved });
    } catch (e: unknown) {
      console.error(`  skipped ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await stash.close();
    }
  }

  rows.sort((a, b) => b.tokens - a.tokens);
  const totalTokens = rows.reduce((sum, r) => sum + r.tokens, 0);
  const totalFiles = rows.reduce((sum, r) => sum + r.files, 0);

  console.log(`filestash status (${rows.length} databases under ${resolve(root)}):`);
  for (const r of rows) {
    console.log(`  ~${r.tokens.toLocaleString().padStart(10)} tokens  ${String(r.files).padStart(5)} files  ${r.project}`);
  }
  console.log(`  ~${totalTokens.toLocaleString().padStart(10)} tokens  ${String(totalFiles).padStart(5)} files  TOTAL`);
  console.log(formatLifetime(lifetime, since, "the per-project totals").join("\n"));
  console.log(`\nSavings count re-reads within a session (unchanged files and diffs); a new session always receives full content.`);
}

async function runInit(withHooks: boolean): Promise<void> {
  const home = homedir();

  const targets = editorTargets(home);

  let configured = 0;

  for (const target of targets) {
    const dir = join(target.path, "..");
    if (!existsSync(dir)) continue;

    let config: Record<string, unknown> = {};
    if (existsSync(target.path)) {
      try {
        config = JSON.parse(readFileSync(target.path, "utf-8"));
      } catch {
        config = {};
      }
    }

    const section = config[target.key] as Record<string, unknown> | undefined;
    if (section?.filestash) {
      console.log(`  ${target.name}: already configured`);
      configured++;
      continue;
    }

    config[target.key] = { ...section, filestash: target.entry };
    writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n");
    console.log(`  ${target.name}: configured (${target.path})`);
    configured++;
  }

  if (configured === 0) {
    console.log("No supported tools detected. You can manually add agent-file-stash to your MCP config:");
    console.log(JSON.stringify({ mcpServers: { "agent-file-stash": targets[0]!.entry } }, null, 2));
  } else {
    console.log(`\nDone! Restart your editor to pick up agent-file-stash.`);
    console.log(`\nAvailable MCP tools:`);
    console.log(`  read_file        Read a file, returning only a diff if unchanged since last read`);
    console.log(`  read_files       Batch read multiple files at once`);
    console.log(`  stash_status     Show files tracked and tokens saved`);
    console.log(`  stash_clear      Reset the stash (re-sends full file contents on next read)`);
    console.log(`\nStash location: FILESTASH_DIR env var (default: .file-stash in cwd)`);
  }

  console.log(`\nContext resets: after /clear or /compact the model loses file contents the stash still considers read.`);
  if (withHooks) {
    installClaudeHook(home);
    installOmpExtension(home);
  } else {
    console.log(`Add this to ~/.claude/settings.json (or re-run 'init --hooks' to merge it):\n`);
    console.log(hooksSnippet());
    if (existsSync(OMP_AGENT_DIR(home))) console.log(`\nFor Oh My Pi, re-run 'init --hooks' to install the extension (context reset, subagent read scope) in ${ompExtensionPath(home)}.`);
  }
}

function runHelp(): void {
  console.log(`agent-file-stash - Agent file stash with diff tracking

Usage:
  agent-file-stash init      Auto-configure for your editor
  agent-file-stash init --hooks
                             Also add the Claude Code hooks (context reset, subagent read scope) to ~/.claude/settings.json
                             and the Oh My Pi extension to ~/.omp/agent/extensions/
  agent-file-stash reset     Forget what was read so the next read returns full content
                             (--from-hook: quiet mode for Claude Code hooks)
  agent-file-stash hook subagent-scope
                             PreToolUse hook that gives each subagent its own read tracking (no output otherwise)
  agent-file-stash serve     Start the MCP server (default)
  agent-file-stash status    Show stash statistics
  agent-file-stash status --all [dir]
                             Sum statistics of every stash under dir (default: home)
  agent-file-stash doctor    Check the install and report what to fix (read-only)
                             (--json: machine-readable output, --check-updates: ask npm for the latest version)
  agent-file-stash help      Show this help message

Environment:
  FILESTASH_DIR       Stash directory (default: .file-stash)
  FILESTASH_EXCLUDE   Extra comma-separated file name globs that are never stored
  FILESTASH_MAX_LINES Max lines returned per read (default: 2000)
  FILESTASH_MAX_CHARS Max characters returned per read (default: 100000)`);
}

const command = process.argv[2];

if (!command || command === "serve") {
  await startMcpServer();
} else if (command === "status" && process.argv[3] === "--all") {
  await runStatusAll(process.argv[4] ?? homedir());
} else if (command === "status") {
  await runStatus();
} else if (command === "init") {
  await runInit(process.argv.includes("--hooks"));
} else if (command === "reset") {
  await runReset(process.argv.includes("--from-hook"));
} else if (command === "hook" && process.argv[3] === "subagent-scope") {
  await runSubagentScopeHook();
} else if (command === "doctor") {
  process.exitCode = await runDoctor(process.argv.slice(3));
} else if (command === "help" || command === "--help") {
  runHelp();
} else {
  console.error(`Unknown command: ${command}. Run 'agent-file-stash help' for usage.`);
  process.exit(1);
}