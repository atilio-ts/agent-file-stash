export { StashStore } from "./stash.js";
export { FileWatcher } from "./watcher.js";
export { computeDiff } from "./differ.js";
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