import type { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, statSync, chmodSync, mkdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { computeDiff, type DiffResult } from "./differ.js";
import { isExcludedPath } from "./exclude.js";
import type { StashConfig, StashStats, FileReadResult } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS file_versions (
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  content     TEXT NOT NULL,
  lines       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (path, hash)
);

CREATE TABLE IF NOT EXISTS session_reads (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  read_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
);

CREATE TABLE IF NOT EXISTS session_ranges (
  session_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_ranges ON session_ranges (session_id, path);

CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  pid         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stats (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_stats (
  session_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, key)
);

INSERT OR IGNORE INTO stats (key, value) VALUES ('tokens_saved', 0);
`;

interface ReadState {
  absPath: string;
  currentContent: string;
  currentHash: string;
  currentLines: number;
  isPartial: boolean;
  rangeStart: number;
  rangeEnd: number;
  offset: number;
  limit: number;
  now: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const HASH_LENGTH = 16;

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, HASH_LENGTH);
}

export type Interval = [number, number];

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  const merged: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

export function coversRange(intervals: Interval[], start: number, end: number): boolean {
  return end >= start && intervals.some(([a, b]) => a <= start && b >= end);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

const OPEN_ATTEMPTS = 6;
const OPEN_BACKOFF_MS = 150;
const RECOVERY_LOCK_STALE_MS = 15_000;
const RECOVERY_LOCK_WAIT_MS = 8_000;
const RECOVERY_LOCK_POLL_MS = 50;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isCorruptError(err: unknown): boolean {
  const code = (err as { errcode?: number }).errcode;
  if (typeof code === "number" && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(code & 0xff)) return true;
  return /not a database|malformed|corrupt/i.test(errorMessage(err));
}

function isTransientError(err: unknown): boolean {
  const code = (err as { errcode?: number }).errcode;
  if (typeof code === "number" && [SQLITE_BUSY, SQLITE_LOCKED, SQLITE_IOERR].includes(code & 0xff)) return true;
  return /database is locked|database is busy|disk i\/o error/i.test(errorMessage(err));
}

function tryAcquireLock(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  try {
    if (Date.now() - statSync(lockPath).mtimeMs < RECOVERY_LOCK_STALE_MS) return false;
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

async function waitForLockRelease(lockPath: string): Promise<void> {
  const deadline = Date.now() + RECOVERY_LOCK_WAIT_MS;
  while (existsSync(lockPath) && Date.now() < deadline) await sleep(RECOVERY_LOCK_POLL_MS);
}

function queryOne<T>(db: DatabaseSync, sql: string, params: (string | number)[] = []): T | undefined {
  const rows = db.prepare(sql).all(...params) as T[];
  return rows[0];
}

export class StashStore {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;
  private readonly sessionId: string;
  private readonly exclude: string[];
  private initialized = false;
  private readonly recoverCorrupt: boolean;
  private readonly quiet: boolean;
  private recoveryAttempted = false;
  private recoveredFrom: string | undefined;
  private reason: string | undefined;

  constructor(config: StashConfig) {
    this.dbPath = config.dbPath;
    this.sessionId = config.sessionId;
    this.exclude = config.exclude ?? [];
    this.recoverCorrupt = config.recoverCorrupt ?? true;
    this.quiet = config.quiet ?? false;
  }

  get isDegraded(): boolean {
    return this.reason !== undefined;
  }

  get degradedReason(): string | undefined {
    return this.reason;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      this.db = await this.openWithRetry();
    } catch (err) {
      await this.recoverOrDegrade(err);
    }
    this.initialized = true;
  }

  private async openWithRetry(): Promise<DatabaseSync> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.openDb();
      } catch (err) {
        if (attempt >= OPEN_ATTEMPTS || !isTransientError(err)) throw err;
        await sleep(OPEN_BACKOFF_MS * attempt);
      }
    }
  }

  private async openDb(): Promise<DatabaseSync> {
    const { DatabaseSync } = await import("node:sqlite");
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.exec("PRAGMA journal_mode=WAL");
      db.exec(SCHEMA);
      this.registerSession(db);
      this.pruneClosedSessions(db);
    } catch (err) {
      try {
        db.close();
      } catch {
        // already unusable
      }
      throw err;
    }
    this.restrictPermissions();
    return db;
  }

  private async recoverOrDegrade(err: unknown): Promise<void> {
    if (!this.recoverCorrupt || this.recoveryAttempted || !isCorruptError(err)) return this.degrade(err);
    this.recoveryAttempted = true;
    const lockPath = `${this.dbPath}.recover.lock`;
    try {
      if (!tryAcquireLock(lockPath)) {
        await waitForLockRelease(lockPath);
        this.db = await this.openWithRetry();
        return;
      }
      try {
        try {
          this.db = await this.openWithRetry();
          return;
        } catch (again) {
          if (!isCorruptError(again)) throw again;
        }
        const moved = this.moveAside();
        this.db = await this.openWithRetry();
        this.recoveredFrom = moved;
        this.notice(`${this.dbPath} is corrupt (${errorMessage(err)}); moved to ${moved}, starting a new stash`);
      } finally {
        rmSync(lockPath, { force: true });
      }
    } catch (retryErr) {
      this.degrade(retryErr);
    }
  }

  private moveAside(): string {
    const target = `${this.dbPath}.corrupt-${Date.now()}`;
    for (const suffix of ["-wal", "-shm", ""]) {
      if (!existsSync(this.dbPath + suffix)) continue;
      try {
        renameSync(this.dbPath + suffix, target + suffix);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return target;
  }

  private notice(message: string): void {
    if (!this.quiet) process.stderr.write(`[filestash] ${message}\n`);
  }

  private degrade(err: unknown): void {
    if (this.reason !== undefined) return;
    this.reason = errorMessage(err);
    this.notice(`stash unavailable (${this.reason}); files are read normally, nothing is stashed`);
    try {
      this.db?.close();
    } catch {
      // already unusable
    }
    this.db = null;
  }

  private restrictPermissions(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(this.dbPath + suffix, 0o600);
      } catch {
        // missing sibling file or unsupported platform
      }
    }
  }

  private registerSession(db: DatabaseSync): void {
    db.prepare("INSERT OR REPLACE INTO sessions (session_id, pid) VALUES (?, ?)").run(this.sessionId, process.pid);
  }

  private pruneClosedSessions(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      this.purgeExcluded(db);
      const sessions = db.prepare("SELECT session_id, pid FROM sessions").all() as { session_id: string; pid: number }[];
      for (const s of sessions) {
        if (s.session_id !== this.sessionId && !isProcessAlive(s.pid)) {
          db.prepare("DELETE FROM sessions WHERE session_id = ?").run(s.session_id);
        }
      }
      db.exec("DELETE FROM session_reads WHERE session_id NOT IN (SELECT session_id FROM sessions)");
      db.exec("DELETE FROM session_ranges WHERE session_id NOT IN (SELECT session_id FROM sessions)");
      db.exec("DELETE FROM session_stats WHERE session_id NOT IN (SELECT session_id FROM sessions)");
      db.exec(
        "DELETE FROM file_versions WHERE NOT EXISTS (SELECT 1 FROM session_reads r WHERE r.path = file_versions.path AND r.hash = file_versions.hash)"
      );
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // no open transaction
      }
      throw err;
    }
  }

  private purgeExcluded(db: DatabaseSync): void {
    for (const table of ["file_versions", "session_reads", "session_ranges"]) {
      const rows = db.prepare(`SELECT DISTINCT path FROM ${table}`).all() as { path: string }[];
      for (const { path } of rows) {
        if (isExcludedPath(path, this.exclude)) db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(path);
      }
    }
  }

  private readFileSnapshot(filePath: string): {
    absPath: string;
    content: string;
    hash: string;
    lines: number;
    now: number;
  } {
    const absPath = resolve(filePath);
    statSync(absPath); // throws if file doesn't exist
    const content = readFileSync(absPath, "utf-8");
    return {
      absPath,
      content,
      hash: contentHash(content),
      lines: content.split("\n").length,
      now: Date.now(),
    };
  }

  async readFile(filePath: string, options?: { offset?: number; limit?: number }): Promise<FileReadResult> {
    await this.init();

    const { absPath, content: currentContent, hash: currentHash, lines: currentLines, now } = this.readFileSnapshot(filePath);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 0;
    const rangeStart = offset > 0 ? offset : 1;

    const state: ReadState = {
      absPath,
      currentContent,
      currentHash,
      currentLines,
      isPartial: offset > 0 || limit > 0,
      rangeStart,
      rangeEnd: limit > 0 ? rangeStart + limit - 1 : currentLines,
      offset,
      limit,
      now,
    };

    if (this.db) {
      try {
        return this.readWithDb(this.db, state);
      } catch (err) {
        this.degrade(err);
      }
    }
    return this.plainResult(state);
  }

  private plainResult(s: ReadState): FileReadResult {
    return { stashed: false, content: this.sliceContent(s), hash: s.currentHash, totalLines: s.currentLines };
  }

  private readWithDb(db: DatabaseSync, state: ReadState): FileReadResult {
    if (isExcludedPath(state.absPath, this.exclude)) {
      const content = this.sliceContent(state);
      this.recordRead(db, estimateTokens(content), estimateTokens(content));
      return { stashed: false, content, hash: state.currentHash, totalLines: state.currentLines };
    }

    const lastRead = queryOne<{ hash: string }>(db,
      "SELECT hash FROM session_reads WHERE session_id = ? AND path = ?",
      [this.sessionId, state.absPath],
    );

    if (!lastRead) {
      return this.handleFirstRead(db, state);
    }

    const lastHash = lastRead.hash;

    if (lastHash === state.currentHash) {
      return this.coversRequest(db, state, lastHash) ? this.handleUnchanged(db, state) : this.handleUncovered(db, state);
    }

    return this.handleChanged(db, state, lastHash);
  }

  private handleFirstRead(db: DatabaseSync, s: ReadState): FileReadResult {
    this.storeVersion(db, s.absPath, s.currentHash, s.currentContent, s.currentLines, s.now);
    db.prepare(
      "INSERT OR REPLACE INTO session_reads (session_id, path, hash, read_at) VALUES (?, ?, ?, ?)"
    ).run(this.sessionId, s.absPath, s.currentHash, s.now);
    this.clearRanges(db, s.absPath);

    return this.fullSlice(db, s);
  }

  private requestedEnd(s: ReadState): number {
    return Math.min(s.rangeEnd, s.currentLines);
  }

  private getRanges(db: DatabaseSync, absPath: string, hash: string): Interval[] {
    const rows = db.prepare(
      "SELECT start_line, end_line FROM session_ranges WHERE session_id = ? AND path = ? AND hash = ?"
    ).all(this.sessionId, absPath, hash) as { start_line: number; end_line: number }[];
    return rows.map((r) => [r.start_line, r.end_line]);
  }

  private coversRequest(db: DatabaseSync, s: ReadState, hash: string): boolean {
    return coversRange(this.getRanges(db, s.absPath, hash), s.rangeStart, this.requestedEnd(s));
  }

  private clearRanges(db: DatabaseSync, absPath: string): void {
    db.prepare("DELETE FROM session_ranges WHERE session_id = ? AND path = ?").run(this.sessionId, absPath);
  }

  private addRange(db: DatabaseSync, absPath: string, hash: string, start: number, end: number): void {
    if (end < start) return;
    const merged = mergeIntervals([...this.getRanges(db, absPath, hash), [start, end]]);
    db.prepare("DELETE FROM session_ranges WHERE session_id = ? AND path = ? AND hash = ?").run(this.sessionId, absPath, hash);
    const insert = db.prepare(
      "INSERT INTO session_ranges (session_id, path, hash, start_line, end_line) VALUES (?, ?, ?, ?, ?)"
    );
    for (const [a, b] of merged) insert.run(this.sessionId, absPath, hash, a, b);
  }

  private handleUncovered(db: DatabaseSync, s: ReadState): FileReadResult {
    db.prepare(
      "UPDATE session_reads SET read_at = ? WHERE session_id = ? AND path = ?"
    ).run(s.now, this.sessionId, s.absPath);
    return this.fullSlice(db, s);
  }

  private fullSlice(db: DatabaseSync, s: ReadState): FileReadResult {
    const content = this.sliceContent(s);
    this.addRange(db, s.absPath, s.currentHash, s.rangeStart, this.requestedEnd(s));
    this.recordRead(db, estimateTokens(content), estimateTokens(content));
    return { stashed: false, content, hash: s.currentHash, totalLines: s.currentLines };
  }

  private unchangedLabel(db: DatabaseSync, s: ReadState, label: (savedTokens: number) => string): FileReadResult {
    const content = this.sliceContent(s);
    const baseline = estimateTokens(content);
    const saved = Math.max(0, baseline - estimateTokens(label(baseline)));
    const text = label(saved);
    const sent = estimateTokens(text);
    const base = { stashed: true as const, hash: s.currentHash, totalLines: s.currentLines, linesChanged: 0 };
    this.addRange(db, s.absPath, s.currentHash, s.rangeStart, this.requestedEnd(s));
    if (sent >= baseline) {
      this.recordRead(db, baseline, baseline);
      return { ...base, content };
    }
    this.recordRead(db, baseline, sent);
    return { ...base, content: text };
  }

  private handleUnchanged(db: DatabaseSync, s: ReadState): FileReadResult {
    db.prepare(
      "UPDATE session_reads SET read_at = ? WHERE session_id = ? AND path = ?"
    ).run(s.now, this.sessionId, s.absPath);

    return this.unchangedLabel(db, s, (tokens) =>
      s.isPartial
        ? `[filestash: unchanged, lines ${s.rangeStart}-${s.rangeEnd} of ${s.currentLines}, ${tokens} tokens saved]`
        : `[filestash: unchanged, ${s.currentLines} lines, ${tokens} tokens saved]`,
    );
  }

  private handleChanged(db: DatabaseSync, s: ReadState, lastHash: string): FileReadResult {
    const oldVersion = queryOne<{ content: string; lines: number }>(db,
      "SELECT content, lines FROM file_versions WHERE path = ? AND hash = ?",
      [s.absPath, lastHash],
    );

    const oldFullyDelivered =
      !!oldVersion && coversRange(this.getRanges(db, s.absPath, lastHash), 1, oldVersion.lines);

    this.storeVersion(db, s.absPath, s.currentHash, s.currentContent, s.currentLines, s.now);
    db.prepare(
      "UPDATE session_reads SET hash = ?, read_at = ? WHERE session_id = ? AND path = ?"
    ).run(s.currentHash, s.now, this.sessionId, s.absPath);
    this.clearRanges(db, s.absPath);

    if (oldVersion && oldFullyDelivered) {
      const diffResult = computeDiff(oldVersion.content, s.currentContent, s.absPath);
      if (diffResult.hasChanges) {
        return s.isPartial
          ? this.handlePartialDiff(db, s, diffResult)
          : this.handleFullDiff(db, s, diffResult);
      }
    }

    return this.fullSlice(db, s);
  }

  private handlePartialDiff(db: DatabaseSync, s: ReadState, diffResult: DiffResult): FileReadResult {
    if (!this.rangeHasChanges(diffResult.changedNewLines, s.rangeStart, s.rangeEnd)) {
      return this.unchangedLabel(db, s, (tokens) =>
        `[filestash: unchanged in lines ${s.rangeStart}-${s.rangeEnd}, changes elsewhere in file, ${tokens} tokens saved]`,
      );
    }

    return this.fullSlice(db, s);
  }

  private handleFullDiff(db: DatabaseSync, s: ReadState, diffResult: DiffResult): FileReadResult {
    const contentTokens = estimateTokens(s.currentContent);
    const diffTokens = estimateTokens(diffResult.diff);
    if (diffTokens >= contentTokens) return this.fullSlice(db, s);

    this.addRange(db, s.absPath, s.currentHash, 1, s.currentLines);
    this.recordRead(db, contentTokens, diffTokens);

    return {
      stashed: true,
      content: diffResult.diff,
      diff: diffResult.diff,
      hash: s.currentHash,
      linesChanged: diffResult.linesChanged,
      totalLines: s.currentLines,
    };
  }

  private sliceContent(s: ReadState): string {
    if (!s.isPartial) return s.currentContent;
    const lines = s.currentContent.split("\n");
    const start = s.offset > 0 ? s.offset - 1 : 0;
    const end = s.limit > 0 ? start + s.limit : lines.length;
    return lines.slice(start, end).join("\n");
  }

  private rangeHasChanges(changedLines: Set<number>, rangeStart: number, rangeEnd: number): boolean {
    for (let l = rangeStart; l <= rangeEnd; l++) {
      if (changedLines.has(l)) return true;
    }
    return false;
  }

  private storeVersion(db: DatabaseSync, absPath: string, hash: string, content: string, lines: number, now: number): void {
    db.prepare(
      "INSERT OR IGNORE INTO file_versions (path, hash, content, lines, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(absPath, hash, content, lines, now);
  }

  // Always returns full content and resets session tracking. Counts as a plain read (baseline equals sent).
  async readFileFull(filePath: string): Promise<FileReadResult> {
    await this.init();

    const { absPath, content, hash, lines, now } = this.readFileSnapshot(filePath);
    const result: FileReadResult = { stashed: false, content, hash, totalLines: lines };
    if (!this.db) return result;

    try {
      const tokens = estimateTokens(content);
      if (!isExcludedPath(absPath, this.exclude)) {
        this.storeVersion(this.db, absPath, hash, content, lines, now);
        this.db.prepare(
          "INSERT OR REPLACE INTO session_reads (session_id, path, hash, read_at) VALUES (?, ?, ?, ?)"
        ).run(this.sessionId, absPath, hash, now);
        this.clearRanges(this.db, absPath);
        this.addRange(this.db, absPath, hash, 1, lines);
      }
      this.recordRead(this.db, tokens, tokens);
    } catch (err) {
      this.degrade(err);
    }
    return result;
  }

  async onFileDeleted(filePath: string): Promise<void> {
    await this.init();
    const absPath = resolve(filePath);
    this.guarded((db) => {
      db.prepare("DELETE FROM file_versions WHERE path = ?").run(absPath);
      db.prepare("DELETE FROM session_reads WHERE path = ?").run(absPath);
      db.prepare("DELETE FROM session_ranges WHERE path = ?").run(absPath);
    });
  }

  private guarded<T>(fn: (db: DatabaseSync) => T): T | undefined {
    if (!this.db) return undefined;
    try {
      return fn(this.db);
    } catch (err) {
      this.degrade(err);
      return undefined;
    }
  }

  async getStats(): Promise<StashStats> {
    await this.init();

    const stats = this.guarded((db): StashStats => {
      const versionRow = queryOne<{ c: number }>(db, "SELECT COUNT(DISTINCT path) as c FROM file_versions");
      const tokenRow = queryOne<{ value: number }>(db, "SELECT value FROM stats WHERE key = 'tokens_saved'");
      const sessionStat = (key: string) =>
        queryOne<{ value: number }>(db, "SELECT value FROM session_stats WHERE session_id = ? AND key = ?", [this.sessionId, key])?.value ?? 0;

      return {
        filesTracked: versionRow?.c ?? 0,
        tokensSaved: tokenRow?.value ?? 0,
        sessionTokensSaved: sessionStat("tokens_saved"),
        sessionReads: sessionStat("reads"),
        sessionBaselineTokens: sessionStat("baseline_tokens"),
        sessionSentTokens: sessionStat("sent_tokens"),
        degraded: false,
        ...(this.recoveredFrom && { recoveredFrom: this.recoveredFrom }),
      };
    });
    if (stats) return stats;

    return {
      filesTracked: 0,
      tokensSaved: 0,
      sessionTokensSaved: 0,
      sessionReads: 0,
      sessionBaselineTokens: 0,
      sessionSentTokens: 0,
      degraded: true,
      ...(this.reason && { degradedReason: this.reason }),
    };
  }

  async clear(): Promise<void> {
    await this.init();
    this.guarded((db) => {
      db.prepare("DELETE FROM file_versions").run();
      db.prepare("DELETE FROM session_reads").run();
      db.prepare("DELETE FROM session_ranges").run();
      db.prepare("DELETE FROM session_stats").run();
      db.prepare("UPDATE stats SET value = 0").run();
    });
  }

  async resetReads(): Promise<void> {
    await this.init();
    this.guarded((db) => {
      db.prepare("DELETE FROM session_reads").run();
      db.prepare("DELETE FROM session_ranges").run();
    });
  }

  async close(): Promise<void> {
    if (!this.db) return;
    try {
      this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(this.sessionId);
    } catch {
      // database already unusable
    }
    try {
      this.db.close();
    } catch {
      // already closed
    }
    this.db = null;
    this.initialized = false;
  }

  private recordRead(db: DatabaseSync, baseline: number, sent: number): void {
    this.bumpSessionStat(db, "reads", 1);
    this.bumpSessionStat(db, "baseline_tokens", baseline);
    this.bumpSessionStat(db, "sent_tokens", sent);
    if (baseline > sent) this.addTokensSaved(db, baseline - sent);
  }

  private bumpSessionStat(db: DatabaseSync, key: string, n: number): void {
    db.prepare(
      "INSERT INTO session_stats (session_id, key, value) VALUES (?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET value = value + ?"
    ).run(this.sessionId, key, n, n);
  }

  private addTokensSaved(db: DatabaseSync, tokens: number): void {
    db.prepare(
      "UPDATE stats SET value = value + ? WHERE key = 'tokens_saved'"
    ).run(tokens);
    this.bumpSessionStat(db, "tokens_saved", tokens);
  }
}
