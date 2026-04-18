/**
 * filestash latency benchmark
 *
 * Measures first-read, cached-read, and diff-read latency across
 * small / medium / large TypeScript files, plus token savings rate.
 *
 * Run:  pnpm bench
 */

import { createCache } from "filestash-sdk";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = join(__dirname, ".tmp_bench");

// ---------------------------------------------------------------------------
// File generators
// ---------------------------------------------------------------------------

function generateFile(lines: number): string {
  const out: string[] = [
    `// Benchmark file — ${lines} lines`,
    `import { readFileSync } from "node:fs";`,
    "",
  ];
  for (let i = 0; i < lines; i++) {
    out.push(
      `export function fn${i}(x: number): number { return x * ${i} + Math.sin(x * ${i}); }`
    );
  }
  return out.join("\n");
}

/** Modify ~5 % of lines so the diff is realistic */
function modifyFile(content: string): string {
  const lines = content.split("\n");
  const count = Math.max(1, Math.floor(lines.length * 0.05));
  for (let i = 0; i < count; i++) {
    const idx = 3 + Math.floor(Math.random() * (lines.length - 3)); // skip header
    lines[idx] = lines[idx] + " /* updated */";
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

interface Stats {
  mean: number;
  p95: number;
}

async function measure(fn: () => Promise<void>, iterations: number): Promise<Stats> {
  // warmup
  for (let i = 0; i < 3; i++) await fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return {
    mean: times.reduce((s, v) => s + v, 0) / times.length,
    p95: times[Math.floor(times.length * 0.95)]!,
  };
}

function fmtMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const FILE_SIZES = [
  { label: "small (50 lines)", lines: 50 },
  { label: "medium (200 lines)", lines: 200 },
  { label: "large (1 000 lines)", lines: 1_000 },
];

const ITERATIONS = 100;
const COLD_ITERATIONS = 30; // creating a new cache per iteration is slower

async function main() {
  rmSync(BENCH_DIR, { recursive: true, force: true });
  mkdirSync(BENCH_DIR, { recursive: true });

  type Row = {
    scenario: string;
    firstRead: string;
    cachedRead: string;
    diffRead: string;
    cachedSavings: string;
  };
  const rows: Row[] = [];

  for (const { label, lines } of FILE_SIZES) {
    const filePath = join(BENCH_DIR, `file_${lines}.ts`);
    const dbPath = join(BENCH_DIR, `db_${lines}.db`);
    const content = generateFile(lines);
    const modified = modifyFile(content);
    writeFileSync(filePath, content);

    // Shared cache for cached-read and diff-read scenarios
    const { cache, watcher } = createCache({ dbPath, sessionId: "bench-main" });
    await cache.init();
    await cache.readFile(filePath); // prime

    // 1. First read — new session each time (no prior read pointer)
    let sessionIdx = 0;
    const firstStats = await measure(async () => {
      const { cache: c, watcher: w } = createCache({
        dbPath,
        sessionId: `bench-cold-${sessionIdx++}`,
      });
      await c.init();
      await c.readFile(filePath);
      w.close();
      await c.close();
    }, COLD_ITERATIONS);

    // 2. Cached read — same session, file unchanged
    const cachedStats = await measure(async () => { await cache.readFile(filePath); }, ITERATIONS);

    // 3. Diff read — alternate original↔modified so every call produces a diff
    let toggle = false;
    writeFileSync(filePath, modified); // prime with modified so first read sees a diff
    const diffStats = await measure(async () => {
      await cache.readFile(filePath);
      toggle = !toggle;
      writeFileSync(filePath, toggle ? content : modified);
    }, COLD_ITERATIONS);

    // Restore original so subsequent bench iterations start clean
    writeFileSync(filePath, content);

    // Token savings: cached read returns ~10-token label vs full content
    const fullTokens = Math.ceil(content.length / 4);
    const savedPct = Math.round((1 - 10 / fullTokens) * 100);

    rows.push({
      scenario: label,
      firstRead: fmtMs(firstStats.mean),
      cachedRead: fmtMs(cachedStats.mean),
      diffRead: fmtMs(diffStats.mean),
      cachedSavings: `~${savedPct} %`,
    });

    watcher.close();
    await cache.close();
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  console.log("\n### Latency\n");
  console.log(
    "| File size | First read (cold) | Cached read | Diff read | Token savings (cached) |"
  );
  console.log(
    "|-----------|:-----------------:|:-----------:|:---------:|:----------------------:|"
  );
  for (const r of rows) {
    console.log(
      `| ${r.scenario} | ${r.firstRead} | ${r.cachedRead} | ${r.diffRead} | ${r.cachedSavings} |`
    );
  }
  console.log(
    "\n_Latency measured over " +
      ITERATIONS +
      " iterations (cold reads: " +
      COLD_ITERATIONS +
      "). Node.js built-in `node:sqlite`, WAL mode, warm OS page cache._\n"
  );

  rmSync(BENCH_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});