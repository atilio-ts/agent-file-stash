import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createStash, isExcludedPath } from "filestash-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli.mjs");
const TEST_DIR = realpathSync(mkdtempSync(join(tmpdir(), "filestash-secrets-")));
const SECRET = "API_KEY=super-secret-value\nDB_PASS=hunter2\n";

let dirCounter = 0;

function newDir(): string {
  const dir = join(TEST_DIR, `case${dirCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function open(dbPath: string, extra: { exclude?: string[] } = {}) {
  return createStash({ dbPath, sessionId: "s1", ...extra });
}

function count(dbPath: string, sql: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(sql).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function dump(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("SELECT path, content FROM file_versions").all();
    return JSON.stringify(rows);
  } finally {
    db.close();
  }
}

beforeAll(() => {
  const build = spawnSync(join(ROOT, "node_modules", ".bin", "tsup"), [], { cwd: ROOT, encoding: "utf-8" });
  if (build.status !== 0) throw new Error(`build failed: ${build.stdout}${build.stderr}`);
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("isExcludedPath", () => {
  test.each([
    ".env",
    ".env.local",
    ".env.production",
    "server.pem",
    "tls.key",
    "cert.p12",
    "cert.pfx",
    "app.keystore",
    "id_rsa",
    "id_rsa.bak",
    "id_ed25519",
    "id_ecdsa",
    ".npmrc",
    ".netrc",
    "credentials",
    "credentials.json",
    "secrets.yaml",
    "secrets.json",
  ])("excludes %s", (name) => {
    expect(isExcludedPath(`/proj/${name}`)).toBe(true);
  });

  test.each([".env.example", ".env.sample", ".env.template", ".env.dist", "id_rsa.pub", "id_ed25519.pub", "index.ts", "README.md", "environment.ts", "keys.ts"])(
    "allows %s",
    (name) => {
      expect(isExcludedPath(`/proj/${name}`)).toBe(false);
    },
  );

  test("is case-insensitive on basenames", () => {
    expect(isExcludedPath("/proj/.ENV")).toBe(true);
    expect(isExcludedPath("/proj/Server.PEM")).toBe(true);
    expect(isExcludedPath("/proj/Credentials.JSON")).toBe(true);
    expect(isExcludedPath("/proj/.ENV.EXAMPLE")).toBe(false);
  });

  test("excludes anything inside secret directories", () => {
    expect(isExcludedPath("/home/u/.ssh/config")).toBe(true);
    expect(isExcludedPath("/home/u/.aws/config")).toBe(true);
    expect(isExcludedPath("/home/u/.gnupg/pubring.kbx")).toBe(true);
    expect(isExcludedPath("/home/u/.ssh/nested/known_hosts")).toBe(true);
    expect(isExcludedPath("/home/u/ssh/config")).toBe(false);
  });

  test("extra patterns add to the defaults", () => {
    expect(isExcludedPath("/proj/vault.json")).toBe(false);
    expect(isExcludedPath("/proj/vault.json", ["vault.*"])).toBe(true);
    expect(isExcludedPath("/proj/a.secret", ["*.secret"])).toBe(true);
    expect(isExcludedPath("/proj/ab.txt", ["a?.txt"])).toBe(true);
    expect(isExcludedPath("/proj/abc.txt", ["a?.txt"])).toBe(false);
    expect(isExcludedPath("/proj/.env", ["vault.*"])).toBe(true);
  });
});

describe("StashStore with excluded files", () => {
  test("repeated reads return full content and persist nothing", async () => {
    const dir = newDir();
    const dbPath = join(dir, "stash.db");
    const envFile = join(dir, ".env");
    writeFileSync(envFile, SECRET);
    const { stash } = open(dbPath);
    try {
      const first = await stash.readFile(envFile);
      const second = await stash.readFile(envFile);
      for (const r of [first, second]) {
        expect(r.stashed).toBe(false);
        expect(r.content).toBe(SECRET);
        expect(r.totalLines).toBe(3);
      }
      expect(second.hash).toBe(first.hash);
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_stats WHERE key = 'tokens_saved'")).toBe(0);
      expect(count(dbPath, "SELECT value c FROM stats WHERE key = 'tokens_saved'")).toBe(0);
      expect((await stash.getStats()).tokensSaved).toBe(0);
    } finally {
      await stash.close();
    }
  });

  test("a non-secret file next to it is still stashed", async () => {
    const dir = newDir();
    const dbPath = join(dir, "stash.db");
    const envFile = join(dir, ".env");
    const srcFile = join(dir, "app.ts");
    writeFileSync(envFile, SECRET);
    writeFileSync(srcFile, "export const a = 1;\n".repeat(20));
    const { stash } = open(dbPath);
    try {
      await stash.readFile(envFile);
      expect((await stash.readFile(srcFile)).stashed).toBe(false);
      expect((await stash.readFile(srcFile)).stashed).toBe(true);
      await stash.readFile(envFile);
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(1);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(1);
      expect(dump(dbPath)).not.toContain("super-secret-value");
    } finally {
      await stash.close();
    }
  });

  test("partial reads return the plain slice without persisting", async () => {
    const dir = newDir();
    const dbPath = join(dir, "stash.db");
    const keyFile = join(dir, "deploy.pem");
    writeFileSync(keyFile, "l1\nl2\nl3\nl4\nl5");
    const { stash } = open(dbPath);
    try {
      for (let i = 0; i < 2; i++) {
        const r = await stash.readFile(keyFile, { offset: 2, limit: 2 });
        expect(r.stashed).toBe(false);
        expect(r.content).toBe("l2\nl3");
        expect(r.totalLines).toBe(5);
      }
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(0);
    } finally {
      await stash.close();
    }
  });

  test("readFileFull returns content and persists nothing", async () => {
    const dir = newDir();
    const dbPath = join(dir, "stash.db");
    const envFile = join(dir, ".env.local");
    writeFileSync(envFile, SECRET);
    const { stash } = open(dbPath);
    try {
      const r = await stash.readFileFull(envFile);
      expect(r.stashed).toBe(false);
      expect(r.content).toBe(SECRET);
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(0);
      expect(count(dbPath, "SELECT COUNT(*) c FROM session_reads")).toBe(0);
    } finally {
      await stash.close();
    }
  });

  test("extra patterns from config are never stored", async () => {
    const dir = newDir();
    const dbPath = join(dir, "stash.db");
    const file = join(dir, "vault.json");
    writeFileSync(file, '{"token":"abc"}');
    const { stash } = open(dbPath, { exclude: ["vault.*"] });
    try {
      await stash.readFile(file);
      expect((await stash.readFile(file)).stashed).toBe(false);
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(0);
    } finally {
      await stash.close();
    }
  });
});

describe("migration of existing databases", () => {
  test("purges rows for excluded paths and keeps the rest", async () => {
    const dir = newDir();
    const dbPath = join(dir, "stash.db");
    const first = open(dbPath);
    await first.stash.init();
    await first.stash.close();

    const db = new DatabaseSync(dbPath);
    const addVersion = db.prepare("INSERT INTO file_versions (path, hash, content, lines, created_at) VALUES (?, ?, ?, 1, 1)");
    const addRead = db.prepare("INSERT INTO session_reads (session_id, path, hash, read_at) VALUES (?, ?, ?, 1)");
    db.prepare("INSERT INTO sessions (session_id, pid) VALUES ('s1', ?)").run(process.pid);
    for (const p of ["/p/.env", "/p/keys/server.pem", "/home/u/.ssh/config", "/p/vault.json", "/p/.env.example", "/p/app.ts"]) {
      addVersion.run(p, "h1", "content of " + p);
      addRead.run("s1", p, "h1");
    }
    db.close();

    const { stash } = open(dbPath, { exclude: ["vault.*"] });
    try {
      await stash.init();
      const verify = new DatabaseSync(dbPath);
      const paths = (table: string) =>
        (verify.prepare(`SELECT path FROM ${table} ORDER BY path`).all() as { path: string }[]).map((r) => r.path);
      expect(paths("file_versions")).toEqual(["/p/.env.example", "/p/app.ts"]);
      expect(paths("session_reads")).toEqual(["/p/.env.example", "/p/app.ts"]);
      verify.close();
    } finally {
      await stash.close();
    }
  });
});

describe("MCP server", () => {
  test("FILESTASH_EXCLUDE keeps custom patterns out of the DB; stash dir and DB are private", async () => {
    const dir = newDir();
    const stashDir = join(dir, ".stash");
    const custom = join(dir, "notes.private");
    const secretEnv = join(dir, ".env");
    const normal = join(dir, "doc.ts");
    writeFileSync(custom, "private notes body\n");
    writeFileSync(secretEnv, SECRET);
    writeFileSync(normal, "export const answer = 42;\n// padding padding padding padding padding padding padding padding padding padding padding padding \n");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "serve"],
      cwd: dir,
      env: { ...(process.env as Record<string, string>), FILESTASH_DIR: stashDir, FILESTASH_EXCLUDE: " *.private, ,other.txt " },
    });
    const client = new Client({ name: "denylist-test", version: "0.0.0" });
    await client.connect(transport);
    const read = async (path: string) => {
      const res = (await client.callTool({ name: "read_file", arguments: { path } })) as { content: { text: string }[] };
      return res.content[0]!.text;
    };

    try {
      expect(await read(custom)).toContain("private notes body");
      expect(await read(custom)).toContain("private notes body");
      expect(await read(secretEnv)).toContain("super-secret-value");
      expect(await read(secretEnv)).toContain("super-secret-value");
      await read(normal);
      expect(await read(normal)).toContain("[filestash: unchanged");

      const dbPath = join(stashDir, "stash.db");
      expect(count(dbPath, "SELECT COUNT(*) c FROM file_versions")).toBe(1);
      expect(dump(dbPath)).toContain("doc.ts");
      expect(dump(dbPath)).not.toContain("private notes body");

      if (process.platform !== "win32") {
        expect(statSync(stashDir).mode & 0o777).toBe(0o700);
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      await client.close();
    }
  });
});
