/**
 * Minimal unified diff implementation.
 * Computes a line-based diff between two strings and returns a compact representation.
 */

export interface DiffResult {
  /** Unified diff string */
  diff: string;
  /** Number of lines changed (added + removed) */
  linesChanged: number;
  /** Whether there are any changes */
  hasChanges: boolean;
  /** Line numbers in the NEW file that were added or modified */
  changedNewLines: Set<number>;
}

type DiffLine = { type: "keep" | "add" | "remove"; line: string; oldLine: number; newLine: number };

const CONTEXT = 3;

export function computeDiff(oldContent: string, newContent: string, filePath: string): DiffResult {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const lcs = longestCommonSubsequence(oldLines, newLines);

  const { rawLines, linesChanged } = buildRawLines(oldLines, newLines, lcs);
  const changedNewLines = collectChangedLines(rawLines);

  if (linesChanged === 0) {
    return { diff: "", linesChanged: 0, hasChanges: false, changedNewLines };
  }

  const hunkGroups = groupIntoHunks(rawLines);
  const diff = formatDiff(hunkGroups, filePath);

  return { diff, linesChanged, hasChanges: true, changedNewLines };
}

function buildRawLines(
  oldLines: string[],
  newLines: string[],
  lcs: string[],
): { rawLines: DiffLine[]; linesChanged: number } {
  const rawLines: DiffLine[] = [];
  let oldIdx = 0, newIdx = 0, lcsIdx = 0, linesChanged = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    const atLcsMatch =
      lcsIdx < lcs.length &&
      oldIdx < oldLines.length && oldLines[oldIdx] === lcs[lcsIdx] &&
      newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx];

    if (atLcsMatch) {
      rawLines.push({ type: "keep", line: oldLines[oldIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
      oldIdx++; newIdx++; lcsIdx++;
    } else if (newIdx < newLines.length && (lcsIdx >= lcs.length || newLines[newIdx] !== lcs[lcsIdx])) {
      rawLines.push({ type: "add", line: newLines[newIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
      newIdx++; linesChanged++;
    } else {
      rawLines.push({ type: "remove", line: oldLines[oldIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
      oldIdx++; linesChanged++;
    }
  }

  return { rawLines, linesChanged };
}

function collectChangedLines(rawLines: DiffLine[]): Set<number> {
  const changed = new Set<number>();
  for (const rl of rawLines) {
    if (rl.type === "add") {
      changed.add(rl.newLine);
    }
  }
  return changed;
}

function groupIntoHunks(rawLines: DiffLine[]): DiffLine[][] {
  const groups: DiffLine[][] = [];
  let current: DiffLine[] = [];
  let lastChangeIdx = -999;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    if (line.type === "keep") {
      if (current.length > 0 && i - lastChangeIdx <= CONTEXT) {
        current.push(line);
      }
      continue;
    }

    const isNewHunk = current.length > 0 && i - lastChangeIdx > CONTEXT * 2 + 1;
    const isFirstHunk = current.length === 0;

    if (isNewHunk) {
      groups.push(current);
      current = rawLines.slice(Math.max(0, i - CONTEXT), i);
    } else if (isFirstHunk) {
      current = rawLines.slice(Math.max(0, i - CONTEXT), i);
    } else {
      fillContextGap(current, rawLines, lastChangeIdx, i);
    }

    current.push(line);
    lastChangeIdx = i;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function fillContextGap(current: DiffLine[], rawLines: DiffLine[], lastChangeIdx: number, upTo: number): void {
  const contextEnd = lastChangeIdx + CONTEXT + 1;
  const inCurrent = new Set(current);
  for (let c = contextEnd; c < upTo; c++) {
    const line = rawLines[c];
    if (line !== undefined && !inCurrent.has(line)) {
      current.push(line);
      inCurrent.add(line);
    }
  }
}

function formatDiff(hunkGroups: DiffLine[][], filePath: string): string {
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  for (const hunk of hunkGroups) {
    if (hunk.length === 0) continue;
    const first = hunk[0];
    const oldCount = hunk.filter(dl => dl.type === "keep" || dl.type === "remove").length;
    const newCount = hunk.filter(dl => dl.type === "keep" || dl.type === "add").length;
    lines.push(`@@ -${first.oldLine},${oldCount} +${first.newLine},${newCount} @@`);
    const prefixMap: Record<DiffLine["type"], string> = { add: "+", remove: "-", keep: " " };
    for (const dl of hunk) {
      const prefix = prefixMap[dl.type];
      lines.push(`${prefix}${dl.line}`);
    }
  }

  return lines.join("\n");
}

const LCS_LINE_LIMIT = 5000;

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;

  if (m > LCS_LINE_LIMIT || n > LCS_LINE_LIMIT) {
    // Files too large for O(m×n) LCS — return empty to force a full-content result
    return [];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}