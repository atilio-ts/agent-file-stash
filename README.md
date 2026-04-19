<p align="center">
  <img src="logo.svg" alt="agent-file-stash" width="200" />
</p>

# agent-file-stash

File cache with diff tracking for AI coding agents. Powered by SQLite (`node:sqlite`, built into Node.js 24+).

Agents waste most of their token budget re-reading files they've already seen. agent-file-stash fixes this: on first read it caches the file, on subsequent reads it returns either "unchanged" (one line instead of the whole file) or a compact diff of what changed. Drop-in replacement for file reads that agents adopt on their own.

## Benchmark

### Real-world A/B test

We ran the same refactoring task on a 268-file TypeScript codebase ([opencode](https://github.com/sst/opencode)) twice — same agent (Claude Opus), same prompt — with agent-file-stash enabled or disabled as the only variable.

| | Without agent-file-stash | With agent-file-stash |
|---|---:|---:|
| Total tokens | 158,248 | 117,188 |
| Tool calls | 60 | 58 |
| Files touched | 12 | 12 |

**26% fewer tokens. Same task, same result.** Every token an AI model processes costs money and adds latency. agent-file-stash eliminated ~33,000 tokens by returning compact stash labels and diffs instead of resending full file contents the agent had already seen.

The savings grow across consecutive tasks on the same codebase, because more files are already stashed when each new task starts:

| Task | Tokens used | Tokens saved | Cumulative savings |
|------|------------:|-------------:|-------------------:|
| 1. Add session export command | 62,190 | 2,925 | 2,925 |
| 2. Add --since flag to session list | 41,167 | 15,571 | 18,496 |
| 3. Add session stats subcommand | 63,169 | 35,355 | 53,851 |

By task 3, agent-file-stash saved **35,355 tokens in a single task** — a 36% reduction. Over the full 3-task sequence: **53,851 tokens saved out of 166,526 consumed (24% less)**.

### Agent simulation

The real-world test proves agent-file-stash works. The simulation explains *why* and *how much*, in a controlled, reproducible environment.

**What it models:** the most common agent workflow — read a set of files to understand the code, make an edit, then read those files again to verify or continue. We generated 10 TypeScript files of mixed sizes (50–1,000 lines), ran this two-pass workflow, and measured token usage and wall-clock time against plain file reads. Each scenario was averaged over 5 runs.

- **Session A** — the first exploration pass. The agent reads all 10 files for the first time. agent-file-stash has no prior state yet, so it returns full file content, just like a normal read. No savings — this is the baseline.
- **Session B** — the follow-up pass, after one file has been edited. The agent re-reads the same 10 files. Now agent-file-stash knows exactly what the agent already saw: 9 unchanged files each return a single-line stash label (e.g. `[filestash: unchanged, 245 lines, 1,837 tokens saved]`), and the 1 edited file returns only a compact diff of what changed.

#### Token impact

| Scenario | Pass | Tokens (raw) | Tokens (agent-file-stash) | Savings |
|----------|------|-------------:|-------------------:|--------:|
| 10 files, 1 edit | A — first read | 85,452 | 85,452 | 0 % |
| 10 files, 1 edit | B — re-read | 85,459 | 488 | **99 %** |
| 10 files, 1 edit | Total | 170,911 | 85,940 | **50 %** |

Session B consumed just **488 tokens** instead of 85,459. Those 488 tokens are 9 tiny stash labels plus one compact diff — replacing the entire file payload the agent would otherwise have re-read. Over both passes together, the agent used half the tokens it would have needed without agent-file-stash.

**How savings scale with file count** (1 edit, both passes combined):

| Files read | Tokens (raw) | Tokens (agent-file-stash) | Savings |
|:----------:|-------------:|-------------------:|--------:|
| 3 | 13,867 | 7,322 | 47 % |
| 5 | 29,807 | 15,318 | 49 % |
| 10 | 170,911 | 85,940 | 50 % |
| 20 | 309,413 | 155,325 | 50 % |

Savings stay near 50% regardless of how many files the agent reads. The benefit scales linearly — more files means more absolute tokens saved, at the same rate.

**How savings change with edit frequency** (10 files, both passes combined):

| Files edited | Tokens (raw) | Tokens (agent-file-stash) | Savings |
|:------------:|-------------:|-------------------:|--------:|
| 0 of 10 | 170,904 | 85,587 | 50 % |
| 1 of 10 | 170,911 | 85,940 | 50 % |
| 3 of 10 | 170,964 | 88,207 | 48 % |
| 5 of 10 | 171,034 | 90,979 | 47 % |

Even when half the files are edited, savings stay above 47%. Diffs are much smaller than full files — a 5% edit on a 200-line file produces a diff of roughly 10 lines, far cheaper than re-reading the entire file.

#### Latency

agent-file-stash adds a small SQLite lookup to each file read. Here is the honest cost:

| Scenario | Pass | Raw read | Filestash read | Overhead |
|----------|------|:--------:|:--------------:|:--------:|
| 10 files, 1 edit | A | 348 µs | 2.60 ms | +649 % |
| 10 files, 1 edit | B | 311 µs | 2.21 ms | +611 % |
| 20 files, 1 edit | B | 573 µs | 4.31 ms | +652 % |

The percentage overhead looks large, but the absolute cost is about **2 ms per 10-file read pass**. LLM inference takes seconds; file I/O is never the bottleneck. In practice this overhead is invisible to the user.

### Single-file read latency

How fast individual reads are across different file sizes (averaged over 100 iterations):

| File size | First read | Stashed read | Diff read | Token savings (stashed) |
|-----------|:----------:|:------------:|:---------:|:-----------------------:|
| small (50 lines) | 146 µs | 122 µs | 296 µs | ~99 % |
| medium (200 lines) | 186 µs | 148 µs | 798 µs | ~100 % |
| large (1,000 lines) | 382 µs | 306 µs | 19.96 ms | ~100 % |

_Node.js built-in `node:sqlite`, WAL mode, warm OS page cache. Run `pnpm benchmark` to reproduce._

### Agents adopt it without being told

We tested whether agents would use agent-file-stash voluntarily. We launched a coding agent with agent-file-stash configured as an MCP server but **gave the agent no instructions about it**. The agent chose `agent-file-stash.read_file` over the built-in Read tool on its own. The tool descriptions alone were enough.

## How it works

```
First read:   agent reads src/auth.ts → agent-file-stash caches content + hash → returns full file
Second read:  agent reads src/auth.ts → hash unchanged → returns "[unchanged, 245 lines, 1,837 tokens saved]"
After edit:   agent reads src/auth.ts → hash changed → returns unified diff (only changed lines)
Partial read: agent reads lines 50-60 → edit changed line 200 → returns "[unchanged in lines 50-60]"
```

The stash persists in a local SQLite database (Node.js built-in `node:sqlite`, WAL mode). Content hashing (SHA-256) detects changes. No network, no external services, no configuration beyond a file path.

## Installation

```bash
npx agent-file-stash init     # auto-configures Claude Code, Cursor, OpenCode
```

That's it. Restart your editor and agent-file-stash is active. Agents discover it automatically.

Or configure manually — add to your MCP config (`.claude.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "agent-file-stash": {
      "command": "npx",
      "args": ["agent-file-stash", "serve"]
    }
  }
}
```

## Usage

### As an MCP server (recommended)

The MCP server exposes 4 tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file with caching. Returns full content on first read, "unchanged" or diff on subsequent reads. Supports `offset`/`limit` for partial reads. |
| `read_files` | Batch read multiple files with caching. |
| `cache_status` | Show stats: files tracked, tokens saved. |
| `cache_clear` | Reset the cache. |

Agents discover these tools automatically and prefer them over built-in file reads because the tool descriptions advertise token savings.

### As a CLI

```bash
agent-file-stash serve      # Start the MCP server
agent-file-stash status     # Show cache statistics
agent-file-stash help       # Show help
```

Set `FILESTASH_DIR` to control where the stash database is stored (default: `.file-stash/` in the current directory).

### As an SDK

```typescript
import { createCache } from "agent-file-stash";

const { cache, watcher } = createCache({
  dbPath: "./my-cache.db",
  sessionId: "my-session-1",  // each session tracks reads independently
  watchPaths: ["."],          // optional: watch for file changes
});

await cache.init();

// First read — returns full content, caches it
const r1 = await cache.readFile("src/auth.ts");
// r1.cached === false
// r1.content === "import { jwt } from ..."

// Second read — file unchanged, returns confirmation
const r2 = await cache.readFile("src/auth.ts");
// r2.cached === true
// r2.content === "[filestash: unchanged, 245 lines, 1837 tokens saved]"
// r2.linesChanged === 0

// After file is modified — returns diff
const r3 = await cache.readFile("src/auth.ts");
// r3.cached === true
// r3.diff === "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,3 +10,4 @@..."
// r3.linesChanged === 3

// Partial read — only the lines you need
const r4 = await cache.readFile("src/auth.ts", { offset: 50, limit: 10 });
// Returns lines 50-59, or "[unchanged in lines 50-59]" if nothing changed there

// Stats
const stats = await cache.getStats();
// { filesTracked: 12, tokensSaved: 53851, sessionTokensSaved: 33205 }

// Cleanup
watcher.close();
```

## Architecture

```
packages/
  sdk/     agent-file-stash — the core library
           - CacheStore: content-addressed file cache backed by an embedded database
           - FileWatcher: fs.watch wrapper for change notification
           - computeDiff: line-based unified diff
  cli/     agent-file-stash — batteries-included CLI + MCP server
```

**Database:** Single SQLite file (Node.js built-in `node:sqlite`, WAL mode) with `file_versions` (content-addressed, keyed by path + hash), `session_reads` (per-session read pointers), and `stats`/`session_stats` tables. Multiple sessions and branch switches are handled correctly — each session tracks which version it last saw.

**Change detection:** On every read, agent-file-stash hashes the current file content and compares it to the cached hash. Same hash = unchanged. Different hash = compute diff, update cache. No polling, no watchers required for correctness — the hash is the source of truth.

**Token estimation:** `ceil(characters / 4)`. Rough but directionally correct for code (~1 token per 4 characters). Good enough for the "tokens saved" metric.

## License

MIT
