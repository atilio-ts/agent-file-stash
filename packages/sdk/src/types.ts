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
  /** True when the stash is unavailable and files are read without it */
  degraded: boolean;
  /** Why the stash is unavailable */
  degradedReason?: string;
  /** Path a corrupt database was moved to at startup */
  recoveredFrom?: string;
}
