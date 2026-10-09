export interface StashConfig {
  /** Path to the database file */
  dbPath: string;
  /** Session identifier. Each session tracks its own read state independently. */
  sessionId: string;
  /** Directories to watch for file changes. Defaults to cwd. */
  watchPaths?: string[];
  /** Extra basename globs (`*`, `?`) that are never stored, in addition to the built-in secret denylist. */
  exclude?: string[];
  /** Move a corrupt database aside and start a new one. Defaults to true. */
  recoverCorrupt?: boolean;
  /** Do not write recovery or degraded-mode notices to stderr. */
  quiet?: boolean;
  /** Maximum lines returned by one read. Defaults to 2000. */
  maxLines?: number;
  /** Maximum characters returned by one read. Defaults to 100000. */
  maxChars?: number;
  /** Files larger than this many bytes are served capped and never stored. Defaults to 1000000. */
  maxStoreBytes?: number;
}

interface FileReadResultBase {
  /** Total lines in the file */
  totalLines?: number;
  /** Content hash */
  hash: string;
}

interface FileReadResultFresh extends FileReadResultBase {
  stashed: false;
  /** Full file content */
  content: string;
}

interface FileReadResultStashed extends FileReadResultBase {
  stashed: true;
  /** Short confirmation label or diff content */
  content: string;
  /** Lines changed since last read */
  linesChanged: number;
  /** Unified diff, present when file changed */
  diff?: string;
}

export type FileReadResult = FileReadResultFresh | FileReadResultStashed;

export interface StashStats {
  /** Total files in the stash */
  filesTracked: number;
  /** Approximate tokens saved across all sessions */
  tokensSaved: number;
  /** Approximate tokens saved in this session */
  sessionTokensSaved: number;
  /** Reads served in this session */
  sessionReads: number;
  /** Tokens a plain read of the same content would have returned in this session */
  sessionBaselineTokens: number;
  /** Tokens actually returned by the stash in this session */
  sessionSentTokens: number;
  /** Sessions counted since the lifetime counters started */
  lifetimeSessions: number;
  /** Reads served since the lifetime counters started */
  lifetimeReads: number;
  /** Tokens plain reads would have returned since the lifetime counters started */
  lifetimeBaselineTokens: number;
  /** Tokens actually returned since the lifetime counters started */
  lifetimeSentTokens: number;
  /** Estimated tool-definition tokens paid by the counted sessions */
  lifetimeOverheadTokens: number;
  /** Unix ms when the lifetime counters were first written */
  countersSince?: number;
  /** True when the stash is unavailable and files are read without it */
  degraded: boolean;
  /** Why the stash is unavailable */
  degradedReason?: string;
  /** Path a corrupt database was moved to at startup */
  recoveredFrom?: string;
}
