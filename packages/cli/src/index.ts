import { createStash } from "filestash-sdk";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { startMcpServer, resolveStashDir } from "./mcp.js";
import { findStashDatabases } from "./scan.js";

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
const HOOK_STDIN_TIMEOUT_MS = 1000;

async function readHookCwd(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const read = (async () => {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    return raw;
  })();
  const timeout = new Promise<string>((res) => setTimeout(() => res(""), HOOK_STDIN_TIMEOUT_MS).unref());
  const raw = (await Promise.race([read, timeout])).trim();
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
    const { stash } = createStash({ dbPath, sessionId: CLI_STATUS_SESSION });
    try {
      await stash.resetReads();
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
  return JSON.stringify({ hooks: { SessionStart: [RESET_HOOK_ENTRY] } }, null, 2);
}

function installClaudeHook(home: string): void {
  const settingsPath = join(home, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  const existed = existsSync(settingsPath);
  if (existed) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error(`  Claude Code hook: ${settingsPath} is not valid JSON, left untouched`);
      return;
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const sessionStart = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as { hooks?: { command?: string }[] }[]) : [];
  if (sessionStart.some((e) => e?.hooks?.some((h) => h?.command === RESET_HOOK_COMMAND))) {
    console.log("  Claude Code hook: already configured");
    return;
  }

  if (existed) copyFileSync(settingsPath, `${settingsPath}.bak`);
  else mkdirSync(join(home, ".claude"), { recursive: true });
  settings.hooks = { ...hooks, SessionStart: [...sessionStart, RESET_HOOK_ENTRY] };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  Claude Code hook: configured (${settingsPath})`);
}

async function runStatus(): Promise<void> {
  const stashDir = resolve(process.env.FILESTASH_DIR ?? ".file-stash");
  const dbPath = join(stashDir, "stash.db");

  if (!existsSync(dbPath)) {
    console.log("No filestash database found. Run 'agent-file-stash serve' to start stashing.");
    process.exit(0);
  }

  const { stash } = createStash({ dbPath, sessionId: CLI_STATUS_SESSION });
  await stash.init();
  const stats = await stash.getStats();

  console.log(`filestash status:`);
  console.log(`  Files tracked:          ${stats.filesTracked}`);
  console.log(`  Tokens saved (total):   ~${stats.tokensSaved.toLocaleString()}`);

  await stash.close();
}

async function runStatusAll(root: string): Promise<void> {
  const databases = findStashDatabases(resolve(root));
  if (databases.length === 0) {
    console.log(`No filestash databases found under ${resolve(root)}.`);
    return;
  }

  const rows: { project: string; files: number; tokens: number }[] = [];
  for (const dbPath of databases) {
    const { stash } = createStash({ dbPath, sessionId: CLI_STATUS_SESSION });
    try {
      await stash.init();
      const stats = await stash.getStats();
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
  console.log(`\nSavings count re-reads within a session (unchanged files and diffs); a new session always receives full content.`);
}

async function runInit(withHooks: boolean): Promise<void> {
  const home = homedir();

  const mcpServersEntry = {
    command: "npx",
    args: ["agent-file-stash", "serve"],
  };

  const opencodeMcpEntry = {
    type: "local" as const,
    command: ["npx", "agent-file-stash", "serve"],
  };

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");

  const targets = [
    {
      name: "Claude Code",
      path: join(home, ".claude.json"),
      key: "mcpServers",
      entry: mcpServersEntry,
    },
    {
      name: "Cursor",
      path: join(home, ".cursor", "mcp.json"),
      key: "mcpServers",
      entry: mcpServersEntry,
    },
    {
      name: "OpenCode",
      path: join(xdgConfig, "opencode", "opencode.json"),
      key: "mcp",
      entry: opencodeMcpEntry,
    },
  ];

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
    console.log(JSON.stringify({ mcpServers: { "agent-file-stash": mcpServersEntry } }, null, 2));
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
  } else {
    console.log(`Add this to ~/.claude/settings.json (or re-run 'init --hooks' to merge it):\n`);
    console.log(hooksSnippet());
  }
}

function runHelp(): void {
  console.log(`agent-file-stash - Agent file stash with diff tracking

Usage:
  agent-file-stash init      Auto-configure for your editor
  agent-file-stash init --hooks
                             Also add the Claude Code context-reset hook to ~/.claude/settings.json
  agent-file-stash reset     Forget what was read so the next read returns full content
                             (--from-hook: quiet mode for Claude Code hooks)
  agent-file-stash serve     Start the MCP server (default)
  agent-file-stash status    Show stash statistics
  agent-file-stash status --all [dir]
                             Sum statistics of every stash under dir (default: home)
  agent-file-stash help      Show this help message

Environment:
  FILESTASH_DIR       Stash directory (default: .file-stash)
  FILESTASH_EXCLUDE   Extra comma-separated file name globs that are never stored`);
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
} else if (command === "help" || command === "--help") {
  runHelp();
} else {
  console.error(`Unknown command: ${command}. Run 'agent-file-stash help' for usage.`);
  process.exit(1);
}