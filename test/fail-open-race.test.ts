import { describe, test, expect, afterAll } from "vitest";
import { createStash } from "filestash-sdk";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAll, createSandbox, startServer } from "./helpers/mcp.js";

const GARBAGE = "this is definitely not a sqlite database, just bytes ".repeat(40);
const BODY = Array.from({ length: 60 }, (_, i) => `export const value${i} = ${i};`).join("\n") + "\n";

const roots: string[] = [];

function tempDb(): { dir: string; dbPath: string; file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "filestash-race-")));
  roots.push(dir);
  const file = join(dir, "a.ts");
  writeFileSync(file, BODY);
  const stashDir = join(dir, "stash");
  mkdirSync(stashDir);
  return { dir, dbPath: join(stashDir, "stash.db"), file };
}

function corruptFiles(dbPath: string): string[] {
  const dir = join(dbPath, "..");
  return readdirSync(dir).filter((f) => f.startsWith("stash.db.corrupt-"));
}

function hasLock(dbPath: string): boolean {
  return readdirSync(join(dbPath, "..")).includes("stash.db.recover.lock");
}

afterAll(async () => {
  await cleanupAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("concurrent recovery of a corrupt database", () => {
  test("eight stores opening the same corrupt database recover it exactly once", async () => {
    const { dbPath, file } = tempDb();
    writeFileSync(dbPath, GARBAGE);
    const handles = Array.from({ length: 8 }, (_, i) => createStash({ dbPath, sessionId: `s${i}`, quiet: true }));
    try {
      const firsts = await Promise.all(handles.map((h) => h.stash.readFile(file)));
      const seconds = await Promise.all(handles.map((h) => h.stash.readFile(file)));
      expect(firsts.every((r) => r.content === BODY)).toBe(true);
      expect(seconds.every((r) => r.stashed)).toBe(true);
      expect(handles.every((h) => !h.stash.isDegraded)).toBe(true);
      expect(corruptFiles(dbPath)).toHaveLength(1);
      expect(hasLock(dbPath)).toBe(false);
    } finally {
      for (const h of handles) {
        h.watcher.close();
        await h.stash.close();
      }
    }
  });

  test("a stale recovery lock left by a crashed process does not block recovery", async () => {
    const { dbPath, file } = tempDb();
    writeFileSync(dbPath, GARBAGE);
    const lock = `${dbPath}.recover.lock`;
    writeFileSync(lock, "999999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const { stash, watcher } = createStash({ dbPath, sessionId: "stale", quiet: true });
    try {
      expect((await stash.readFile(file)).content).toBe(BODY);
      expect(stash.isDegraded).toBe(false);
      expect(corruptFiles(dbPath)).toHaveLength(1);
      expect(hasLock(dbPath)).toBe(false);
    } finally {
      watcher.close();
      await stash.close();
    }
  });

  test("a store waits for a live recovery to finish instead of moving the database again", async () => {
    const { dbPath, file } = tempDb();
    writeFileSync(dbPath, GARBAGE);
    const lock = `${dbPath}.recover.lock`;
    writeFileSync(lock, String(process.pid));
    const finishOtherRecovery = setTimeout(() => {
      rmSync(dbPath, { force: true });
      rmSync(lock, { force: true });
    }, 400);
    const { stash, watcher } = createStash({ dbPath, sessionId: "waiter", quiet: true });
    const started = Date.now();
    try {
      expect((await stash.readFile(file)).content).toBe(BODY);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(stash.isDegraded).toBe(false);
      expect(corruptFiles(dbPath)).toHaveLength(0);
    } finally {
      clearTimeout(finishOtherRecovery);
      watcher.close();
      await stash.close();
    }
  });

  test("six real servers starting together on a corrupt database all keep working", async () => {
    const sb = createSandbox();
    mkdirSync(sb.stashDir, { recursive: true });
    writeFileSync(sb.dbPath, GARBAGE);
    const file = join(sb.project, "a.ts");
    writeFileSync(file, BODY);

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const server = await startServer(sb);
        const first = await server.read(file);
        const second = await server.read(file);
        const status = (await server.call("stash_status")).text;
        return { first, second, status };
      }),
    );

    for (const o of outcomes) {
      expect(o.first).toBe(BODY);
      expect(o.second).toContain("unchanged");
      expect(o.status).not.toContain("DEGRADED");
    }
    expect(corruptFiles(sb.dbPath)).toHaveLength(1);
    expect(hasLock(sb.dbPath)).toBe(false);
  });
});

describe("transient locks while opening the database", () => {
  test("a database held by another process for a moment does not degrade the stash", async () => {
    const { dbPath, file } = tempDb();
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE seed (x INTEGER)");
    seed.close();
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(process.argv[1]);
         db.exec("BEGIN EXCLUSIVE");
         console.log("locked");
         setTimeout(() => { db.exec("COMMIT"); process.exit(0); }, 600);`,
        dbPath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.once("data", () => resolve());
      holder.once("error", reject);
      holder.once("exit", () => reject(new Error("lock holder exited early")));
    });
    const { stash, watcher } = createStash({ dbPath, sessionId: "blocked", quiet: true });
    try {
      expect((await stash.readFile(file)).content).toBe(BODY);
      expect((await stash.readFile(file)).stashed).toBe(true);
      expect(stash.isDegraded).toBe(false);
    } finally {
      watcher.close();
      await stash.close();
      holder.kill("SIGKILL");
    }
  });
});
