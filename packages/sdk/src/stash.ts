import type { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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

  constructor(config: StashConfig) {
    this.dbPath = config.dbPath;
    this.sessionId = config.sessionId;
    this.exclude = config.exclude ?? [];
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    const { DatabaseSync } = await import("node:sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(SCHEMA);
    this.registerSession(this.db);
    this.pruneClosedSessions(this.db);
    this.restrictPermissions();
    this.initialized = true;
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
      db.exec("DELETE FROM session_stats WHERE session_id NOT IN (SELECT session_id FROM sessions)");
      db.exec(
        "DELETE FROM file_versions WHERE NOT EXISTS (SELECT 1 FROM session_reads r WHERE r.path = file_versions.path AND r.hash = file_versions.hash)"
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  private purgeExcluded(db: DatabaseSync): void {
    for (const table of ["file_versions", "session_reads"]) {
      const rows = db.prepare(`SELECT DISTINCT path FROM ${table}`).all() as { path: string }[];
      for (const { path } of rows) {
        if (isExcludedPath(path, this.exclude)) db.prepare(`DELETE FROM ${table} WHERE path = ?`).run(path);
      }
    }
  }

  private getDb(): DatabaseSync {
    if (!this.db) throw new Error("StashStore not initialized. Call init() first.");
    return this.db;
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
    const db = this.getDb();

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

    if (isExcludedPath(absPath, this.exclude)) {
      const content = this.sliceContent(state);
      this.recordRead(db, estimateTokens(content), estimateTokens(content));
      return { stashed: false, content, hash: currentHash, totalLines: currentLines };
    }

    const lastRead = queryOne<{ hash: string }>(db,
      "SELECT hash FROM session_reads WHERE session_id = ? AND path = ?",
      [this.sessionId, absPath],
    );

    if (!lastRead) {
      return this.handleFirstRead(db, state);
    }

    const lastHash = lastRead.hash;

    if (lastHash === currentHash) {
      return this.handleUnchanged(db, state);
    }

    return this.handleChanged(db, state, lastHash);
  }

  private handleFirstRead(db: DatabaseSync, s: ReadState): FileReadResult {
    this.storeVersion(db, s.absPath, s.currentHash, s.currentContent, s.currentLines, s.now);
    db.prepare(
      "INSERT OR REPLACE INTO session_reads (session_id, path, hash, read_at) VALUES (?, ?, ?, ?)"
    ).run(this.sessionId, s.absPath, s.currentHash, s.now);

    return this.fullSlice(db, s);
  }

  private fullSlice(db: DatabaseSync, s: ReadState): FileReadResult {
    const content = this.sliceContent(s);
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
    const oldVersion = queryOne<{ content: string }>(db,
      "SELECT content FROM file_versions WHERE path = ? AND hash = ?",
      [s.absPath, lastHash],
    );

    this.storeVersion(db, s.absPath, s.currentHash, s.currentContent, s.currentLines, s.now);
    db.prepare(
      "UPDATE session_reads SET hash = ?, read_at = ? WHERE session_id = ? AND path = ?"
    ).run(s.currentHash, s.now, this.sessionId, s.absPath);

    if (oldVersion) {
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
    const db = this.getDb();

    const { absPath, content, hash, lines, now } = this.readFileSnapshot(filePath);
    const tokens = estimateTokens(content);
    if (isExcludedPath(absPath, this.exclude)) {
      this.recordRead(db, tokens, tokens);
      return { stashed: false, content, hash, totalLines: lines };
    }

    this.storeVersion(db, absPath, hash, content, lines, now);
    db.prepare(
      "INSERT OR REPLACE INTO session_reads (session_id, path, hash, read_at) VALUES (?, ?, ?, ?)"
    ).run(this.sessionId, absPath, hash, now);

    this.recordRead(db, tokens, tokens);
    return { stashed: false, content, hash, totalLines: lines };
  }

  async onFileDeleted(filePath: string): Promise<void> {
    await this.init();
    const db = this.getDb();
    const absPath = resolve(filePath);
    db.prepare("DELETE FROM file_versions WHERE path = ?").run(absPath);
    db.prepare("DELETE FROM session_reads WHERE path = ?").run(absPath);
  }

  async getStats(): Promise<StashStats> {
    await this.init();
    const db = this.getDb();

    const versionRow = queryOne<{ c: number }>(db, "SELECT COUNT(DISTINCT path) as c FROM file_versions");
    const tokenRow = queryOne<{ value: number }>(db, "SELECT value FROM stats WHERE key = 'tokens_saved'");
    const sessionTokenRow = queryOne<{ value: number }>(db,
      "SELECT value FROM session_stats WHERE session_id = ? AND key = 'tokens_saved'",
      [this.sessionId],
    );

    const sessionStat = (key: string) =>
      queryOne<{ value: number }>(db, "SELECT value FROM session_stats WHERE session_id = ? AND key = ?", [this.sessionId, key])?.value ?? 0;

    return {
      filesTracked: versionRow?.c ?? 0,
      tokensSaved: tokenRow?.value ?? 0,
      sessionTokensSaved: sessionTokenRow?.value ?? 0,
      sessionReads: sessionStat("reads"),
      sessionBaselineTokens: sessionStat("baseline_tokens"),
      sessionSentTokens: sessionStat("sent_tokens"),
    };
  }

  async clear(): Promise<void> {
    await this.init();
    const db = this.getDb();
    db.prepare("DELETE FROM file_versions").run();
    db.prepare("DELETE FROM session_reads").run();
    db.prepare("DELETE FROM session_stats").run();
    db.prepare("UPDATE stats SET value = 0").run();
  }

  async resetReads(): Promise<void> {
    await this.init();
    this.getDb().prepare("DELETE FROM session_reads").run();
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(this.sessionId);
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
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
