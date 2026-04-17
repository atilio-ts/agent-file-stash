import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createCache, type FileReadResult, type CacheStore } from "cachebro-sdk";
import { resolve, join, relative, isAbsolute } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function getCacheDir(): string {
  const dir = resolve(process.env.CACHEBRO_DIR ?? ".cachebro");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function isPathAllowed(absPath: string, cwd: string): boolean {
  const rel = relative(cwd, absPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function formatReadResult(result: FileReadResult): string {
  if (result.cached && result.diff) {
    return `[cachebro: ${result.linesChanged} lines changed out of ${result.totalLines}]\n${result.diff}`;
  }
  return result.content;
}

function formatFileEntry(path: string, result: FileReadResult): string {
  if (result.cached && result.diff) {
    return `=== ${path} [${result.linesChanged} lines changed out of ${result.totalLines}] ===\n${result.diff}`;
  }
  return `=== ${path} ===\n${result.content}`;
}

function statsSuffix(tokensSaved: number): string {
  return `\n\n[cachebro: ~${tokensSaved.toLocaleString()} tokens saved this session. Report this to the user when you complete their task.]`;
}

async function readSingleFile(
  path: string,
  cwd: string,
  cache: CacheStore,
): Promise<{ text: string; ok: boolean }> {
  const absPath = resolve(path);
  if (!isPathAllowed(absPath, cwd)) {
    return {
      text: `=== ${path} ===\nError: Path must be within the working directory (${cwd})`,
      ok: false,
    };
  }
  try {
    const result = await cache.readFile(path);
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
    packageJson.mcpName || "io.github.glommer/cachebro"
  ).replaceAll("/", ".");

  const cacheDir = getCacheDir();
  const dbPath = resolve(cacheDir, "cache.db");
  const watchPaths = [process.cwd()];

  const sessionId = randomUUID();
  const { cache, watcher } = createCache({
    dbPath,
    sessionId,
    watchPaths,
  });

  await cache.init();

  const server = new McpServer({
    name: "cachebro",
    version: packageJson.version ?? "0.0.0",
  });

  server.registerTool(
    "read_file",
    {
      description: `Read a file with caching. Use this tool INSTEAD of the built-in Read tool for reading files.
On first read, returns full content and caches it — identical to Read.
On subsequent reads, if the file hasn't changed, returns a short confirmation instead of the full content — saving significant tokens.
If the file changed, returns only the diff (changed lines) instead of the full file.
Supports offset and limit for partial reads — and partial reads are also cached. If only lines outside the requested range changed, returns a short confirmation saving tokens.
Set force=true to bypass the cache and get the full file content (use when you no longer have the original in context).
ALWAYS prefer this over the Read tool. It is a drop-in replacement with caching benefits.`,
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
          .describe("Bypass cache and return full content"),
      },
    },
    async ({ path, force, offset, limit }) => {
      const absPath = resolve(path);
      const cwd = process.cwd();
      if (!isPathAllowed(absPath, cwd)) {
        return {
          content: [{ type: "text" as const, text: `Error: Path must be within the working directory (${cwd})` }],
          isError: true,
        };
      }
      try {
        const result = force
          ? await cache.readFileFull(path)
          : await cache.readFile(path, { offset, limit });
        let text = formatReadResult(result);
        if (result.cached) {
          const stats = await cache.getStats();
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
      description: `Read multiple files at once with caching. Use this tool INSTEAD of the built-in Read tool when you need to read several files.
Same behavior as read_file but batched. Returns cached/diff results for each file.
ALWAYS prefer this over multiple Read calls — it's faster and saves significant tokens.`,
      inputSchema: {
        paths: z.preprocess(
          (val) => (typeof val === "string" ? JSON.parse(val) : val),
          z.array(z.string())
        ).describe("Paths to the files to read"),
      },
    },
    async ({ paths }) => {
      const cwd = process.cwd();
      const results = await Promise.all(paths.map(p => readSingleFile(p, cwd, cache)));
      const successfulPaths = paths.filter((_, i) => results[i].ok);
      const combined = results.map(r => r.text).join("\n\n");

      let footer = "";
      try {
        const stats = await cache.getStats();
        if (stats.sessionTokensSaved > 0) footer = statsSuffix(stats.sessionTokensSaved);
      } catch (e: unknown) {
        process.stderr.write(`[cachebro] getStats error: ${e instanceof Error ? e.message : String(e)}\n`);
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
    "cache_status",
    {
      description: `Show cachebro statistics: files tracked, tokens saved, cache hit rates.
Use this to verify cachebro is working and see how many tokens it has saved.`,
    },
    async () => {
      const stats = await cache.getStats();
      const text = [
        `cachebro status:`,
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
    "cache_clear",
    {
      description: `Clear all cached data. Use this to reset the cache completely.`,
    },
    async () => {
      await cache.clear();
      return {
        content: [{ type: "text" as const, text: "Cache cleared." }],
        _meta: { [`${META_NAMESPACE}/cleared`]: true },
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    watcher.close();
    await cache.close();
    process.exit(0);
  });
}