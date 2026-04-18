import { watch as fsWatch, existsSync, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { CacheStore } from "./cache.js";

export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private readonly cache: CacheStore;
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;

  constructor(cache: CacheStore, debounceMs = 100) {
    this.cache = cache;
    this.debounceMs = debounceMs;
  }

  watch(paths: string[]): void {
    for (const p of paths) {
      const absPath = resolve(p);
      const watcher = fsWatch(absPath, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const filePath = resolve(absPath, filename);

        if (filename.startsWith(".") || filename.includes("node_modules") || filename.includes(".git")) {
          return;
        }

        const existing = this.debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          filePath,
          setTimeout(() => {
            this.debounceTimers.delete(filePath);
            this.handleChange(filePath).catch((e: unknown) => {
              process.stderr.write(
                `[filestash] unhandled watcher error: ${e instanceof Error ? e.message : String(e)}\n`,
              );
            });
          }, this.debounceMs),
        );
      });

      this.watchers.push(watcher);
    }
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  private async handleChange(filePath: string): Promise<void> {
    try {
      if (!existsSync(filePath)) {
        await this.cache.onFileDeleted(filePath);
      }
    } catch (e: unknown) {
      process.stderr.write(`[filestash] watcher error on ${filePath}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}
