const HOOK_STDIN_TIMEOUT_MS = 1000;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const STASH_READ_TOOL = /__read_files?$/;

export async function readHookStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const read = (async () => {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    return raw;
  })();
  const timeout = new Promise<string>((res) => setTimeout(() => res(""), HOOK_STDIN_TIMEOUT_MS).unref());
  return (await Promise.race([read, timeout])).trim();
}

export function subagentScopeOutput(raw: string): string | undefined {
  try {
    const input = JSON.parse(raw) as { agent_id?: unknown; tool_name?: unknown; tool_input?: unknown };
    const { agent_id: agentId, tool_name: toolName, tool_input: toolInput } = input;
    if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) return undefined;
    if (typeof toolName !== "string" || !STASH_READ_TOOL.test(toolName)) return undefined;
    if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) return undefined;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...toolInput, agent: agentId } },
    });
  } catch {
    return undefined;
  }
}

export async function runSubagentScopeHook(): Promise<void> {
  try {
    const out = subagentScopeOutput(await readHookStdin());
    if (out) process.stdout.write(out + "\n");
  } catch {
    // a hook must never break the tool call
  }
}
