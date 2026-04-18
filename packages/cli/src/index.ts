import { createCache } from "filestash-sdk";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { startMcpServer } from "./mcp.js";

const CLI_STATUS_SESSION = "cli-status";

async function runStatus(): Promise<void> {
  const cacheDir = resolve(process.env.FILESTASH_DIR ?? ".file-stash");
  const dbPath = join(cacheDir, "stash.db");

  if (!existsSync(dbPath)) {
    console.log("No filestash database found. Run 'filestash serve' to start caching.");
    process.exit(0);
  }

  const { cache } = createCache({ dbPath, sessionId: CLI_STATUS_SESSION });
  await cache.init();
  const stats = await cache.getStats();

  console.log(`filestash status:`);
  console.log(`  Files tracked:          ${stats.filesTracked}`);
  console.log(`  Tokens saved (total):   ~${stats.tokensSaved.toLocaleString()}`);

  await cache.close();
}

async function runInit(): Promise<void> {
  const home = homedir();

  const mcpServersEntry = {
    command: "npx",
    args: ["filestash", "serve"],
  };

  const opencodeMcpEntry = {
    type: "local" as const,
    command: ["npx", "filestash", "serve"],
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
    console.log(JSON.stringify({ mcpServers: { filestash: mcpServersEntry } }, null, 2));
  } else {
    console.log(`\nDone! Restart your editor to pick up filestash.`);
  }
}

function runHelp(): void {
  console.log(`filestash - Agent file cache with diff tracking

Usage:
  filestash init      Auto-configure filestash for your editor
  filestash serve     Start the MCP server (default)
  filestash status    Show cache statistics
  filestash help      Show this help message

Environment:
  FILESTASH_DIR       Cache directory (default: .file-stash)`);
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