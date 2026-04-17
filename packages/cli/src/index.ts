import { createCache } from "cachebro-sdk";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { startMcpServer } from "./mcp.js";

const CLI_STATUS_SESSION = "cli-status";

async function runStatus(): Promise<void> {
  const cacheDir = resolve(process.env.CACHEBRO_DIR ?? ".cachebro");
  const dbPath = join(cacheDir, "cache.db");

  if (!existsSync(dbPath)) {
    console.log("No cachebro database found. Run 'cachebro serve' to start caching.");
    process.exit(0);
  }

  const { cache } = createCache({ dbPath, sessionId: CLI_STATUS_SESSION });
  await cache.init();
  const stats = await cache.getStats();

  console.log(`cachebro status:`);
  console.log(`  Files tracked:          ${stats.filesTracked}`);
  console.log(`  Tokens saved (total):   ~${stats.tokensSaved.toLocaleString()}`);

  await cache.close();
}

async function runInit(): Promise<void> {
  const home = homedir();

  const mcpServersEntry = {
    command: "npx",
    args: ["cachebro", "serve"],
  };

  const opencodeMcpEntry = {
    type: "local" as const,
    command: ["npx", "cachebro", "serve"],
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
    if (section?.cachebro) {
      console.log(`  ${target.name}: already configured`);
      configured++;
      continue;
    }

    config[target.key] = { ...section, cachebro: target.entry };
    writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n");
    console.log(`  ${target.name}: configured (${target.path})`);
    configured++;
  }

  if (configured === 0) {
    console.log("No supported tools detected. You can manually add cachebro to your MCP config:");
    console.log(JSON.stringify({ mcpServers: { cachebro: mcpServersEntry } }, null, 2));
  } else {
    console.log(`\nDone! Restart your editor to pick up cachebro.`);
  }
}

function runHelp(): void {
  console.log(`cachebro - Agent file cache with diff tracking

Usage:
  cachebro init      Auto-configure cachebro for your editor
  cachebro serve     Start the MCP server (default)
  cachebro status    Show cache statistics
  cachebro help      Show this help message

Environment:
  CACHEBRO_DIR       Cache directory (default: .cachebro)`);
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
  console.error(`Unknown command: ${command}. Run 'cachebro help' for usage.`);
  process.exit(1);
}