import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STASH_DIR_NAMES = new Set([".file-stash", "file-stash"]);
const SKIPPED_DIRS = new Set(["node_modules", ".git", "build", "dist", "target", "bin", "obj"]);
const MAX_SCAN_DEPTH = 8;

export function findStashDatabases(root: string, depth = 0): string[] {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
    const dir = join(root, entry.name);
    if (STASH_DIR_NAMES.has(entry.name) && existsSync(join(dir, "stash.db"))) {
      found.push(join(dir, "stash.db"));
      continue;
    }
    found.push(...findStashDatabases(dir, depth + 1));
  }
  return found;
}
