import { createStash } from "filestash-sdk";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { startMcpServer } from "./mcp.js";

// Suppress the node:sqlite experimental warning before sqlite is dynamically loaded
const _origEmitWarning = process.emitWarning;
(process as NodeJS.Process).emitWarning = function (msg, ...args) {
  if (typeof msg === "string" && msg.includes("SQLite")) return;
  return _origEmitWarning.apply(process, [msg, ...(args as [])] as Parameters<typeof process.emitWarning>);
};

const CLI_STATUS_SESSION = "cli-status";

async function runStatus(): Promise<void> {
  const stashDir = resolve(process.env.FILESTASH_DIR ?? ".file-stash");
  const dbPath = join(stashDir, "stash.db");

  if (!existsSync(dbPath)) {
    console.log("No filestash database found. Run 'filestash serve' to start stashing.");
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

async function runInit(): Promise<void> {
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
    console.log("No supported tools detected. You can manually add filestash to your MCP config:");
    console.log(JSON.stringify({ mcpServers: { "agent-file-stash": mcpServersEntry } }, null, 2));
  } else {
    console.log(`\nDone! Restart your editor to pick up filestash.`);
    console.log(`\nAvailable MCP tools:`);
    console.log(`  read_file        Read a file, returning only a diff if unchanged since last read`);
    console.log(`  read_files       Batch read multiple files at once`);
    console.log(`  stash_status     Show files tracked and tokens saved`);
    console.log(`  stash_clear      Reset the stash (re-sends full file contents on next read)`);
    console.log(`\nStash location: FILESTASH_DIR env var (default: .file-stash in cwd)`);
  }
}

function runHelp(): void {
  console.log(`agent-file-stash - Agent file stash with diff tracking

Usage:
  agent-file-stash init      Auto-configure for your editor
  agent-file-stash serve     Start the MCP server (default)
  agent-file-stash status    Show stash statistics
  agent-file-stash help      Show this help message

Environment:
  FILESTASH_DIR       Stash directory (default: .file-stash)`);
}

const command = process.argv[2];

if (!command || command === "serve") {
  await startMcpServer();
} else if (command === "status") {
  await runStatus();
} else if (command === "init") {
  await runInit();
} else if (command === "help" || command === "--help") {
  runHelp();
} else {
  console.error(`Unknown command: ${command}. Run 'filestash help' for usage.`);
  process.exit(1);
}