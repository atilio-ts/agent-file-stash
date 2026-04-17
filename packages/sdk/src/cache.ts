import { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { computeDiff, type DiffResult } from "./differ.js";
import type { CacheConfig, CacheStats, FileReadResult } from "./types.js";

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

export class CacheStore {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;
  private readonly sessionId: string;
  private initialized = false;

  constructor(config: CacheConfig) {
    this.dbPath = config.dbPath;
    this.sessionId = config.sessionId;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(SCHEMA);
    this.initialized = true;
  }

  private getDb(): DatabaseSync {
    if (!this.db) throw new Error("CacheStore not initialized. Call init() first.");
    return this.db;
  }

  async readFile(filePath: string, options?: { offset?: number; limit?: number }): Promise<FileReadResult> {
    await this.init();
    const db = this.getDb();

    const absPath = resolve(filePath);
    statSync(absPath); // throws if file doesn't exist

    const currentContent = readFileSync(absPath, "utf-8");
    const currentHash = contentHash(currentContent);
    const currentLines = currentContent.split("\n").length;
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
      now: Date.now(),
    };

    const lastRead = db.prepare(
      "SELECT hash FROM session_reads WHERE session_id = ? AND path = ?"
    ).all(this.sessionId, absPath) as { hash: string }[];

    if (lastRead.length === 0) {
      return this.handleFirstRead(db, state);
    }

    const lastHash = lastRead[0].hash;

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

    return { cached: false, content: this.sliceContent(s), hash: s.currentHash, totalLines: s.currentLines };
  }

  private handleUnchanged(db: DatabaseSync, s: ReadState): FileReadResult {
    const slicedTokens = estimateTokens(this.sliceContent(s));
    this.addTokensSaved(db, slicedTokens);

    db.prepare(
      "UPDATE session_reads SET read_at = ? WHERE session_id = ? AND path = ?"
    ).run(s.now, this.sessionId, s.absPath);

    const label = s.isPartial
      ? `[cachebro: unchanged, lines ${s.rangeStart}-${s.rangeEnd} of ${s.currentLines}, ${slicedTokens} tokens saved]`
      : `[cachebro: unchanged, ${s.currentLines} lines, ${slicedTokens} tokens saved]`;

    return { cached: true, content: label, hash: s.currentHash, totalLines: s.currentLines, linesChanged: 0 };
  }

  private handleChanged(db: DatabaseSync, s: ReadState, lastHash: string): FileReadResult {
    const oldVersion = db.prepare(
      "SELECT content FROM file_versions WHERE path = ? AND hash = ?"
    ).all(s.absPath, lastHash) as { content: string }[];

    this.storeVersion(db, s.absPath, s.currentHash, s.currentContent, s.currentLines, s.now);
    db.prepare(
      "UPDATE session_reads SET hash = ?, read_at = ? WHERE session_id = ? AND path = ?"
    ).run(s.currentHash, s.now, this.sessionId, s.absPath);

    if (oldVersion.length > 0) {
      const diffResult = computeDiff(oldVersion[0].content, s.currentContent, s.absPath);
      if (diffResult.hasChanges) {
        return s.isPartial
          ? this.handlePartialDiff(db, s, diffResult)
          : this.handleFullDiff(db, s, diffResult);
      }
    }

    return { cached: false, content: this.sliceContent(s), hash: s.currentHash, totalLines: s.currentLines };
  }

  private handlePartialDiff(db: DatabaseSync, s: ReadState, diffResult: DiffResult): FileReadResult {
    if (!this.rangeHasChanges(diffResult.changedNewLines, s.rangeStart, s.rangeEnd)) {
      const slicedTokens = estimateTokens(this.sliceContent(s));
      this.addTokensSaved(db, slicedTokens);
      return {
        cached: true,
        content: `[cachebro: unchanged in lines ${s.rangeStart}-${s.rangeEnd}, changes elsewhere in file, ${slicedTokens} tokens saved]`,
        hash: s.currentHash,
        totalLines: s.currentLines,
        linesChanged: 0,
      };
    }

    return { cached: false, content: this.sliceContent(s), hash: s.currentHash, totalLines: s.currentLines };
  }

  private handleFullDiff(db: DatabaseSync, s: ReadState, diffResult: DiffResult): FileReadResult {
    const saved = Math.max(0, estimateTokens(s.currentContent) - estimateTokens(diffResult.diff));
    this.addTokensSaved(db, saved);

    return {
      cached: true,
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

  // Always returns full content and resets session tracking. Never records token savings.
  async readFileFull(filePath: string): Promise<FileReadResult> {
    await this.init();
    const db = this.getDb();

    const absPath = resolve(filePath);
    statSync(absPath);

    const currentContent = readFileSync(absPath, "utf-8");
    const currentHash = contentHash(currentContent);
    const currentLines = currentContent.split("\n").length;
    const now = Date.now();

    this.storeVersion(db, absPath, currentHash, currentContent, currentLines, now);
    db.prepare(
      "INSERT OR REPLACE INTO session_reads (session_id, path, hash, read_at) VALUES (?, ?, ?, ?)"
    ).run(this.sessionId, absPath, currentHash, now);

    return { cached: false, content: currentContent, hash: currentHash, totalLines: currentLines };
  }

  async onFileDeleted(filePath: string): Promise<void> {
    await this.init();
    const db = this.getDb();
    const absPath = resolve(filePath);
    db.prepare("DELETE FROM file_versions WHERE path = ?").run(absPath);
    db.prepare("DELETE FROM session_reads WHERE path = ?").run(absPath);
  }

  async getStats(): Promise<CacheStats> {
    await this.init();
    const db = this.getDb();

    const versions = db.prepare("SELECT COUNT(DISTINCT path) as c FROM file_versions").all() as { c: number }[];
    const tokens = db.prepare("SELECT value FROM stats WHERE key = 'tokens_saved'").all() as { value: number }[];
    const sessionTokens = db.prepare(
      "SELECT value FROM session_stats WHERE session_id = ? AND key = 'tokens_saved'"
    ).all(this.sessionId) as { value: number }[];

    return {
      filesTracked: versions.length > 0 ? versions[0].c : 0,
      tokensSaved: tokens.length > 0 ? tokens[0].value : 0,
      sessionTokensSaved: sessionTokens.length > 0 ? sessionTokens[0].value : 0,
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

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  private addTokensSaved(db: DatabaseSync, tokens: number): void {
    db.prepare(
      "UPDATE stats SET value = value + ? WHERE key = 'tokens_saved'"
    ).run(tokens);
    db.prepare(
      "INSERT INTO session_stats (session_id, key, value) VALUES (?, 'tokens_saved', ?) ON CONFLICT(session_id, key) DO UPDATE SET value = value + ?"
    ).run(this.sessionId, tokens, tokens);
  }
}