import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist", "cli.mjs");

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

function newestSource(): number {
  return Math.max(
    ...readdirSync(join(ROOT, "packages")).map((pkg) => {
      const src = join(ROOT, "packages", pkg, "src");
      return existsSync(src) ? newestMtime(src) : 0;
    }),
  );
}

export default function setup(): void {
  if (existsSync(DIST) && statSync(DIST).mtimeMs >= newestSource()) return;
  const build = spawnSync(join(ROOT, "node_modules", ".bin", "tsup"), [], { cwd: ROOT, encoding: "utf-8" });
  if (build.status !== 0) throw new Error(`build failed: ${build.stdout}${build.stderr}`);
}
