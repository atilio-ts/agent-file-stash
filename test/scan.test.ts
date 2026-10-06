import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findStashDatabases } from "../packages/cli/src/scan.js";

describe("findStashDatabases", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "filestash-scan-"));
    const make = (dir: string) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "stash.db"), "");
    };
    make("repo-a/.vscode/file-stash");
    make("repo-b/.file-stash");
    make("repo-c/node_modules/pkg/.file-stash");
    mkdirSync(join(root, "repo-d/.file-stash"), { recursive: true });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("finds stash databases in .file-stash and .vscode/file-stash", () => {
    const found = findStashDatabases(root).map((p) => p.slice(root.length + 1)).sort();
    expect(found).toEqual([
      "repo-a/.vscode/file-stash/stash.db",
      "repo-b/.file-stash/stash.db",
    ]);
  });

  it("returns nothing for a missing directory", () => {
    expect(findStashDatabases(join(root, "missing"))).toEqual([]);
  });
});
