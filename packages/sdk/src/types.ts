export interface CacheConfig {
  /** Path to the database file */
  dbPath: string;
  /** Session identifier. Each session tracks its own read state independently. */
  sessionId: string;
  /** Directories to watch for file changes. Defaults to cwd. */
  watchPaths?: string[];
}

interface FileReadResultBase {
  /** Total lines in the file */
  totalLines?: number;
  /** Content hash */
  hash: string;
}

interface FileReadResultFresh extends FileReadResultBase {
  cached: false;
  /** Full file content */
  content: string;
}

interface FileReadResultCached extends FileReadResultBase {
  cached: true;
  /** Short confirmation label or diff content */
  content: string;
  /** Lines changed since last read */
  linesChanged: number;
  /** Unified diff, present when file changed */
  diff?: string;
}

export type FileReadResult = FileReadResultFresh | FileReadResultCached;

export interface CacheStats {
  /** Total files cached */
  filesTracked: number;
  /** Approximate tokens saved across all sessions */
  tokensSaved: number;
  /** Approximate tokens saved in this session */
  sessionTokensSaved: number;
}
