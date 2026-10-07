# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are taken from git history. Versions 0.3.0 and 0.4.0 have no git tag; their date is the date of the `build: bump to X.Y.Z` commit.

## [Unreleased]

### Added

- `reset` command that forgets what each session has read, so the next read of every file returns full content. `--from-hook` is a quiet mode for Claude Code hooks.
- `init --hooks` merges the context-reset hook into `~/.claude/settings.json`; without the flag `init` prints the snippet.
- Diff-size guard: when a diff is not smaller than the file, the full file is returned instead of the diff.
- Secret denylist: files that commonly hold secrets are never written to the stash, plus the `FILESTASH_EXCLUDE` variable and the SDK `exclude` option for extra patterns.
- Net token savings: `stash_status` and the read footer report tool-definition overhead and net saved tokens alongside gross savings.
- End-to-end test suite that runs real servers.
- Fail-open stash: a corrupt database is moved aside to `stash.db.corrupt-<unix-ms>` and replaced, and when the stash cannot be used at all the server enters degraded mode and reads files normally. `StashStats` gains `degraded`, `degradedReason` and `recoveredFrom`; `StashConfig` gains `recoverCorrupt` and `quiet`.

### Fixed

- `unchanged` was returned for line ranges that had not been delivered to the model (for example a read of lines 200-204 after only lines 1-5 were read, or a whole-file read after a partial one). The stash now records the line ranges delivered per session and file version, answers `unchanged`, a diff or "changes elsewhere" only for lines already delivered, and returns real content otherwise. New `session_ranges` table; existing databases upgrade in place.
- The server no longer exits when the database is corrupt, the stash directory cannot be created, or `fs.watch` fails; `status`, `status --all` and `reset` report an unreadable database in one line instead of a stack trace.
- Several servers starting at once on a corrupt database no longer degrade each other: recovery is serialised with a `stash.db.recover.lock` file (a stale lock older than 15 s is ignored), a database that another process already recovered is reused instead of moved again, transient lock errors while opening are retried, and `busy_timeout` is now set before switching to WAL.
- Flaky watcher test: the test now waits until the watcher is live, and settles its probe on Linux.

## [0.4.0] - 2026-10-06

### Added

- Data of closed sessions is pruned from the stash database when another server starts.

## [0.3.0] - 2026-10-06

### Added

- `status --all` command that sums the statistics of every stash database found under a directory.

### Changed

- Normalized the repository URL in package metadata.

## [0.2.5] - 2026-04-19

### Added

- Uninstall section in the README.

### Changed

- CI workflows bumped to actions v5/v6 (Node 20 deprecation).

## [0.2.4] - 2026-04-19

### Changed

- README restructured and expanded.
- Publishing switched to npm OIDC trusted publishing; the npm token was removed.

### Fixed

- Suppressed the `node:sqlite` experimental warning.
- Fixed references in `init`.

## [0.2.3] - 2026-04-19

### Changed

- Added the `packageManager` field to `package.json`.
- CI pins pnpm to 10.29.3.

## [0.2.2] - 2026-04-19

### Added

- Vitest suite and benchmark script.
- CONTRIBUTING guide.
- Spec-compliant `_meta` field on MCP tool results.
- Strict TypeScript index checks and optional-property checks enabled.

### Changed

- Storage migrated from Turso to the built-in `node:sqlite`.
- Package, code and docs renamed from cachebro to filestash, and then to agent-file-stash; "cache" renamed to "stash" throughout the codebase.
- README overhauled.
- CI workflows and repository URLs updated.

### Fixed

- Corrected the `package.json` path lookup used by the MCP server.
