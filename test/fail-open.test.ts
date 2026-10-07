import { describe, test, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import { createStash } from "filestash-sdk";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAll, createSandbox, isAlive, runCli, startServer } from "./helpers/mcp.js";

const GARBAGE = "this is definitely not a sqlite database, just bytes";
const BODY = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n";
const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "filestash-failopen-")));
  roots.push(root);
  return root;
}

function blockedDbPath(root: string): string {
  writeFileSync(join(root, "blocker"), "not a directory");
  return join(root, "blocker", "sub", "stash.db");
}

function corruptSiblings(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("stash.db.corrupt-"));
}

let stderr: { mockRestore(): void; mock: { calls: unknown[][] } };

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
});

afterAll(async () => {
  await cleanupAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stderrLines(): string[] {
  return stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[filestash]"));
}

describe("corrupt database recovery", () => {
  test("a corrupt database is moved aside and the stash works afterwards", async () => {
    const root = tempRoot();
    const dbPath = join(root, "stash.db");
    const file = join(root, "app.ts");
    writeFileSync(file, BODY);
    writeFileSync(dbPath, GARBAGE);

    const { stash, watcher } = createStash({ dbPath, sessionId: "s1" });
    try {
      const first = await stash.readFile(file);
      expect(first.stashed).toBe(false);
      expect(first.content).toBe(BODY);
      const second = await stash.readFile(file);
      expect(second.stashed).toBe(true);
      expect(second.content).toContain("unchanged");

      const moved = corruptSiblings(root);
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatch(/^stash\.db\.corrupt-\d+$/);
      expect(readFileSync(join(root, moved[0]!), "utf-8")).toBe(GARBAGE);

      const stats = await stash.getStats();
      expect(stats.degraded).toBe(false);
      expect(stats.recoveredFrom).toBe(join(root, moved[0]!));
      expect(stderrLines()).toHaveLength(1);
      expect(stderrLines()[0]).toContain("is corrupt");
      expect(stderrLines()[0]).toContain(moved[0]!);
    } finally {
      watcher.close();
      await stash.close();
    }
  });

  test("only one recovery is attempted per process", async () => {
    const root = tempRoot();
    const dbPath = join(root, "stash.db");
    const file = join(root, "app.ts");
    writeFileSync(file, BODY);
    writeFileSync(dbPath, GARBAGE);

    const { stash } = createStash({ dbPath, sessionId: "s1" });
    await stash.readFile(file);
    await stash.close();
    expect(corruptSiblings(root)).toHaveLength(1);

    writeFileSync(dbPath, GARBAGE);
    const result = await stash.readFile(file);
    expect(result.content).toBe(BODY);
    expect(corruptSiblings(root)).toHaveLength(1);
    expect(readFileSync(dbPath, "utf-8")).toBe(GARBAGE);
    expect((await stash.getStats()).degraded).toBe(true);
    await stash.close();
  });

  test("recoverCorrupt: false leaves the file alone and degrades", async () => {
    const root = tempRoot();
    const dbPath = join(root, "stash.db");
    writeFileSync(dbPath, GARBAGE);

    const { stash } = createStash({ dbPath, sessionId: "s1", recoverCorrupt: false });
    await stash.init();
    expect(stash.isDegraded).toBe(true);
    expect(stash.degradedReason).toContain("not a database");
    expect(readFileSync(dbPath, "utf-8")).toBe(GARBAGE);
    expect(corruptSiblings(root)).toHaveLength(0);
    await stash.close();
  });
});

describe("degraded mode", () => {
  test("an unusable location gives plain reads, offset/limit and secret exclusion intact", async () => {
    const root = tempRoot();
    const file = join(root, "app.ts");
    const env = join(root, ".env");
    writeFileSync(file, BODY);
    writeFileSync(env, "TOKEN=abc\nOTHER=1\n");

    const { stash, watcher } = createStash({ dbPath: blockedDbPath(root), sessionId: "s1" });
    try {
      for (let i = 0; i < 2; i++) {
        const full = await stash.readFile(file);
        expect(full).toMatchObject({ stashed: false, content: BODY, totalLines: 41 });
        expect(full.hash).toHaveLength(16);
      }
      const slice = await stash.readFile(file, { offset: 3, limit: 2 });
      expect(slice.stashed).toBe(false);
      expect(slice.content).toBe("export const value2 = 2;\nexport const value3 = 3;");
      expect(slice.totalLines).toBe(41);

      expect((await stash.readFile(env)).content).toBe("TOKEN=abc\nOTHER=1\n");
      expect((await stash.readFileFull(file)).content).toBe(BODY);
      await stash.onFileDeleted(file);
      await stash.clear();
      await stash.resetReads();

      const stats = await stash.getStats();
      expect(stats).toMatchObject({
        degraded: true,
        filesTracked: 0,
        tokensSaved: 0,
        sessionTokensSaved: 0,
        sessionReads: 0,
        sessionBaselineTokens: 0,
        sessionSentTokens: 0,
      });
      expect(stats.degradedReason).toMatch(/ENOTDIR/);
      expect(stderrLines()).toHaveLength(1);
      expect(stderrLines()[0]).toContain("nothing is stashed");
      expect(stderrLines()[0]).not.toContain("TOKEN");
    } finally {
      watcher.close();
      await stash.close();
    }
  });

  test("a failure in the middle of a session falls back to plain content and stays degraded", async () => {
    const root = tempRoot();
    const dbPath = join(root, "stash.db");
    const file = join(root, "app.ts");
    writeFileSync(file, BODY);

    const { stash } = createStash({ dbPath, sessionId: "s1" });
    expect((await stash.readFile(file)).stashed).toBe(false);
    expect((await stash.readFile(file)).stashed).toBe(true);

    const other = new DatabaseSync(dbPath);
    other.exec("DROP TABLE session_reads");
    other.close();

    const result = await stash.readFile(file);
    expect(result).toMatchObject({ stashed: false, content: BODY });
    const stats = await stash.getStats();
    expect(stats.degraded).toBe(true);
    expect(stats.degradedReason).toContain("session_reads");
    expect((await stash.readFile(file)).stashed).toBe(false);
    expect(stderrLines()).toHaveLength(1);
    await stash.close();
  });

  test("a connection closed underneath still returns content from readFileFull and getStats", async () => {
    const root = tempRoot();
    const file = join(root, "app.ts");
    writeFileSync(file, BODY);

    const { stash } = createStash({ dbPath: join(root, "stash.db"), sessionId: "s1" });
    await stash.readFile(file);
    (stash as unknown as { db: DatabaseSync }).db.close();

    expect((await stash.readFileFull(file)).content).toBe(BODY);
    expect(stash.isDegraded).toBe(true);
    expect((await stash.getStats()).degraded).toBe(true);
    await stash.close();
  });

  test("errors on the target file are still thrown, degraded or not", async () => {
    const root = tempRoot();
    const healthy = createStash({ dbPath: join(root, "stash.db"), sessionId: "s1" }).stash;
    const broken = createStash({ dbPath: blockedDbPath(root), sessionId: "s2" }).stash;
    mkdirSync(join(root, "adir"));

    for (const stash of [healthy, broken]) {
      await expect(stash.readFile(join(root, "ghost.ts"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stash.readFileFull(join(root, "ghost.ts"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stash.readFile(join(root, "adir"))).rejects.toMatchObject({ code: "EISDIR" });
    }
    expect(healthy.isDegraded).toBe(false);
    await healthy.close();
    await broken.close();
  });

  test.skipIf(!canChmod)("EACCES on the target file is still thrown", async () => {
    const root = tempRoot();
    const file = join(root, "secret.ts");
    writeFileSync(file, BODY);
    chmodSync(file, 0o000);
    const broken = createStash({ dbPath: blockedDbPath(root), sessionId: "s1" }).stash;
    try {
      await expect(broken.readFile(file)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(file, 0o600);
      await broken.close();
    }
  });
});

describe("MCP server fails open", () => {
  test("a corrupt database at startup is recovered and the tools answer", async () => {
    const sb = createSandbox();
    mkdirSync(sb.stashDir);
    writeFileSync(sb.dbPath, GARBAGE);
    const file = join(sb.project, "app.ts");
    writeFileSync(file, BODY);

    const server = await startServer(sb);
    expect(await server.read(file)).toBe(BODY);
    expect(await server.read(file)).toContain("[filestash: unchanged");

    const status = await server.call("stash_status");
    expect(status.text).toContain("Recovered: corrupt database moved to");
    expect(status.text).toMatch(/stash\.db\.corrupt-\d+/);
    expect((status.meta as Record<string, { degraded: boolean }>)[statsKey(status.meta)]!.degraded).toBe(false);
    expect(corruptSiblings(sb.stashDir)).toHaveLength(1);
    expect(isAlive(server.pid)).toBe(true);
  });

  test("a stash directory that cannot exist degrades without killing the server", async () => {
    const sb = createSandbox();
    writeFileSync(join(sb.root, "blocker"), "not a directory");
    const file = join(sb.project, "app.ts");
    writeFileSync(file, BODY);
    writeFileSync(join(sb.project, ".env"), "TOKEN=abc\n");

    const server = await startServer(sb, { env: { FILESTASH_DIR: join(sb.root, "blocker", "stash") } });
    for (let i = 0; i < 3; i++) {
      expect(await server.read(file)).toBe(BODY);
    }
    expect(await server.read(file, { force: true })).toBe(BODY);
    expect(await server.read(file, { offset: 2, limit: 1 })).toBe("export const value1 = 1;");
    expect(await server.read(join(sb.project, ".env"))).toBe("TOKEN=abc\n");

    const batch = await server.call("read_files", { paths: [file, join(sb.project, "ghost.ts")] });
    expect(batch.text).toContain(BODY);
    expect(batch.text).toContain("ENOENT");
    expect(batch.text).not.toContain("net ~");

    const status = await server.call("stash_status");
    const [firstLine] = status.text.split("\n");
    expect(firstLine).toMatch(/^Mode: DEGRADED \(.*ENOTDIR.*\) - files are read normally, nothing is stashed$/);
    const stats = (status.meta as Record<string, { degraded: boolean; degradedReason: string }>)[statsKey(status.meta)]!;
    expect(stats.degraded).toBe(true);
    expect(stats.degradedReason).toMatch(/ENOTDIR/);

    const cleared = await server.call("stash_clear");
    expect(cleared.isError).toBe(false);
    expect(cleared.text).toContain("degraded");
    expect(isAlive(server.pid)).toBe(true);
    expect(await server.read(file)).toBe(BODY);
  });
});

function statsKey(meta: Record<string, unknown>): string {
  const key = Object.keys(meta).find((k) => k.endsWith("/stats"));
  if (!key) throw new Error("no stats in _meta");
  return key;
}

describe("CLI on a corrupt database", () => {
  function corruptProject(): { dir: string; stashDir: string } {
    const dir = tempRoot();
    const stashDir = join(dir, ".stash");
    mkdirSync(stashDir);
    writeFileSync(join(stashDir, "stash.db"), GARBAGE);
    return { dir, stashDir };
  }

  function expectOneLineError(stderrText: string, prefix: string): void {
    const lines = stderrText.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(prefix);
    expect(stderrText).not.toMatch(/\n\s+at /);
  }

  test("status prints one line and exits 1, leaving the file in place", () => {
    const { dir, stashDir } = corruptProject();
    const res = runCli(["status"], { cwd: dir, env: { FILESTASH_DIR: stashDir } });
    expect(res.status).toBe(1);
    expectOneLineError(res.stderr, "filestash status failed");
    expect(readFileSync(join(stashDir, "stash.db"), "utf-8")).toBe(GARBAGE);
    expect(corruptSiblings(stashDir)).toHaveLength(0);
  });

  test("reset exits 1 with one line; --from-hook exits 0", () => {
    const { dir, stashDir } = corruptProject();
    const res = runCli(["reset"], { cwd: dir, env: { FILESTASH_DIR: stashDir } });
    expect(res.status).toBe(1);
    expectOneLineError(res.stderr, "filestash reset failed");

    const hook = runCli(["reset", "--from-hook"], { cwd: dir, env: { FILESTASH_DIR: stashDir }, input: JSON.stringify({ cwd: dir }) });
    expect(hook.status).toBe(0);
    expect(hook.stderr).not.toMatch(/\n\s+at /);
    expect(readFileSync(join(stashDir, "stash.db"), "utf-8")).toBe(GARBAGE);
  });

  test("status --all skips the unreadable database and reports the others", async () => {
    const root = tempRoot();
    const good = join(root, "good", ".file-stash");
    const bad = join(root, "bad", ".file-stash");
    mkdirSync(good, { recursive: true });
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "stash.db"), GARBAGE);
    const file = join(root, "good", "app.ts");
    writeFileSync(file, BODY);
    const { stash } = createStash({ dbPath: join(good, "stash.db"), sessionId: "seed" });
    await stash.readFile(file);
    await stash.close();

    const res = runCli(["status", "--all", root]);
    expect(res.status).toBe(0);
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
    expect(res.stderr).toContain(`skipped ${join(bad, "stash.db")}`);
    expect(res.stdout).toContain("1 databases");
    expect(res.stdout).toContain("good");
  });
});
