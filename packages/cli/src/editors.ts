import { join } from "node:path";

export interface EditorTarget {
  name: string;
  path: string;
  key: string;
  entry: Record<string, unknown>;
}

export function editorTargets(home: string): EditorTarget[] {
  const mcpServersEntry = {
    command: "npx",
    args: ["agent-file-stash", "serve"],
  };

  const opencodeMcpEntry = {
    type: "local" as const,
    command: ["npx", "agent-file-stash", "serve"],
  };

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");

  return [
    { name: "Claude Code", path: join(home, ".claude.json"), key: "mcpServers", entry: mcpServersEntry },
    { name: "Cursor", path: join(home, ".cursor", "mcp.json"), key: "mcpServers", entry: mcpServersEntry },
    { name: "OpenCode", path: join(xdgConfig, "opencode", "opencode.json"), key: "mcp", entry: opencodeMcpEntry },
  ];
}
