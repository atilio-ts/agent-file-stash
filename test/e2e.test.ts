import { describe, test, expect, afterAll, vi } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, count, createSandbox, query, runCli, startServer, type Sandbox } from "./helpers/mcp.js";

const UNCHANGED = "[filestash: unchanged";
const BODY = Array.from({ length: 60 }, (_, i) => `export const value${i} = ${i};`);

function bodyWith(line30: string): string {
  const lines = [...BODY];
  lines[29] = line30;
  return lines.join("\n") + "\n";
}

function projectFile(sb: Sandbox, name: string, content = bodyWith(BODY[29]!)): string {
  const file = join(sb.project, name);
  writeFileSync(file, content);
  return file;
}

afterAll(cleanupAll);

describe("concurrent servers on one DB", () => {
  test("each session tracks its own reads", async () => {
    const sb = createSandbox();
    const file = projectFile(sb, "app.ts");
    const a = await startServer(sb);

    expect(await a.read(file)).toContain("value59");
    expect(await a.read(file)).toContain(UNCHANGED);

    const b = await startServer(sb);
    expect(await a.read(file)).toContain(UNCHANGED);

    writeFileSync(file, bodyWith("export const value29 = 'edited';"));
    const diff = await a.read(file);
    expect(diff).toMatch(/^\[filestash: \d+ lines changed out of 61\]/);
    expect(diff).toContain("edited");

    const first = await b.read(file);
    expect(first).toContain("value59");
    expect(first).not.toContain("[filestash:");
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM sessions")).toBe(2);
  });
});

describe("crash safety", () => {
  test("a killed server's rows are pruned on the next start; live sessions are untouched", async () => {
    const sb = createSandbox();
    const file = projectFile(sb, "app.ts");
    const a = await startServer(sb);
    const b = await startServer(sb);
    await a.read(file);
    await a.read(file);
    await b.read(file);
    const aId = a.sessionId();
    const bId = b.sessionId();
    const savedBefore = count(sb.dbPath, "SELECT value FROM stats WHERE key = 'tokens_saved'");
    expect(savedBefore).toBeGreaterThan(0);

    await a.kill();
    const c = await startServer(sb);

    expect(query(sb.dbPath, "SELECT pid FROM sessions ORDER BY pid").map((r) => r.pid).sort()).toEqual([b.pid, c.pid].sort());
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM session_reads WHERE session_id = ?", aId)).toBe(0);
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM session_stats WHERE session_id = ?", aId)).toBe(0);
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM session_reads WHERE session_id = ?", bId)).toBe(1);
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM file_versions")).toBe(1);
    expect(count(sb.dbPath, "SELECT value FROM stats WHERE key = 'tokens_saved'")).toBe(savedBefore);

    writeFileSync(file, bodyWith("export const value29 = 'after-crash';"));
    const diff = await b.read(file);
    expect(diff).toMatch(/^\[filestash: \d+ lines changed out of 61\]/);
    expect(diff).toContain("after-crash");
  });
});

describe("reset", () => {
  test("--from-hook makes every live server return full content again", async () => {
    const sb = createSandbox();
    const file = projectFile(sb, "app.ts");
    const env = { FILESTASH_DIR: ".stash" };
    const a = await startServer(sb, { env });
    const b = await startServer(sb, { env });
    for (const s of [a, b]) {
      await s.read(file);
      expect(await s.read(file)).toContain(UNCHANGED);
    }
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM session_reads")).toBe(2);

    const res = runCli(["reset", "--from-hook"], {
      cwd: sb.root,
      env,
      input: JSON.stringify({ cwd: sb.project }),
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM session_reads")).toBe(0);
    for (const s of [a, b]) {
      const full = await s.read(file);
      expect(full).toContain("value59");
      expect(full).not.toContain("[filestash:");
      expect(await s.read(file)).toContain(UNCHANGED);
    }
  });
});

describe("secrets", () => {
  test("denylisted and FILESTASH_EXCLUDE files are never stored; normal files are", async () => {
    const sb = createSandbox();
    const envContent = "API_KEY=super-secret-value\nDB_PASS=hunter2\n";
    const privateContent = "private notes body\n";
    const envFile = projectFile(sb, ".env", envContent);
    const privateFile = projectFile(sb, "notes.private", privateContent);
    const normal = projectFile(sb, "app.ts");
    const s = await startServer(sb, { env: { FILESTASH_EXCLUDE: "*.private" } });

    for (let i = 0; i < 2; i++) {
      expect(await s.read(envFile)).toBe(envContent);
      expect(await s.read(privateFile)).toBe(privateContent);
    }
    await s.read(normal);
    expect(await s.read(normal)).toContain(UNCHANGED);

    const paths = (table: string) => query<{ path: string }>(sb.dbPath, `SELECT path FROM ${table}`).map((r) => r.path);
    expect(paths("file_versions")).toEqual([normal]);
    expect(paths("session_reads")).toEqual([normal]);
    expect(JSON.stringify(query(sb.dbPath, "SELECT content FROM file_versions"))).not.toContain("super-secret-value");
  });
});

describe("stash_status", () => {
  test("reports consistent net-savings fields and extended _meta", async () => {
    const sb = createSandbox();
    const file = projectFile(sb, "app.ts");
    const s = await startServer(sb);
    for (let i = 0; i < 3; i++) await s.read(file);

    const status = await s.call("stash_status");
    const num = (label: string) => {
      const m = status.text.match(new RegExp(`${label}:? ~?([\\d,]+)`));
      if (!m) throw new Error(`missing "${label}" in:\n${status.text}`);
      return Number(m[1]!.replaceAll(",", ""));
    };
    const reads = num("This session");
    const baseline = num("Would have sent \\(plain reads\\)");
    const sent = num("Actually sent");
    const gross = num("Gross saved");
    const overhead = num("Tool definitions overhead");
    const net = num("Net saved");

    expect(reads).toBe(3);
    expect(baseline).toBeGreaterThan(sent);
    expect(gross).toBe(baseline - sent);
    expect(net).toBe(gross - overhead);
    expect(overhead).toBeGreaterThan(0);

    const key = Object.keys(status.meta).find((k) => k.endsWith("/stats"))!;
    expect(status.meta[key]).toMatchObject({
      filesTracked: 1,
      sessionReads: reads,
      sessionBaselineTokens: baseline,
      sessionSentTokens: sent,
      sessionTokensSaved: gross,
      toolDefinitionTokens: overhead,
      netTokensSaved: net,
    });
    const sid = s.sessionId();
    expect(count(sb.dbPath, "SELECT value FROM session_stats WHERE session_id = ? AND key = 'tokens_saved'", sid)).toBe(gross);
  });
});

describe("path restriction", () => {
  test("a file outside the working directory is refused and not stored", async () => {
    const sb = createSandbox();
    const outside = join(sb.root, "outside.txt");
    writeFileSync(outside, "outside body\n");
    const s = await startServer(sb);

    const res = await s.call("read_file", { path: outside });

    expect(res.isError).toBe(true);
    expect(res.text).toContain("Path must be within the working directory");
    expect(res.text).not.toContain("outside body");
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM file_versions")).toBe(0);
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM session_reads")).toBe(0);
  });
});

describe("graceful shutdown", () => {
  test("closing the client removes the session row; its reads wait for the next init", async () => {
    const sb = createSandbox();
    const file = projectFile(sb, "app.ts");
    const a = await startServer(sb);
    await a.read(file);
    const aId = a.sessionId();

    await a.close();
    await vi.waitFor(() => expect(count(sb.dbPath, "SELECT COUNT(*) FROM sessions WHERE session_id = ?", aId)).toBe(0), {
      timeout: 5000,
      interval: 25,
    });
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM session_reads WHERE session_id = ?", aId)).toBe(1);

    await startServer(sb);
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM session_reads WHERE session_id = ?", aId)).toBe(0);
    expect(count(sb.dbPath, "SELECT COUNT(*) FROM file_versions")).toBe(0);
  });
});

describe("CLI smoke", () => {
  test("help lists the commands", () => {
    const res = runCli(["help"]);
    expect(res.status).toBe(0);
    for (const cmd of ["serve", "status", "reset", "init"]) expect(res.stdout).toContain(`agent-file-stash ${cmd}`);
  });

  test("status reads the DB written by a server", async () => {
    const sb = createSandbox();
    const file = projectFile(sb, "app.ts");
    const s = await startServer(sb);
    await s.read(file);
    await s.read(file);

    const res = runCli(["status"], { cwd: sb.project, env: { FILESTASH_DIR: sb.stashDir } });

    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Files tracked:\s+1\b/);
    expect(res.stdout).toContain("Tokens saved (total)");
  });

  test("reset without a DB exits 0 and creates nothing", () => {
    const sb = createSandbox();
    const res = runCli(["reset"], { cwd: sb.project, env: { FILESTASH_DIR: ".stash" } });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(existsSync(sb.stashDir)).toBe(false);
    expect(readdirSync(sb.project)).toEqual([]);
  });
});
