<p align="center">
  <img src="logo.svg" alt="agent-file-stash" width="200" />
</p>

# agent-file-stash

> File stash with diff tracking for AI coding agents. Drop-in replacement for file reads that cuts token usage in half.

[![npm version](https://img.shields.io/npm/v/agent-file-stash)](https://www.npmjs.com/package/agent-file-stash)
[![Node.js >=24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## Highlights

- **50% fewer tokens** on repeated file reads — verified on real codebases
- **Zero config** — one command auto-configures Claude Code, Cursor, and OpenCode
- **No external services** — SQLite backed by Node.js 24 built-ins, no network required
- **Partial-read aware** — stashes line ranges independently; returns `[unchanged in lines 50-59]` when only other parts changed
- **Agents adopt it on their own** — tool descriptions alone are enough; no explicit instructions needed

## Table of Contents

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
  - [As an MCP server](#as-an-mcp-server-recommended)
  - [As a CLI](#as-a-cli)
  - [As an SDK](#as-an-sdk)
- [Benchmark](#benchmark)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [FAQ](#faq)
- [License](#license)

## How it works

Agents waste most of their token budget re-reading files they've already seen. agent-file-stash fixes this: on first read it stashes the file, on subsequent reads it returns either "unchanged" (one line instead of the whole file) or a compact diff of what changed.

```
First read:   agent reads src/auth.ts → stashes content + hash → returns full file
Second read:  agent reads src/auth.ts → hash unchanged → returns "[unchanged, 245 lines, 1,837 tokens saved]"
After edit:   agent reads src/auth.ts → hash changed → returns unified diff (only changed lines)
Partial read: agent reads lines 50-60 → edit changed line 200 → returns "[unchanged in lines 50-60]"
```

The stash persists in a local SQLite database (Node.js built-in `node:sqlite`, WAL mode). Content hashing (SHA-256) detects changes. No network, no external services, no configuration beyond a file path.

## Prerequisites

- **Node.js 24 or later** — agent-file-stash uses `node:sqlite`, a built-in module available from Node.js 24

## Installation

```bash
npx agent-file-stash init
```

This auto-configures agent-file-stash for any editors it detects (Claude Code, Cursor, OpenCode). Restart your editor and agents will start using it automatically.

**Manual configuration** — add to your MCP config (`.claude.json`, `.cursor/mcp.json`, etc.):

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

The MCP server exposes 4 tools that agents discover and use automatically:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file with stashing. Returns full content on first read, `[unchanged]` label or diff on subsequent reads. Supports `offset`/`limit` for partial reads. |
| `read_files` | Batch read multiple files at once with stashing. |
| `stash_status` | Show stats: files tracked, tokens saved (total and per session). |
| `stash_clear` | Reset the stash (clears all cached content and stats). |

### As a CLI

```bash
agent-file-stash init       # Auto-configure for Claude Code, Cursor, OpenCode
agent-file-stash serve      # Start the MCP server (default when no command given)
agent-file-stash status     # Show stash statistics
agent-file-stash help       # Show help
```

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `FILESTASH_DIR` | `.file-stash/` | Directory where the stash database is stored |

### As an SDK

Install and import directly if you want to embed stashing in your own tooling:

```bash
npm install agent-file-stash
```

```typescript
import { createStash } from "agent-file-stash";

const { stash, watcher } = createStash({
  dbPath: "./my-stash.db",
  sessionId: "my-session-1",  // each session tracks reads independently
  watchPaths: ["."],          // optional: watch for file changes
});

await stash.init();

// First read — returns full content, stashes it
const r1 = await stash.readFile("src/auth.ts");
// r1.stashed === false
// r1.content === "import { jwt } from ..."

// Second read — file unchanged
const r2 = await stash.readFile("src/auth.ts");
// r2.stashed === true
// r2.content === "[filestash: unchanged, 245 lines, 1837 tokens saved]"
// r2.linesChanged === 0

// After file is modified — returns unified diff
const r3 = await stash.readFile("src/auth.ts");
// r3.stashed === true
// r3.diff === "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,3 +10,4 @@..."
// r3.linesChanged === 3

// Partial read — only the lines you need
const r4 = await stash.readFile("src/auth.ts", { offset: 50, limit: 10 });
// Returns lines 50-59, or "[unchanged in lines 50-59]" if nothing changed there

// Force a full re-read (bypasses stash, resets session tracking for this file)
const r5 = await stash.readFileFull("src/auth.ts");
// r5.stashed === false — always returns full content

// Stats
const stats = await stash.getStats();
// { filesTracked: 12, tokensSaved: 53851, sessionTokensSaved: 33205 }

// Cleanup
watcher.close();
await stash.close();
```

**SDK reference:**

| Method | Description |
|---|---|
| `stash.init()` | Initialize the database (called automatically on first read) |
| `stash.readFile(path, opts?)` | Read with stashing. Options: `{ offset?: number; limit?: number }` |
| `stash.readFileFull(path)` | Always return full content and reset session tracking for this file |
| `stash.getStats()` | Return `{ filesTracked, tokensSaved, sessionTokensSaved }` |
| `stash.clear()` | Wipe all stashed content and stats |
| `stash.close()` | Close the database connection |

## Benchmark

Tested on a real 268-file TypeScript codebase ([opencode](https://github.com/sst/opencode)) — same agent, same prompt, only the stash toggled:

| | Without | With |
|---|---:|---:|
| Total tokens | 158,248 | 117,188 |
| Tool calls | 60 | 58 |

**26% fewer tokens on a single task.** Savings compound across consecutive tasks as more files are already stashed:

| Task | Tokens saved | Cumulative |
|------|-------------:|-----------:|
| 1. Add session export command | 2,925 | 2,925 |
| 2. Add --since flag to session list | 15,571 | 18,496 |
| 3. Add session stats subcommand | 35,355 | 53,851 |

**53,851 tokens saved over 3 tasks (24% less).** By task 3 alone: 36% reduction.

### Simulation results

A controlled two-pass workflow (read → edit → re-read) across 10 TypeScript files, averaged over 5 runs:

| Pass | Tokens (raw) | Tokens (stashed) | Savings |
|------|-------------:|-----------------:|--------:|
| A — first read | 85,452 | 85,452 | 0 % |
| B — re-read after 1 edit | 85,459 | 488 | **99 %** |
| Total | 170,911 | 85,940 | **50 %** |

On re-read, 9 unchanged files each return a single stash label and the edited file returns only a diff — **488 tokens instead of 85,459**.

Savings hold across file count and edit frequency: ~50% at 3, 5, 10, or 20 files; above 47% even when half the files are edited. The SQLite overhead is ~2 ms per 10-file pass — invisible next to LLM latency.

_Run `pnpm benchmark` to reproduce._

## Project Structure

```
packages/
├── sdk/src/
│   ├── index.ts      Public exports: createStash, StashStore, FileWatcher, computeDiff, types
│   ├── stash.ts      StashStore — SQLite-backed content-addressed stash with per-session read tracking
│   ├── differ.ts     computeDiff — line-based LCS diff (unified format, LCS capped at 5 000 lines)
│   ├── watcher.ts    FileWatcher — debounced fs.watch wrapper that evicts deleted files from the stash
│   └── types.ts      StashConfig, FileReadResult, StashStats type definitions
│
└── cli/src/
    ├── index.ts      CLI entry point — init, serve, status, help commands
    └── mcp.ts        MCP server — registers read_file, read_files, stash_status, stash_clear tools

test/
├── smoke.test.ts         End-to-end flows: first read, stash hit, diff on change, partial reads, multi-session isolation
├── differ.test.ts        Unit tests for computeDiff: add/remove/mixed edits, context lines, LCS size limit
├── stash-errors.test.ts  Error paths: missing file, clear(), onFileDeleted(), post-close re-init
├── watcher.test.ts       FileWatcher: deletion detection, debounce coalescence, close() cancellation
├── mcp-tools.test.ts     Unit tests for isPathAllowed (path traversal guard) and formatReadResult
├── mcp-meta.test.ts      Validates the _meta field format and reverse-DNS namespace convention
└── benchmark.ts          Reproducible two-pass simulation across generated TypeScript files (pnpm benchmark)
```

The SDK has no external dependencies — it uses only Node.js built-ins (`node:sqlite`, `node:crypto`, `node:fs`). The CLI adds the MCP layer via `@modelcontextprotocol/sdk` and `zod` for schema validation.

## Architecture

**Database:** Single SQLite file (`node:sqlite`, WAL mode) with four tables:

| Table | Purpose |
|---|---|
| `file_versions` | Content-addressed storage, keyed by `(path, hash)` |
| `session_reads` | Per-session read pointers — tracks which version each session last saw |
| `stats` | Global token-savings counter |
| `session_stats` | Per-session token-savings counter |

Multiple sessions and branch switches are handled correctly — each session independently tracks which file version it last read, so switching branches or running multiple agents in parallel produces correct diffs for each.

**Change detection:** On every read, the current file content is hashed (SHA-256, truncated to 16 hex chars). Same hash = unchanged. Different hash = compute diff, update stash. No polling or watchers required for correctness — the hash is the source of truth. File watchers are optional and only used to proactively evict deleted files.

**Diff algorithm:** Line-based unified diff (`computeDiff`). Groups changed lines into hunks with context lines, identical to the output of `git diff`. Diffs are stored as strings and returned verbatim to the agent.

**Token estimation:** `ceil(characters / 4)`. Rough but directionally correct for code. Used only for the "tokens saved" metric — never affects correctness.

## FAQ

**Does it work with agents other than Claude?**
Yes. agent-file-stash is an MCP server — any MCP-compatible agent (Cursor, OpenCode, etc.) can use it.

**Where is the stash database stored?**
By default in `.file-stash/stash.db` inside the current working directory. Set `FILESTASH_DIR` to change this.

**Is the stash shared across sessions?**
File content is shared (content-addressed, so identical files are stored once). Read state is tracked per `sessionId` — each session independently knows which file version it last saw, so two agents running in parallel get correct diffs independently.

**What happens when I switch git branches?**
agent-file-stash detects the new file content via hashing and returns a diff automatically on the next read. No manual reset needed.

**Does clearing the stash affect my source files?**
No. `stash_clear` (or `stash.clear()`) only removes the stash database contents. Your source files are never modified.

**What Node.js version do I need?**
Node.js 24 or later. The `node:sqlite` module was stabilized in Node.js 24.

## License

[MIT](./LICENSE)