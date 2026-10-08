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

interface Edits {
  removed: Uint8Array;
  added: Uint8Array;
}

const CONTEXT = 3;

export const MAX_EDIT_DISTANCE = 2500;
const MAX_SNAKE_STEPS = 20_000_000;

export function computeDiff(oldContent: string, newContent: string, filePath: string): DiffResult {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const shortest = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < shortest && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const n = oldLines.length - prefix - suffix;
  const m = newLines.length - prefix - suffix;
  if (n === 0 && m === 0) {
    return { diff: "", linesChanged: 0, hasChanges: false, changedNewLines: new Set() };
  }

  const edits = myersEdits(oldLines, newLines, prefix, n, m) ?? {
    removed: new Uint8Array(n).fill(1),
    added: new Uint8Array(m).fill(1),
  };

  const { rawLines, linesChanged } = buildRawLines(oldLines, newLines, prefix, suffix, edits);
  const changedNewLines = collectChangedLines(rawLines);
  const hunkGroups = groupIntoHunks(rawLines);
  const diff = formatDiff(hunkGroups, filePath);

  return { diff, linesChanged, hasChanges: true, changedNewLines };
}

// Greedy forward Myers over the lines between the common prefix and suffix. Returns null past the work caps.
function myersEdits(oldLines: string[], newLines: string[], off: number, n: number, m: number): Edits | null {
  const removed = new Uint8Array(n);
  const added = new Uint8Array(m);
  if (n === 0 || m === 0) return { removed: removed.fill(1), added: added.fill(1) };
  if (Math.abs(n - m) > MAX_EDIT_DISTANCE) return null;

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const base = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let steps = 0;
  let found = -1;

  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[base + k - 1]! < v[base + k + 1]!) ? v[base + k + 1]! : v[base + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && oldLines[off + x] === newLines[off + y]) {
        x++; y++; steps++;
      }
      if (steps > MAX_SNAKE_STEPS) return null;
      v[base + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
    const snapshot = new Int32Array(d + 1);
    for (let k = -d, i = 0; k <= d; k += 2, i++) snapshot[i] = v[base + k]!;
    trace.push(snapshot);
  }
  if (found < 0) return null;

  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const k = x - y;
    const prev = trace[d - 1]!;
    const at = (diagonal: number) => prev[(diagonal + d - 1) >> 1]!;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    if (down) added[prevY] = 1;
    else removed[prevX] = 1;
    x = prevX;
    y = prevY;
  }
  return { removed, added };
}

function buildRawLines(
  oldLines: string[],
  newLines: string[],
  prefix: number,
  suffix: number,
  edits: Edits,
): { rawLines: DiffLine[]; linesChanged: number } {
  const rawLines: DiffLine[] = [];
  const { removed, added } = edits;
  let linesChanged = 0;

  for (let i = 0; i < prefix; i++) {
    rawLines.push({ type: "keep", line: oldLines[i]!, oldLine: i + 1, newLine: i + 1 });
  }

  let oi = 0, ni = 0;
  while (oi < removed.length || ni < added.length) {
    if (oi < removed.length && ni < added.length && !removed[oi] && !added[ni]) {
      rawLines.push({ type: "keep", line: oldLines[prefix + oi]!, oldLine: prefix + oi + 1, newLine: prefix + ni + 1 });
      oi++; ni++;
      continue;
    }
    while (ni < added.length && added[ni]) {
      rawLines.push({ type: "add", line: newLines[prefix + ni]!, oldLine: prefix + oi + 1, newLine: prefix + ni + 1 });
      ni++; linesChanged++;
    }
    while (oi < removed.length && removed[oi]) {
      rawLines.push({ type: "remove", line: oldLines[prefix + oi]!, oldLine: prefix + oi + 1, newLine: prefix + ni + 1 });
      oi++; linesChanged++;
    }
  }

  const oldTail = prefix + removed.length;
  const newTail = prefix + added.length;
  for (let i = 0; i < suffix; i++) {
    rawLines.push({ type: "keep", line: oldLines[oldTail + i]!, oldLine: oldTail + i + 1, newLine: newTail + i + 1 });
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
    const line = rawLines[i]!;

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
  for (let c = contextEnd; c < upTo; c++) {
    current.push(rawLines[c]!);
  }
}

function formatDiff(hunkGroups: DiffLine[][], filePath: string): string {
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  for (const hunk of hunkGroups) {
    if (hunk.length === 0) continue;
    const first = hunk[0]!;
    const oldCount = hunk.filter(dl => dl.type === "keep" || dl.type === "remove").length;
    const newCount = hunk.filter(dl => dl.type === "keep" || dl.type === "add").length;
    lines.push(`@@ -${first.oldLine},${oldCount} +${first.newLine},${newCount} @@`);
    const prefixMap: Record<DiffLine["type"], string> = { add: "+", remove: "-", keep: " " };
    for (const dl of hunk) {
      const prefix = prefixMap[dl.type]!;
      lines.push(`${prefix}${dl.line}`);
    }
  }

  return lines.join("\n");
}
