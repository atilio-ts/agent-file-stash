# Contributing

## Getting started

1. Clone the repo and install dependencies:

```bash
git clone https://github.com/atilio-ts/agent-file-stash.git
cd agent-file-stash
pnpm install
```

2. Build the project:

```bash
pnpm build
```

3. Run the tests to confirm everything works:

```bash
pnpm test
```

## Project structure

The project uses a pnpm workspace with two packages:

- `packages/sdk` — the core library (`StashStore`, `FileWatcher`, `computeDiff`). No external dependencies.
- `packages/cli` — the CLI binary and MCP server built on top of the SDK.

Changes to the SDK are picked up automatically by the CLI via the workspace link.

## Running the benchmark

```bash
pnpm benchmark
```

This runs a reproducible simulation of the two-pass read workflow described in the README. Results are averaged over 5 runs per scenario.

## Changing the schema

The database schema is versioned with `PRAGMA user_version`; migrations live in `packages/sdk/src/migrations.ts`.

1. Append a migration with the next version number to `MIGRATIONS`. It runs inside a transaction that also bumps `user_version`; prefer additive changes (`CREATE ... IF NOT EXISTS`, `ADD COLUMN`) and never edit a shipped migration.
2. `SCHEMA_VERSION` follows the last entry; keep the fresh-database schema equal to the upgraded one.
3. Add a fixture of the previous schema and a test to `test/schema-versioning.test.ts` that upgrades it and checks the data survives.

## Releasing

Only the root package `agent-file-stash` is published; `packages/sdk` and `packages/cli` are private workspace packages bundled into it, and their versions are not bumped.

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under the new version.
2. Bump the version in `package.json` (`version`) and in `server.json` (the top-level `version` and `packages[0].version`).
3. Commit with the message `build: bump to X.Y.Z` and push to `main`.
4. Wait for the CI workflow (`.github/workflows/ci.yml`) to pass on `main`. It runs on Ubuntu: it installs with `--frozen-lockfile`, builds, runs the tests and runs `node dist/cli.mjs help`. The watcher test depends on inotify behavior, so also run the suite on Linux before releasing:

   ```bash
   docker run --rm -v "$PWD":/src:ro node:24 sh -c 'git clone -q /src /app && cd /app && corepack enable && pnpm install --frozen-lockfile && pnpm test'
   ```

5. Create a GitHub release for the tag `vX.Y.Z` targeting that commit. Publishing the release triggers `.github/workflows/publish.yml`, which installs, builds, tests and runs `npm publish --provenance --access public` using npm OIDC trusted publishing (no npm token).
6. Verify the published version:

   ```bash
   npm view agent-file-stash version
   ```

Never run `npm publish` by hand: the release is published by the workflow, and a manual publish leaves the GitHub release and tag out of sync with npm.

## Submitting changes

- Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.
- Add or update tests for any changed behaviour.
- Run `pnpm test` before opening a pull request.