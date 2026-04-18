import { describe, test, expect } from "vitest";
import { isPathAllowed, formatReadResult } from "../packages/cli/src/mcp.js";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const cwd = import.meta.dirname;

describe("isPathAllowed", () => {
  test("returns true for path equal to cwd", () => {
    expect(isPathAllowed(cwd, cwd)).toBe(true);
  });

  test("returns true for path inside cwd subdirectory", () => {
    const subDir = resolve(cwd, "subdir");
    expect(isPathAllowed(subDir, cwd)).toBe(true);
  });

  test("returns false for ../ traversal above cwd", () => {
    const parentDir = resolve(cwd, "..", "..");
    expect(isPathAllowed(parentDir, cwd)).toBe(false);
  });

  test("returns false for absolute path outside cwd", () => {
    expect(isPathAllowed(tmpdir(), cwd)).toBe(false);
  });

  test("returns true for non-existent path inside cwd (realpathSync fallback)", () => {
    const nonExistent = resolve(cwd, "nonexistent-file-xyz");
    expect(isPathAllowed(nonExistent, cwd)).toBe(true);
  });
});

describe("formatReadResult", () => {
  test("returns content as-is when cached=false", () => {
    const result = { cached: false as const, content: "hello world", hash: "abc", totalLines: 1 };
    expect(formatReadResult(result)).toBe("hello world");
  });

  test("returns content as-is when cached=true and no diff", () => {
    const result = { cached: true as const, content: "[filestash: unchanged]", hash: "abc", totalLines: 5, linesChanged: 0 };
    expect(formatReadResult(result)).toBe("[filestash: unchanged]");
  });

  test("returns formatted diff string when cached=true with diff", () => {
    const diff = "@@ -1,2 +1,2 @@\n-old\n+new\n ctx";
    const result = {
      cached: true as const,
      content: diff,
      hash: "abc",
      totalLines: 10,
      linesChanged: 2,
      diff,
    };
    expect(formatReadResult(result)).toBe(
      `[filestash: 2 lines changed out of 10]\n${diff}`,
    );
  });
});