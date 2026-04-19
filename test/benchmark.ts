/**
 * filestash latency benchmark
 *
 * Measures first-read, stashed-read, and diff-read latency across
 * small / medium / large TypeScript files, plus token savings rate.
 *
 * Run:  pnpm bench
 */

import { createStash } from "filestash-sdk";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
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
const COLD_ITERATIONS = 30; // creating a new stash per iteration is slower

// ---------------------------------------------------------------------------
// Agent Simulation
// ---------------------------------------------------------------------------

const AGENT_POOL_SIZES = [
  50, 100, 200, 200, 200, 500, 500, 500, 1000, 1000,
  200, 100, 500, 50, 200, 500, 200, 1000, 200, 500,
];
const AGENT_RUNS = 5;

interface AgentFile {
  path: string;
  original: string;
  modified: string;
}

interface AgentRun {
  tokensAWithout: number;
  tokensAWith: number;
  tokensBWithout: number;
  tokensBWith: number;
  rawLatencyAMs: number;
  fsLatencyAMs: number;
  rawLatencyBMs: number;
  fsLatencyBMs: number;
}

async function runAgentScenario(
  files: AgentFile[],
  editCount: number,
  dbPath: string,
): Promise<AgentRun> {
  for (const f of files) writeFileSync(f.path, f.original);

  // Single stash session — A and B share state so B sees prior reads
  const { stash, watcher } = createStash({ dbPath, sessionId: "agent-main" });
  await stash.init();

  // Pass A — raw baseline
  const rawStartA = performance.now();
  let tokensAWithout = 0;
  for (const f of files) tokensAWithout += Math.ceil(readFileSync(f.path, "utf-8").length / 4);
  const rawLatencyAMs = performance.now() - rawStartA;

  // Pass A — filestash (first reads: always returns full content)
  const fsStartA = performance.now();
  let tokensAWith = 0;
  for (const f of files) {
    const r = await stash.readFile(f.path);
    tokensAWith += Math.ceil(r.content.length / 4);
  }
  const fsLatencyAMs = performance.now() - fsStartA;

  // Edit files between sessions
  for (let i = 0; i < editCount; i++) writeFileSync(files[i]!.path, files[i]!.modified);

  // Pass B — raw baseline (reads current file content)
  const rawStartB = performance.now();
  let tokensBWithout = 0;
  for (const f of files) tokensBWithout += Math.ceil(readFileSync(f.path, "utf-8").length / 4);
  const rawLatencyBMs = performance.now() - rawStartB;

  // Pass B — filestash (unchanged → label, edited → diff)
  const fsStartB = performance.now();
  let tokensBWith = 0;
  for (const f of files) {
    const r = await stash.readFile(f.path);
    tokensBWith += Math.ceil(r.content.length / 4);
  }
  const fsLatencyBMs = performance.now() - fsStartB;

  watcher.close();
  await stash.close();

  return {
    tokensAWithout, tokensAWith,
    tokensBWithout, tokensBWith,
    rawLatencyAMs, fsLatencyAMs,
    rawLatencyBMs, fsLatencyBMs,
  };
}

function avgRuns(runs: AgentRun[]): AgentRun {
  const n = runs.length;
  const s = <K extends keyof AgentRun>(k: K) => runs.reduce((acc, r) => acc + r[k], 0);
  return {
    tokensAWithout: Math.round(s("tokensAWithout") / n),
    tokensAWith: Math.round(s("tokensAWith") / n),
    tokensBWithout: Math.round(s("tokensBWithout") / n),
    tokensBWith: Math.round(s("tokensBWith") / n),
    rawLatencyAMs: s("rawLatencyAMs") / n,
    fsLatencyAMs: s("fsLatencyAMs") / n,
    rawLatencyBMs: s("rawLatencyBMs") / n,
    fsLatencyBMs: s("fsLatencyBMs") / n,
  };
}

async function agentSimulation(benchDir: string, filePool: AgentFile[]): Promise<void> {
  async function bench(files: AgentFile[], editCount: number, tag: string): Promise<AgentRun> {
    const runs: AgentRun[] = [];
    for (let i = 0; i < AGENT_RUNS; i++) {
      runs.push(await runAgentScenario(files, editCount, join(benchDir, `${tag}_${i}.db`)));
    }
    return avgRuns(runs);
  }

  // S1 — 10 files, 1 edit (detailed: A / B / Total)
  const s1 = await bench(filePool.slice(0, 10), 1, "s1");

  // S2 — scale: file count sensitivity
  const s2: Array<{ count: number; r: AgentRun }> = [];
  for (const count of [3, 5, 10, 20]) {
    s2.push({ count, r: await bench(filePool.slice(0, count), 1, `s2_${count}`) });
  }

  // S3 — edit frequency sensitivity (10 files)
  const s3: Array<{ edits: number; r: AgentRun }> = [];
  for (const edits of [0, 1, 3, 5]) {
    s3.push({ edits, r: await bench(filePool.slice(0, 10), edits, `s3_${edits}`) });
  }

  const fmt = (n: number) => n.toLocaleString("en-US");
  const savingsPct = (with_: number, without: number) =>
    without === 0 ? "0 %" : `${Math.round((1 - with_ / without) * 100)} %`;
  const overheadPct = (raw: number, fs: number) => {
    if (raw === 0) return "n/a";
    const p = ((fs - raw) / raw) * 100;
    return p >= 0 ? `+${p.toFixed(1)} %` : `${p.toFixed(1)} %`;
  };

  console.log("\n## Agent Simulation\n");

  console.log("### Agent Simulation — Token Impact\n");
  console.log("| Scenario | Session | Tokens (raw) | Tokens (filestash) | Savings |");
  console.log("|----------|---------|-------------:|-------------------:|--------:|");

  const tokenRow = (label: string, session: string, without: number, with_: number) =>
    console.log(`| ${label} | ${session} | ${fmt(without)} | ${fmt(with_)} | ${savingsPct(with_, without)} |`);

  tokenRow("10 files, 1 edit", "A", s1.tokensAWithout, s1.tokensAWith);
  tokenRow("10 files, 1 edit", "B", s1.tokensBWithout, s1.tokensBWith);
  tokenRow("10 files, 1 edit", "Total", s1.tokensAWithout + s1.tokensBWithout, s1.tokensAWith + s1.tokensBWith);
  for (const { count, r } of s2) {
    tokenRow(`${count} files, 1 edit`, "Total", r.tokensAWithout + r.tokensBWithout, r.tokensAWith + r.tokensBWith);
  }
  for (const { edits, r } of s3) {
    tokenRow(`10 files, ${edits} edit${edits !== 1 ? "s" : ""}`, "Total", r.tokensAWithout + r.tokensBWithout, r.tokensAWith + r.tokensBWith);
  }

  console.log("\n### Agent Simulation — Latency\n");
  console.log("| Scenario | Pass | Raw read | Filestash read | Overhead |");
  console.log("|----------|------|:--------:|:--------------:|:--------:|");

  const latRow = (label: string, pass: string, raw: number, fs: number) =>
    console.log(`| ${label} | ${pass} | ${fmtMs(raw)} | ${fmtMs(fs)} | ${overheadPct(raw, fs)} |`);

  latRow("10 files, 1 edit", "A", s1.rawLatencyAMs, s1.fsLatencyAMs);
  latRow("10 files, 1 edit", "B", s1.rawLatencyBMs, s1.fsLatencyBMs);
  for (const { count, r } of s2) {
    latRow(`${count} files, 1 edit`, "B", r.rawLatencyBMs, r.fsLatencyBMs);
  }

  console.log(
    `\n_Agent simulation averaged over ${AGENT_RUNS} runs per scenario. ` +
      `Token formula: ceil(chars / 4). "Raw" = readFileSync; "filestash" = StashStore response content length._\n`
  );
}

async function main() {
  rmSync(BENCH_DIR, { recursive: true, force: true });
  mkdirSync(BENCH_DIR, { recursive: true });

  type Row = {
    scenario: string;
    firstRead: string;
    stashedRead: string;
    diffRead: string;
    stashedSavings: string;
  };
  const rows: Row[] = [];

  for (const { label, lines } of FILE_SIZES) {
    const filePath = join(BENCH_DIR, `file_${lines}.ts`);
    const dbPath = join(BENCH_DIR, `db_${lines}.db`);
    const content = generateFile(lines);
    const modified = modifyFile(content);
    writeFileSync(filePath, content);

    // Shared stash for stashed-read and diff-read scenarios
    const { stash, watcher } = createStash({ dbPath, sessionId: "bench-main" });
    await stash.init();
    await stash.readFile(filePath); // prime

    // 1. First read — new session each time (no prior read pointer)
    let sessionIdx = 0;
    const firstStats = await measure(async () => {
      const { stash: c, watcher: w } = createStash({
        dbPath,
        sessionId: `bench-cold-${sessionIdx++}`,
      });
      await c.init();
      await c.readFile(filePath);
      w.close();
      await c.close();
    }, COLD_ITERATIONS);

    // 2. Stashed read — same session, file unchanged
    const stashedStats = await measure(async () => { await stash.readFile(filePath); }, ITERATIONS);

    // 3. Diff read — alternate original↔modified so every call produces a diff
    let toggle = false;
    writeFileSync(filePath, modified); // prime with modified so first read sees a diff
    const diffStats = await measure(async () => {
      await stash.readFile(filePath);
      toggle = !toggle;
      writeFileSync(filePath, toggle ? content : modified);
    }, COLD_ITERATIONS);

    // Restore original so subsequent bench iterations start clean
    writeFileSync(filePath, content);

    // Token savings: stashed read returns ~10-token label vs full content
    const fullTokens = Math.ceil(content.length / 4);
    const savedPct = Math.round((1 - 10 / fullTokens) * 100);

    rows.push({
      scenario: label,
      firstRead: fmtMs(firstStats.mean),
      stashedRead: fmtMs(stashedStats.mean),
      diffRead: fmtMs(diffStats.mean),
      stashedSavings: `~${savedPct} %`,
    });

    watcher.close();
    await stash.close();
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  console.log("\n### Latency\n");
  console.log(
    "| File size | First read (cold) | Stashed read | Diff read | Token savings (stashed) |"
  );
  console.log(
    "|-----------|:-----------------:|:-----------:|:---------:|:----------------------:|"
  );
  for (const r of rows) {
    console.log(
      `| ${r.scenario} | ${r.firstRead} | ${r.stashedRead} | ${r.diffRead} | ${r.stashedSavings} |`
    );
  }
  console.log(
    "\n_Latency measured over " +
      ITERATIONS +
      " iterations (cold reads: " +
      COLD_ITERATIONS +
      "). Node.js built-in `node:sqlite`, WAL mode, warm OS page cache._\n"
  );

  // Agent simulation — generate file pool then run scenarios
  const filePool: AgentFile[] = AGENT_POOL_SIZES.map((lines, i) => {
    const path = join(BENCH_DIR, `agent_${i}.ts`);
    const original = generateFile(lines);
    const modified = modifyFile(original);
    writeFileSync(path, original);
    return { path, original, modified };
  });
  await agentSimulation(BENCH_DIR, filePool);

  rmSync(BENCH_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});