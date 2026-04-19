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

## Submitting changes

- Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.
- Add or update tests for any changed behaviour.
- Run `pnpm test` before opening a pull request.