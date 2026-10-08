export {
  StashStore,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_STORE_BYTES,
  HARD_MAX_READ_BYTES,
} from "./stash.js";
export { SCHEMA_VERSION, SchemaTooNewError } from "./migrations.js";
export { FileWatcher } from "./watcher.js";
export { computeDiff } from "./differ.js";
export { isExcludedPath } from "./exclude.js";
export type { StashConfig, StashStats, FileReadResult } from "./types.js";

import { StashStore } from "./stash.js";
import { FileWatcher } from "./watcher.js";
import type { StashConfig } from "./types.js";

/**
 * Create a filestash instance with file watching enabled.
 */
export function createStash(config: StashConfig): { stash: StashStore; watcher: FileWatcher } {
  const stash = new StashStore(config);
  const watcher = new FileWatcher(stash);

  if (config.watchPaths && config.watchPaths.length > 0) {
    watcher.watch(config.watchPaths);
  }

  return { stash, watcher };
}