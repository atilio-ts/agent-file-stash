import { describe, test, expect } from "vitest";
import { computeDiff } from "filestash-sdk";

describe("computeDiff", () => {
  test("empty old and new → no changes", () => {
    const result = computeDiff("", "", "f.ts");
    expect(result.hasChanges).toBe(false);
    expect(result.linesChanged).toBe(0);
    expect(result.diff).toBe("");
    expect(result.changedNewLines.size).toBe(0);
  });

  test("identical content → no changes", () => {
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;";
    const result = computeDiff(content, content, "f.ts");
    expect(result.hasChanges).toBe(false);
    expect(result.linesChanged).toBe(0);
    expect(result.diff).toBe("");
  });

  test("add-only: lines added at end", () => {
    const old = "line1\nline2";
    const next = "line1\nline2\nline3\nline4";
    const result = computeDiff(old, next, "f.ts");
    expect(result.hasChanges).toBe(true);
    expect(result.linesChanged).toBeGreaterThan(0);
    expect(result.changedNewLines.has(3)).toBe(true);
    expect(result.changedNewLines.has(4)).toBe(true);
    expect(result.diff).toContain("+line3");
    expect(result.diff).toContain("+line4");
  });

  test("remove-only: lines removed from end", () => {
    const old = "line1\nline2\nline3\nline4";
    const next = "line1\nline2";
    const result = computeDiff(old, next, "f.ts");
    expect(result.hasChanges).toBe(true);
    expect(result.linesChanged).toBeGreaterThan(0);
    expect(result.diff).toContain("-line3");
    expect(result.diff).toContain("-line4");
    // lines 1-2 are unchanged — not in changedNewLines
    expect(result.changedNewLines.has(1)).toBe(false);
    expect(result.changedNewLines.has(2)).toBe(false);
  });

  test("mixed: one line changed in the middle", () => {
    const old = "line1\nline2\nline3\nline4";
    const next = "line1\nCHANGED\nline3\nline4";
    const result = computeDiff(old, next, "f.ts");
    expect(result.hasChanges).toBe(true);
    expect(result.linesChanged).toBeGreaterThanOrEqual(1);
    expect(result.changedNewLines.has(2)).toBe(true);
    expect(result.diff).toContain("--- a/f.ts");
    expect(result.diff).toContain("+++ b/f.ts");
    expect(result.diff).toContain("@@");
    expect(result.diff).toContain("-line2");
    expect(result.diff).toContain("+CHANGED");
  });

  test("context lines: unchanged neighbours appear in hunk", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const modified = [...lines];
    modified[10] = "CHANGED";
    const result = computeDiff(lines.join("\n"), modified.join("\n"), "f.ts");
    expect(result.hasChanges).toBe(true);
    // Lines adjacent to change should appear as context in the diff
    expect(result.diff).toContain(" line9");  // context before
    expect(result.diff).toContain(" line11"); // context after
  });

  test(">5000 lines: LCS skipped, all lines treated as removes + adds", () => {
    // LCS_LINE_LIMIT = 5000; files with 5001 lines skip LCS entirely
    const old = Array.from({ length: 5001 }, (_, i) => `line ${i}`).join("\n");
    const next = Array.from({ length: 5001 }, (_, i) =>
      i === 2500 ? "CHANGED" : `line ${i}`,
    ).join("\n");
    const result = computeDiff(old, next, "f.ts");
    expect(result.hasChanges).toBe(true);
    // Without LCS, all old lines are removes and all new lines are adds
    expect(result.linesChanged).toBe(5001 + 5001);
  });

  test("exactly 5000 lines: LCS runs, produces minimal diff", () => {
    // Both files ≤ 5000 lines → LCS is not skipped
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const modified = [...base];
    modified[2500] = "CHANGED";
    const result = computeDiff(base.join("\n"), modified.join("\n"), "f.ts");
    expect(result.hasChanges).toBe(true);
    // LCS ran → only the changed line counts, not all 5000
    expect(result.linesChanged).toBeLessThan(100);
    expect(result.diff).toContain("-line 2500");
    expect(result.diff).toContain("+CHANGED");
  });
});