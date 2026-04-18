export interface StashConfig {
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
}