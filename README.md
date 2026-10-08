<p align="center">
  <img src="logo.svg" alt="agent-file-stash" width="200" />
</p>

# Agent-File-Stash

Agents waste most of their token budget re-reading files they've already seen. agent-file-stash fixes this: on first read it stashes the file, on subsequent reads it returns either "unchanged" (one line instead of the whole file) or a compact diff of what changed.

agent-file-stash is based on [cachebro](https://github.com/glommer/cachebro), an earlier tool with the same goal. cachebro required [Turso](https://turso.tech) as an external database dependency and lacked per-line-range stashing, meaning partial reads always returned the full file. agent-file-stash replaces Turso with `node:sqlite` — a built-in available since Node.js 24 — eliminating all external runtime dependencies. It also records which line ranges were delivered to the model, so a re-read of lines 50–60 returns `[unchanged]` only if those lines were already delivered, even when line 200 was edited. Additional improvements include a `readFileFull` method to force a full re-read and reset session tracking, proactive cache eviction when files are deleted via an optional file watcher, and a more accurate token estimate (`ceil(chars / 4)` vs the original `chars * 0.75`).

```
First read:   agent reads src/auth.ts → stashes content + hash → returns full file
Second read:  agent reads src/auth.ts → hash unchanged → returns "[filestash: unchanged, 245 lines, 1837 tokens saved]"
After edit:   agent reads src/auth.ts → hash changed → returns unified diff (only changed lines)
Partial read: agent reads lines 50-60 → edit changed line 200 → returns "[filestash: unchanged in lines 50-60, changes elsewhere in file, N tokens saved]"
```

The stash persists in a local SQLite database (Node.js built-in `node:sqlite`, WAL mode). Content hashing (SHA-256) detects changes. No network, no external services, no configuration beyond a file path.

## Highlights

- **Up to ~50% fewer tokens** on repeated reads in the two-pass simulation, 24–26% on a real codebase (see [Benchmark](#benchmark)). Savings only apply to re-reads, see [When it saves tokens](#when-it-saves-tokens-and-when-it-does-not)
- **Zero config** — one command auto-configures Claude Code, Cursor, and OpenCode
- **No external services** — SQLite backed by Node.js 24 built-ins, no network required
- **Partial-read aware** — tracks which line ranges were delivered to the model; returns an "unchanged in lines 50-59" label only for lines it already delivered, when only other parts of the file changed
- **Agents adopt it on their own** — tool descriptions alone are enough; no explicit instructions needed
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
| `read_file` | Read a file with stashing. Returns full content on first read, an "unchanged" label or diff on subsequent reads. Parameters: `path` (required), `offset` (1-based start line), `limit` (max lines), `force` (bypass the stash and return full content). |
| `read_files` | Batch read multiple files at once with stashing. Parameter: `paths` (array of file paths). |
| `stash_status` | Show files tracked and this session's accounting: reads, tokens a plain read would have sent, tokens actually sent, gross saved, tool-definition overhead (est.) and net saved (est.), plus lifetime gross saved. |
| `stash_clear` | Clear all stashed content, read tracking and stats. |

Paths must be inside the server's working directory (symlinks are resolved before the check); anything outside is rejected with an error.

### As a CLI

#### `init`

```bash
npx agent-file-stash init
```

Detects installed editors and writes the MCP server entry into each config file it finds:

| Editor | Config file |
|--------|-------------|
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` |

`init` registers the server under the key `filestash` (inside `mcpServers`, or `mcp` for OpenCode). Only editors whose config directory exists are touched. If the `filestash` key already exists in a config, that entry is left unchanged and reported as "already configured". After running, restart your editor to pick up the new server.

```
  Claude Code: configured (/Users/you/.claude.json)
  OpenCode: already configured

Done! Restart your editor to pick up agent-file-stash.
```

When no supported editor is detected, `init` prints the manual MCP snippet instead.

`init --hooks` also merges the context-reset hook (see [Context resets](#context-resets)) into `~/.claude/settings.json`. It is idempotent, keeps all existing settings, and saves the previous file as `settings.json.bak`. Without the flag, `init` only prints the snippet.

#### `serve`

```bash
npx agent-file-stash serve
# or just: npx agent-file-stash
```

Starts the MCP server over stdio. This is the command editors invoke automatically — you don't normally run it yourself. The server registers four tools (`read_file`, `read_files`, `stash_status`, `stash_clear`) and keeps the stash database open for the lifetime of the process. Each server process is one [session](#how-sessions-work), and it watches its working directory to evict deleted files from the stash.

The stash database is created at `$FILESTASH_DIR/stash.db` (defaults to `.file-stash/stash.db` relative to the working directory the editor uses when launching the server).

#### `status`

```bash
npx agent-file-stash status
```

Prints files tracked and the lifetime tokens saved from the local stash database (`$FILESTASH_DIR/stash.db`, default `.file-stash/stash.db`). Exits with a message if no database exists yet. Per-session figures are only available from the `stash_status` tool.

```
filestash status:
  Files tracked:          12
  Tokens saved (total):   ~53,851
```

When each project keeps its own stash (for example with `FILESTASH_DIR=.vscode/file-stash`), sum all of them with `--all`. It scans the given directory (default: home) for `.file-stash/` and `file-stash/` folders containing a `stash.db` (up to 8 levels deep, skipping `node_modules`, `.git`, `build`, `dist`, `target`, `bin` and `obj`):

```bash
npx agent-file-stash status --all ~/Projects
```

```
filestash status (3 databases under /Users/me/Projects):
  ~   252,340 tokens    112 files  /Users/me/Projects/api
  ~    45,157 tokens    128 files  /Users/me/Projects/web
  ~     7,043 tokens     18 files  /Users/me/Projects/legacy
  ~   304,540 tokens    258 files  TOTAL
```

Savings come from re-reads within a session (unchanged files and diffs). A new session always receives full content, since the file is not in its context yet.

#### `reset`

```bash
npx agent-file-stash reset
```

Forgets what each session has read, so the next read of every file returns the full content. Stats and stashed versions are kept. It resolves `FILESTASH_DIR` like the server does and exits 0 if no database exists. Meant to be run by a Claude Code hook (see [Context resets](#context-resets)); `--from-hook` reads the hook JSON from stdin, resolves a relative `FILESTASH_DIR` against its `cwd`, and stays silent.

#### `doctor`

```bash
npx agent-file-stash doctor
npx agent-file-stash doctor --json
npx agent-file-stash doctor --check-updates
```

Read-only diagnostics that tell you whether the install works and what to fix. It checks the Node version, the stash directory and database (schema version, integrity, permissions, leftover recovery files), the MCP registration in Claude Code, Cursor and OpenCode, the context-reset hook, and the `FILESTASH_*` limits. It never creates, changes or deletes any file or setting (when a running server holds the database, SQLite may refresh the timestamp of its shared-memory index file `stash.db-shm`, as any reader does) and makes no network call unless you pass `--check-updates`, which compares the installed version with `npm view`. Each line is `[ok]`, `[warn]`, `[error]` or `[info]`, followed by a fix hint for warnings and errors; `--json` prints the same results as a JSON array and nothing else. The exit code is 1 when any check reports an error and 0 otherwise.

#### `help`

```bash
npx agent-file-stash help
```

Prints a short usage summary with all available commands.

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `FILESTASH_DIR` | `.file-stash/` | Directory where the stash database is stored |
| `FILESTASH_EXCLUDE` | (none) | Comma-separated basename globs (`*`, `?`) that are never stored, added to the defaults |
| `FILESTASH_MAX_LINES` | `2000` | Maximum lines returned by one read; longer reads are truncated |
| `FILESTASH_MAX_CHARS` | `100000` | Maximum characters returned by one read; longer reads are truncated |

### Privacy

Files that commonly hold secrets are read normally but never written to the stash database. The agent still gets the full content on every read; nothing is persisted, and no tokens are counted as saved for them.

Excluded by default (case-insensitive): `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `.npmrc`, `.netrc`, `credentials*`, `secrets.*`, and anything inside a `.ssh`, `.aws` or `.gnupg` directory. Templates such as `.env.example`, `.env.sample`, `.env.template`, `.env.dist` and public keys (`*.pub`) are still stashed.

Add your own patterns with `FILESTASH_EXCLUDE=*.secret,vault.json` (SDK users: the `exclude` option). On startup, rows for paths that match the denylist are deleted from databases created by older versions. The stash directory is created with mode `0700` and the database files are restricted to `0600`.

Add the stash folder (`.file-stash/` by default) to your `.gitignore`.

### Read limits

A single read never returns more than `FILESTASH_MAX_LINES` lines (default 2000) or `FILESTASH_MAX_CHARS` characters (default 100000), whichever is hit first, so one huge file cannot flood the context. The cap applies to every read: normal, `force`, partial `offset`/`limit` (a larger `limit` is capped too), excluded files, degraded mode and each file of `read_files`. Values must be positive integers; anything else is ignored with one line on stderr and the default is used. SDK users: the `maxLines` and `maxChars` options.

A truncated read ends with `[filestash: truncated, showing lines A-B of N; continue with offset=B+1]`. The cut is made at a line boundary; a single line longer than the character cap is cut at the cap and the notice names the next line to continue from (the rest of that line is not reachable). Only the delivered lines `A-B` count as delivered, so the continuation read returns real content, and repeating the same capped read can be answered `unchanged`. Token accounting uses the capped text (notice included) as the plain-read baseline, so truncation never shows up as savings.

- **Binary files:** if the first 8192 characters contain a NUL byte the file is treated as binary and the read returns `[filestash: binary file (<bytes> bytes), not shown]`. Nothing is stored. The check only looks at the start of the file: a text-looking file with a NUL after 8 KB is not detected and is read as text.
- **Large files:** files over 1,000,000 bytes (SDK option `maxStoreBytes`) are served capped like any other read but never stored, so they produce no savings. Files over 64 MiB are not read at all and return `[filestash: file too large (<bytes> bytes); not read]`.

### Context resets

The server answers a repeat read of an unchanged file with a short "unchanged" note, assuming the model still has the content. After `/clear` or `/compact` it does not, and the server has no way to notice. Run `reset` on those events with a Claude Code `SessionStart` hook (`npx agent-file-stash init --hooks` adds it, or paste it into `~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "clear|compact",
        "hooks": [{ "type": "command", "command": "npx agent-file-stash reset --from-hook" }]
      }
    ]
  }
}
```

Limitation: subagents that use the MCP server by name share the parent's server process, so they share its read tracking. A subagent can be told "unchanged" for a file only the parent has seen; have it pass `force=true` on its first read of each file.

### How sessions work

A session is one MCP server process: each `serve` start generates a random session id and registers it with its process id in the `sessions` table. Read tracking is per session. A file is "unchanged" or a diff only relative to what that session last returned for it, so two editors (or two projects sharing one stash database) never see each other's reads.

When a server starts, it prunes closed sessions: any other session whose process is no longer alive is deleted, together with its read pointers and per-session counters, and stashed file versions that no remaining session points at are removed. The lifetime counter (`Tokens saved (total)`, "Gross saved (all sessions)") is kept in a separate table and survives pruning. A server also removes its own `sessions` row on a clean shutdown. `reset` and `stash_clear` act on all sessions.

### When it saves tokens and when it does not

- Savings only come from re-reads of a file that is still in the model's context. The first read of any file in a session costs the same as a plain read, and a new session always starts with full content.
- Tiny files, and small partial ranges, are returned as plain content when the "unchanged" label would not be shorter.
- When a diff is not smaller than the file (for example after a big rewrite), the full content is returned instead of the diff.
- A partial read whose range was edited returns that range as plain content, not a diff.
- "Unchanged", a diff and "changes elsewhere" are only answered for lines the model was already given in this session. A range that was never delivered (or only partly delivered) is returned as real content and added to what is recorded as delivered; adjacent and overlapping ranges merge, so reading 1-100 and then 101-200 makes a later read of 1-200 unchanged. If a file changed after only part of it was delivered, the requested lines are returned as plain content instead of a diff.
- Excluded secret files (see [Privacy](#privacy)) are read normally and never stored, so they never produce savings.
- The net figure subtracts an estimate of what the four tool definitions cost per session, so a session with few re-reads can show a negative net. All token counts use `ceil(characters / 4)` and are estimates.

### Known limitations

- Clients do not send a per-conversation id, so the server cannot tell that you ran `/clear` or `/compact`. Without the [reset hook](#context-resets) it can answer "unchanged" for content the model no longer has; `force=true` always returns full content.
- Subagents that use the MCP server by name share the parent's server process and therefore its read tracking.
- The secret denylist matches on file names only: symlinks are not resolved, so a link with an innocent name pointing at a secret file is stashed, and secrets in files with ordinary names are not detected.
- Extra patterns in `FILESTASH_EXCLUDE` match basenames only, not directories or full paths.
- Node.js 24 or later is required (`node:sqlite`).
- The server only reads files inside its working directory.

### Degraded mode

The stash never prevents a file from being read. If the database or the stash directory cannot be used, the server keeps running and reads files normally.

- A database that is corrupt (not a database, malformed) is treated as a disposable cache: it is renamed to `stash.db.corrupt-<unix-ms>` next to the original (with any `-wal`/`-shm` files given the same suffix), a fresh database is created, and one line is written to stderr. `stash_status` shows `Recovered: corrupt database moved to <path>`. The renamed file can be deleted. Recovery is attempted once per process and is serialised across processes with a `stash.db.recover.lock` file next to the database, so servers starting together on the same corrupt file recover it once.
- If the stash directory cannot be created or written, or the database cannot be opened or locked, or any database call fails during a session, the stash switches to degraded mode for the rest of the process: reads return the plain file content, nothing is stashed, and one line is written to stderr with the reason. `stash_status` starts with `Mode: DEGRADED (<reason>) - files are read normally, nothing is stashed`, its metadata carries `degraded` and `degradedReason`, and `stash_clear` reports that there is nothing to clear.
- A database created by a newer release (its `user_version` is higher than this release knows) is not treated as corrupt and is left untouched: the stash degrades with `database schema version N is newer than this release supports (M); upgrade agent-file-stash`.
- Errors about the file being read (missing, unreadable, a directory) are still reported as errors.
- If file watching cannot start (for example the OS watcher limit is reached) or fails later, one line is written to stderr and the server continues without it.
- `status` and `reset` print a one-line error and exit 1 on an unreadable database (`reset --from-hook` exits 0); `status --all` skips it and continues.

### As an SDK

The SDK lives in `packages/sdk` (workspace package `filestash-sdk`). It is bundled into the CLI and is not published to npm separately: `npm install agent-file-stash` installs the CLI/MCP server only and does not expose a library entry point. To embed it today, depend on the workspace package from a clone of this repository. The example below uses that package name.

```typescript
import { createStash } from "filestash-sdk";

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
// Returns lines 50-59, or an "unchanged in lines 50-59" label if nothing changed there

// Force a full re-read (bypasses stash, resets session tracking for this file)
const r5 = await stash.readFileFull("src/auth.ts");
// r5.stashed === false — always returns full content

// Stats
const stats = await stash.getStats();
// { filesTracked: 12, tokensSaved: 53851, sessionTokensSaved: 33205,
//   sessionReads: 80, sessionBaselineTokens: 61000, sessionSentTokens: 27795 }

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
| `stash.getStats()` | Return `{ filesTracked, tokensSaved, sessionTokensSaved, sessionReads, sessionBaselineTokens, sessionSentTokens, degraded, degradedReason?, recoveredFrom? }` |
| `stash.clear()` | Wipe all stashed content, read tracking and stats |
| `stash.resetReads()` | Forget read tracking for all sessions; next reads return full content |
| `stash.onFileDeleted(path)` | Drop stashed versions and read pointers for a path (called by `FileWatcher`) |
| `stash.isDegraded` / `stash.degradedReason` | Whether the stash is unavailable (see [Degraded mode](#degraded-mode)) and why |
| `stash.close()` | Remove this session's registration and close the database connection |

**Public API for 1.0.** Stable: `createStash(config)`, the `StashStore` methods in the table above, `FileWatcher` (`watch(paths)`, `close()`), `isExcludedPath(absPath, extraPatterns?)` and the types `StashConfig`, `StashStats` and `FileReadResult`. Internal, not covered by compatibility guarantees: the database schema and file layout, the exact text of the "unchanged" labels, `computeDiff` (exported from the SDK index but used internally by `StashStore`), the `FileWatcher` debounce constructor argument, and everything not exported from `packages/sdk/src/index.ts`.

### Reading the numbers

`stash_status` (and the `[filestash: net ~N tokens this session (est.)]` footer appended to `read_file` results served from the stash, and to `read_files` results once the session has saved anything) reports net savings: gross saved (what a plain read of the same content would have returned minus what the stash actually returned) minus an estimate of the tokens the four tool definitions cost every session. Net can be negative, and it is shown as such. Savings only appear when files are re-read within a session; a session that reads each file once pays the tool-definition overhead and saves nothing. All figures use the same `ceil(characters / 4)` estimate and are approximate.

```
filestash status:
  Files tracked: 12
  This session: 80 reads
    Would have sent (plain reads): ~61,000 tokens
    Actually sent: ~27,795 tokens
    Gross saved: ~33,205 tokens
    Tool definitions overhead: ~277 tokens (est.)
    Net saved: ~32,928 tokens (est.)
  Gross saved (all sessions): ~53,851 tokens
```

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
│   ├── index.ts      Exports: createStash, StashStore, FileWatcher, computeDiff, isExcludedPath, types
│   ├── migrations.ts SCHEMA_VERSION and the ordered, transactional schema migrations
│   ├── stash.ts      StashStore — SQLite-backed content-addressed stash with per-session read tracking and pruning
│   ├── differ.ts     computeDiff — line-based LCS diff (unified format, LCS capped at 5 000 lines)
│   ├── exclude.ts    isExcludedPath — secret-file denylist and FILESTASH_EXCLUDE patterns
│   ├── watcher.ts    FileWatcher — debounced fs.watch wrapper that evicts deleted files from the stash
│   └── types.ts      StashConfig, FileReadResult, StashStats type definitions
│
└── cli/src/
    ├── index.ts      CLI entry point — init, serve, status, reset, help commands
    ├── mcp.ts        MCP server — registers read_file, read_files, stash_status, stash_clear tools
    └── scan.ts       findStashDatabases — locates stash databases for status --all

test/
├── smoke.test.ts         End-to-end flows: first read, stash hit, diff on change, partial reads, multi-session isolation
├── differ.test.ts        Unit tests for computeDiff: add/remove/mixed edits, context lines, LCS size limit
├── stash-errors.test.ts  Error paths: missing file, clear(), onFileDeleted(), post-close re-init
├── watcher.test.ts       FileWatcher: deletion detection, debounce coalescence, close() cancellation
├── mcp-tools.test.ts     Unit tests for isPathAllowed (path traversal guard) and formatReadResult
├── mcp-meta.test.ts      Validates the _meta field format and reverse-DNS namespace convention
├── diff-guard.test.ts    Full content is returned when a diff is not smaller than the file
├── prune.test.ts         Pruning of closed sessions and their data
├── scan.test.ts          findStashDatabases (status --all)
├── secret-denylist.test.ts  Secret files and FILESTASH_EXCLUDE patterns are never stored
├── session-reset.test.ts resetReads, the reset command, init --hooks, MCP integration
├── savings-regression.test.ts  Session accounting identity, savings workload, tool definition overhead
├── e2e.test.ts           End-to-end suite with real servers: concurrent servers, crash safety, secrets, path restriction, shutdown
├── docs.test.ts          README mentions every CLI command, FILESTASH_* variable and MCP tool
└── benchmark.ts          Reproducible two-pass simulation across generated TypeScript files (pnpm benchmark)
```

The SDK has no external dependencies — it uses only Node.js built-ins (`node:sqlite`, `node:crypto`, `node:fs`). The CLI adds the MCP layer via `@modelcontextprotocol/sdk` and `zod` for schema validation.

## Architecture

**Database:** Single SQLite file (`node:sqlite`, WAL mode) with six tables:

| Table | Purpose |
|---|---|
| `file_versions` | Content-addressed storage, keyed by `(path, hash)` |
| `session_reads` | Per-session read pointers — tracks which version each session last saw |
| `session_ranges` | Per-session, per-path line intervals already delivered for the current hash (merged) |
| `sessions` | One row per live server process: session id and pid, used to prune closed sessions |
| `stats` | Lifetime token-savings counter (survives pruning) |
| `session_stats` | Per-session counters: reads, baseline tokens, sent tokens, tokens saved |

`file_versions` is content-addressed: each row is a unique `(path, hash)` pair storing the full file content, its line count and a creation timestamp. When a file is read, its current content is hashed. If a matching row exists, no new version is written. If the hash is new, a new row is inserted. Diffs are not stored: on a changed re-read the diff is computed between the version the session last saw and the current content.

`session_reads` is a lightweight pointer table. Each row is a `(sessionId, path, hash)` triple recording which version of a file a given session last saw. On re-read, the engine joins `session_reads` against `file_versions` to decide what to return: same hash → "unchanged" label; different hash → computed diff; no prior entry → full content. `session_ranges` holds the merged `(start_line, end_line)` intervals the session was given for the hash in `session_reads`. A re-read is answered with the "unchanged" label only when the requested lines fall inside those intervals; otherwise the real lines are returned and the interval is added. A diff or "changes elsewhere" label additionally requires that the whole previous version was delivered. Databases created before this table existed have no range rows, so the first read after upgrading returns real content. This means two agents running in parallel, or an agent reading across a branch switch, each get correct diffs scoped to their own session.

WAL mode is enabled with a 5-second busy timeout so several servers can share one database and readers do not block the writer.

**Schema versioning:** the schema version is stored in SQLite's `PRAGMA user_version` (currently 1; a database with version 0 is a legacy one created before versioning and is completed with any missing table or index). On open, each pending migration runs in its own `BEGIN IMMEDIATE` transaction that also bumps `user_version`, and servers opening the same database at once re-read the version inside the transaction, so each migration is applied once. Migrations are forward-only and additive when possible; there is no downgrade. A database whose version is newer than the release supports is never modified: the server enters [degraded mode](#degraded-mode) with `database schema version N is newer than this release supports (M); upgrade agent-file-stash`.

**Pruning:** on startup each server deletes sessions whose pid is no longer alive, their read pointers, delivered ranges and counters, and any `file_versions` row no remaining session points at. Rows for paths matching the secret denylist are removed at the same time. See [How sessions work](#how-sessions-work).

**Change detection:** On every read, the current file content is hashed (SHA-256, truncated to 16 hex chars). Same hash = unchanged. Different hash = compute diff, update stash. No polling or watchers required for correctness — the hash is the source of truth. File watchers are optional and only used to proactively evict deleted files.

**Diff algorithm:** Line-based unified diff (`computeDiff`). Groups changed lines into hunks with context lines, in unified format with 3 lines of context. The diff is returned verbatim to the agent, unless it is not smaller than the file, in which case the full content is returned.

**Token estimation:** `ceil(characters / 4)`. Rough but directionally correct for code. Used for the token metrics and to decide whether a label or diff is actually shorter than the plain content; it never changes what the file contains.

## Uninstall

**1. Remove from editor configs**

Remove the `agent-file-stash` entry from each config file where `init` added it:

| Editor | Config file |
|--------|-------------|
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` |

Delete the `"filestash"` key (the one `init` adds; also `"agent-file-stash"` if you configured it by hand) from the `mcpServers` object in each file (the `mcp` object for OpenCode), then restart your editor.

**2. Remove the Claude Code hook**

If you ran `init --hooks` (or pasted the snippet from [Context resets](#context-resets)), remove the `SessionStart` entry whose command is `npx agent-file-stash reset --from-hook` from `~/.claude/settings.json`. `init --hooks` also left a backup of the previous file at `~/.claude/settings.json.bak`, which you can delete.

**3. Remove the stash database**

```bash
rm -rf .file-stash/
```

This deletes the SQLite database and all cached content. If you set a custom `FILESTASH_DIR`, remove that directory instead.

**4. Remove the package** _(if installed globally)_

```bash
npm uninstall -g agent-file-stash
```

If you only used it via `npx`, no package removal is needed — npx caches are managed by npm automatically.
