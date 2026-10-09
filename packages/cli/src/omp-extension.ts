import { join } from "node:path";

export const OMP_AGENT_DIR = (home: string): string => join(home, ".omp", "agent");

export const ompExtensionPath = (home: string): string => join(OMP_AGENT_DIR(home), "extensions", "agent-file-stash.ts");

export const OMP_EXTENSION_SOURCE = `import { spawnSync } from "node:child_process";

const READ_TOOL = /^mcp__(?:agent_file_stash|filestash)_read_files?$/;
const AGENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export default function (pi) {
  pi.on("tool_call", (event, ctx) => {
    try {
      const agent = ctx.agent;
      if (agent?.kind !== "sub" || !READ_TOOL.test(event.toolName) || !AGENT_ID.test(agent.id)) return;
      if (typeof event.input !== "object" || event.input === null || Array.isArray(event.input)) return;
      return { input: { ...event.input, agent: agent.id } };
    } catch {
      return;
    }
  });

  const reset = (_event, ctx) => {
    try {
      spawnSync("npx", ["agent-file-stash", "reset", "--from-hook"], {
        input: JSON.stringify({ cwd: ctx.cwd }),
        timeout: 15000,
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      return;
    }
  };
  pi.on("session_compact", reset);
  pi.on("session_switch", reset);
}
`;
