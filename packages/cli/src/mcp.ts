import { z } from "zod";
import { createStash, lifetimeView, type FileReadResult, type LifetimeCounters, type StashStats, type StashStore } from "filestash-sdk";
import { resolve, join, relative, isAbsolute } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";

export function resolveStashDir(baseDir: string = process.cwd()): string {
  const raw = process.env.FILESTASH_DIR ?? ".file-stash";
  if (raw.includes("\0")) throw new Error("FILESTASH_DIR contains invalid characters");
  return resolve(baseDir, raw);
}

function parseExcludeEnv(): string[] {
  return (process.env.FILESTASH_EXCLUDE ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function parseLimitEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  if (/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
  process.stderr.write(`[filestash] ignoring invalid ${name}=${JSON.stringify(raw)}; using the default\n`);
  return undefined;
}

function limitOptions(): { maxLines?: number; maxChars?: number } {
  const maxLines = parseLimitEnv("FILESTASH_MAX_LINES");
  const maxChars = parseLimitEnv("FILESTASH_MAX_CHARS");
  return { ...(maxLines !== undefined && { maxLines }), ...(maxChars !== undefined && { maxChars }) };
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

const readFileShape = {
  path: z.string().describe("File path"),
  offset: z
    .number()
    .optional()
    .describe("Start line (1-based)"),
  limit: z
    .number()
    .optional()
    .describe("Max lines"),
  force: z
    .boolean()
    .optional()
    .describe("Bypass stash"),
  agent: z.string().optional(),
};

const readFilesShape = {
  paths: z.preprocess(
    (val) => (typeof val === "string" ? JSON.parse(val) : val),
    z.array(z.string())
  ).describe("File paths"),
  agent: z.string().optional(),
};

export const TOOL_DEFS = {
  read_file: {
    description: `Read a file (use instead of Read). Repeat reads of an unchanged file return a short label, changed files return only a diff. offset/limit supported and stashed. Long files are truncated, continue with offset. force=true returns full content (use when the original is no longer in context).`,
    inputSchema: readFileShape,
  },
  read_files: {
    description: `Batched read_file for several files, same stash/diff behavior per file.`,
    inputSchema: readFilesShape,
  },
  stash_status: {
    description: `Show files tracked and this session's token accounting, net of tool-definition overhead.`,
  },
  stash_clear: {
    description: `Clear all stashed data.`,
  },
};

function jsonType(field: z.ZodTypeAny): string {
  switch (field._def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return jsonType(field._def.innerType);
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return jsonType(field._def.schema);
    case z.ZodFirstPartyTypeKind.ZodArray:
      return "array";
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return "number";
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return "boolean";
    default:
      return "string";
  }
}

function jsonSchema(shape: Record<string, z.ZodTypeAny> = {}): object {
  const properties: Record<string, object> = {};
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = { type: jsonType(field), description: field.description };
  }
  const required = Object.entries(shape).filter(([, f]) => !f.isOptional()).map(([k]) => k);
  return { type: "object", properties, ...(required.length > 0 && { required }) };
}

export function toolDefinitionTokens(): number {
  const defs = Object.entries(TOOL_DEFS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: jsonSchema("inputSchema" in def ? def.inputSchema : undefined),
  }));
  return Math.ceil(JSON.stringify(defs).length / 4);
}

function degradedLine(reason = "unknown"): string {
  return `Mode: DEGRADED (${reason}) - files are read normally, nothing is stashed`;
}

export function formatLifetime(c: LifetimeCounters, since: number | undefined, saved: string): string[] {
  const v = lifetimeView(c);
  if (v.empty) return [`  Lifetime counters start with this version; ${saved} above includes older history.`];
  const fmt = (n: number) => `~${n.toLocaleString()}`;
  const date = since ? ` (since ${new Date(since).toISOString().slice(0, 10)})` : "";
  const perSession = v.netPerSession === null ? "" : `, ${fmt(v.netPerSession)} per session`;
  return [
    `  Lifetime${date}:`,
    `    Sessions: ${v.sessions}, reads: ${v.reads}`,
    `    Would have sent (plain reads): ${fmt(v.baselineTokens)} tokens`,
    `    Actually sent: ${fmt(v.sentTokens)} tokens`,
    `    Gross saved: ${fmt(v.grossSaved)} tokens`,
    `    Tool definitions overhead: ${fmt(v.overheadTokens)} tokens (est., ${v.sessions} sessions)`,
    `    Net saved: ${fmt(v.netSaved)} tokens (est.)${perSession}`,
  ];
}

export function formatStatus(stats: StashStats, overheadTokens: number): string {
  if (stats.degraded) return degradedLine(stats.degradedReason);
  const fmt = (n: number) => `~${n.toLocaleString()}`;
  const net = stats.sessionTokensSaved - overheadTokens;
  return [
    "filestash status:",
    ...(stats.recoveredFrom ? [`  Recovered: corrupt database moved to ${stats.recoveredFrom}`] : []),
    `  Files tracked: ${stats.filesTracked}`,
    `  This session: ${stats.sessionReads} reads`,
    `    Would have sent (plain reads): ${fmt(stats.sessionBaselineTokens)} tokens`,
    `    Actually sent: ${fmt(stats.sessionSentTokens)} tokens`,
    `    Gross saved: ${fmt(stats.sessionTokensSaved)} tokens`,
    `    Tool definitions overhead: ${fmt(overheadTokens)} tokens (est.)`,
    `    Net saved: ${fmt(net)} tokens (est.)`,
    `  Gross saved (all sessions): ${fmt(stats.tokensSaved)} tokens`,
    ...formatLifetime(stats, stats.countersSince, `"Gross saved (all sessions)"`),
  ].join("\n");
}

function statsSuffix(grossSaved: number): string {
  return `\n\n[filestash: net ~${(grossSaved - toolDefinitionTokens()).toLocaleString()} tokens this session (est.)]`;
}

async function readSingleFile(
  path: string,
  cwd: string,
  stash: StashStore,
  scope?: string,
): Promise<{ text: string; ok: boolean }> {
  const absPath = resolve(path);
  if (!isPathAllowed(absPath, cwd)) {
    return {
      text: `=== ${path} ===\nError: Path must be within the working directory (${cwd})`,
      ok: false,
    };
  }
  try {
    const result = await stash.readFile(path, { ...(scope !== undefined && { scope }) });
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

  const dbPath = resolve(resolveStashDir(), "stash.db");
  const cwd = process.cwd();
  const watchPaths = [cwd];

  const sessionId = randomUUID();
  const { stash, watcher } = createStash({
    dbPath,
    sessionId,
    watchPaths,
    exclude: parseExcludeEnv(),
    ...limitOptions(),
  });

  await stash.init();
  await stash.recordSessionStart(toolDefinitionTokens());

  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = new McpServer({
    name: "filestash",
    version: packageJson.version ?? "0.0.0",
  });

  server.registerTool(
    "read_file",
    TOOL_DEFS.read_file,
    async ({ path, force, offset, limit, agent }) => {
      const absPath = resolve(path);
      if (!isPathAllowed(absPath, cwd)) {
        return {
          content: [{ type: "text" as const, text: `Error: Path must be within the working directory (${cwd})` }],
          isError: true,
        };
      }
      try {
        const result = force
          ? await stash.readFileFull(path, agent)
          : await stash.readFile(path, {
              ...(offset !== undefined && { offset }),
              ...(limit !== undefined && { limit }),
              ...(agent !== undefined && { scope: agent }),
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
    TOOL_DEFS.read_files,
    async ({ paths, agent }) => {
      const results = await Promise.all(paths.map(p => readSingleFile(p, cwd, stash, agent)));
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
    TOOL_DEFS.stash_status,
    async () => {
      const stats = await stash.getStats();
      const overhead = toolDefinitionTokens();
      const text = formatStatus(stats, overhead);
      return {
        content: [{ type: "text" as const, text }],
        _meta: {
          [`${META_NAMESPACE}/stats`]: {
            ...stats,
            toolDefinitionTokens: overhead,
            netTokensSaved: stats.sessionTokensSaved - overhead,
            lifetime: lifetimeView(stats),
          },
        },
      };
    },
  );

  server.registerTool(
    "stash_clear",
    TOOL_DEFS.stash_clear,
    async () => {
      await stash.clear();
      if (stash.isDegraded) {
        return { content: [{ type: "text" as const, text: "Stash is in degraded mode, nothing to clear." }] };
      }
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