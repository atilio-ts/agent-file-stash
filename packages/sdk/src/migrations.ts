import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

const SCHEMA_V1 = `
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

export const MIGRATIONS: readonly Migration[] = [{ version: 1, up: (db) => db.exec(SCHEMA_V1) }];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class SchemaTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(`database schema version ${found} is newer than this release supports (${supported}); upgrade agent-file-stash`);
    this.name = "SchemaTooNewError";
  }
}

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  const target = migrations[migrations.length - 1]!.version;
  const check = (version: number): void => {
    if (version > target) throw new SchemaTooNewError(version, target);
  };
  check(readUserVersion(db));
  for (const step of migrations) {
    if (readUserVersion(db) >= step.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = readUserVersion(db);
      check(current);
      if (current < step.version) {
        step.up(db);
        db.exec(`PRAGMA user_version = ${step.version}`);
      }
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
}
