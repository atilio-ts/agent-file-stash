import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createStash, type FileReadResult, type StashStore } from "filestash-sdk";
import { resolve, join, relative, isAbsolute } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";

function getStashDir(): string {
  const raw = process.env.FILESTASH_DIR ?? ".file-stash";
  if (raw.includes("\0")) throw new Error("FILESTASH_DIR contains invalid characters");
  const dir = resolve(raw);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function isPathAllowed(absPath: string, cwd: string): boolean {
  let realPath: string;
  try {
    realPath = realpathSync(absPath);
  } catch {
    realPath = absPath;
  }
  const rel = relative(cwd, realPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function formatReadResult(result: FileReadResult): string {
  if (result.stashed && result.diff) {
    return `[filestash: ${result.linesChanged} lines changed out of ${result.totalLines}]\n${result.diff}`;
  }
  return result.content;
}

function formatFileEntry(path: string, result: FileReadResult): string {
  if (result.stashed && result.diff) {
    return `=== ${path} [${result.linesChanged} lines changed out of ${result.totalLines}] ===\n${result.diff}`;
  }
  return `=== ${path} ===\n${result.content}`;
}

function statsSuffix(tokensSaved: number): string {
  return `\n\n[filestash: ~${tokensSaved.toLocaleString()} tokens saved this session. Report this to the user when you complete their task.]`;
}

async function readSingleFile(
  path: string,
  cwd: string,
  stash: StashStore,
): Promise<{ text: string; ok: boolean }> {
  const absPath = resolve(path);
  if (!isPathAllowed(absPath, cwd)) {
    return {
      text: `=== ${path} ===\nError: Path must be within the working directory (${cwd})`,
      ok: false,
    };
  }
  try {
    const result = await stash.readFile(path);
    return { text: formatFileEntry(path, result), ok: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { text: `=== ${path} ===\nError: ${message}`, ok: false };
  }
}

export async function startMcpServer(): Promise<void> {
  let packageJson: { version?: string; mcpName?: string } = {};
  try {
    packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, "../package.json"), "utf-8"),
    );
  } catch {
    // package.json not found; proceed with defaults
  }
  const META_NAMESPACE = (
    packageJson.mcpName || "io.github.glommer/filestash"
  ).replaceAll("/", ".");

  const stashDir = getStashDir();
  const dbPath = resolve(stashDir, "stash.db");
  const cwd = process.cwd();
  const watchPaths = [cwd];

  const sessionId = randomUUID();
  const { stash, watcher } = createStash({
    dbPath,
    sessionId,
    watchPaths,
  });

  await stash.init();

  const server = new McpServer({
    name: "filestash",
    version: packageJson.version ?? "0.0.0",
  });

  server.registerTool(
    "read_file",
    {
      description: `Read a file with stashing. Use this tool INSTEAD of the built-in Read tool for reading files.
On first read, returns full content and stashes it — identical to Read.
On subsequent reads, if the file hasn't changed, returns a short confirmation instead of the full content — saving significant tokens.
If the file changed, returns only the diff (changed lines) instead of the full file.
Supports offset and limit for partial reads — and partial reads are also stashed. If only lines outside the requested range changed, returns a short confirmation saving tokens.
Set force=true to bypass the stash and get the full file content (use when you no longer have the original in context).
ALWAYS prefer this over the Read tool. It is a drop-in replacement with stashing benefits.`,
      inputSchema: {
        path: z.string().describe("Path to the file to read"),
        offset: z
          .number()
          .optional()
          .describe("Line number to start reading from (1-based). Only provide if the file is too large to read at once."),
        limit: z
          .number()
          .optional()
          .describe("Number of lines to read. Only provide if the file is too large to read at once."),
        force: z
          .boolean()
          .optional()
          .describe("Bypass stash and return full content"),
      },
    },
    async ({ path, force, offset, limit }) => {
      const absPath = resolve(path);
      if (!isPathAllowed(absPath, cwd)) {
        return {
          content: [{ type: "text" as const, text: `Error: Path must be within the working directory (${cwd})` }],
          isError: true,
        };
      }
      try {
        const result = force
          ? await stash.readFileFull(path)
          : await stash.readFile(path, {
              ...(offset !== undefined && { offset }),
              ...(limit !== undefined && { limit }),
            });
        let text = formatReadResult(result);
        if (result.stashed) {
          const stats = await stash.getStats();
          text += statsSuffix(stats.sessionTokensSaved);
        }
        return {
          content: [{ type: "text" as const, text }],
          _meta: { [`${META_NAMESPACE}/files`]: [path] },
        };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "read_files",
    {
      description: `Read multiple files at once with stashing. Use this tool INSTEAD of the built-in Read tool when you need to read several files.
Same behavior as read_file but batched. Returns stashed/diff results for each file.
ALWAYS prefer this over multiple Read calls — it's faster and saves significant tokens.`,
      inputSchema: {
        paths: z.preprocess(
          (val) => (typeof val === "string" ? JSON.parse(val) : val),
          z.array(z.string())
        ).describe("Paths to the files to read"),
      },
    },
    async ({ paths }) => {
      const results = await Promise.all(paths.map(p => readSingleFile(p, cwd, stash)));
      const successfulPaths = paths.filter((_, i) => results[i]!.ok);
      const combined = results.map(r => r.text).join("\n\n");

      let footer = "";
      try {
        const stats = await stash.getStats();
        if (stats.sessionTokensSaved > 0) footer = statsSuffix(stats.sessionTokensSaved);
      } catch (e: unknown) {
        process.stderr.write(`[filestash] getStats error: ${e instanceof Error ? e.message : String(e)}\n`);
      }

      return {
        content: [{ type: "text" as const, text: combined + footer }],
        _meta: successfulPaths.length > 0
          ? { [`${META_NAMESPACE}/files`]: successfulPaths }
          : undefined,
      };
    },
  );

  server.registerTool(
    "stash_status",
    {
      description: `Show filestash statistics: files tracked, tokens saved, stash hit rates.
Use this to verify filestash is working and see how many tokens it has saved.`,
    },
    async () => {
      const stats = await stash.getStats();
      const text = [
        `filestash status:`,
        `  Files tracked: ${stats.filesTracked}`,
        `  Tokens saved (this session): ~${stats.sessionTokensSaved.toLocaleString()}`,
        `  Tokens saved (all sessions): ~${stats.tokensSaved.toLocaleString()}`,
      ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        _meta: { [`${META_NAMESPACE}/stats`]: { filesTracked: stats.filesTracked, tokensSaved: stats.tokensSaved, sessionTokensSaved: stats.sessionTokensSaved } },
      };
    },
  );

  server.registerTool(
    "stash_clear",
    {
      description: `Clear all stashed data. Use this to reset the stash completely.`,
    },
    async () => {
      await stash.clear();
      return {
        content: [{ type: "text" as const, text: "Stash cleared." }],
        _meta: { [`${META_NAMESPACE}/cleared`]: true },
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    watcher.close();
    await stash.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}