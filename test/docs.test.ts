import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DEFS } from "../packages/cli/src/mcp.js";

const ROOT = join(import.meta.dirname, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf-8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("README stays in sync with the code", () => {
  test("documents every command in the CLI help", () => {
    const help = execFileSync("node", [join(ROOT, "dist", "cli.mjs"), "help"], { encoding: "utf-8" });
    const commands = [...help.matchAll(/^ {2}agent-file-stash (\w+)/gm)].map((m) => m[1]!);
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of new Set(commands)) {
      expect(readme, `command "${cmd}"`).toContain(`\`${cmd}\``);
    }
  });

  test("documents every FILESTASH_* environment variable", () => {
    const vars = new Set<string>();
    for (const pkg of readdirSync(join(ROOT, "packages"))) {
      for (const file of sourceFiles(join(ROOT, "packages", pkg, "src"))) {
        for (const m of readFileSync(file, "utf-8").matchAll(/FILESTASH_[A-Z_]+/g)) vars.add(m[0]);
      }
    }
    expect(vars.size).toBeGreaterThan(0);
    for (const v of vars) expect(readme, v).toContain(v);
  });

  test("documents every MCP tool", () => {
    const tools = Object.keys(TOOL_DEFS);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(readme, `tool "${tool}"`).toContain(`\`${tool}\``);
  });
});
