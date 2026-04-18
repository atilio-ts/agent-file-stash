import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { FileWatcher } from "filestash-sdk";
import type { StashStore } from "filestash-sdk";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dirname, ".tmp_test_watcher");

function makeMockStash(): StashStore {
  return {
    onFileDeleted: vi.fn().mockResolvedValue(undefined),
  } as unknown as StashStore;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("FileWatcher", () => {
  test("onFileDeleted called when a file is deleted", async () => {
    const filePath = join(TEST_DIR, "a.ts");
    writeFileSync(filePath, "const a = 1;\n");

    const stash = makeMockStash();
    const watcher = new FileWatcher(stash, 20);
    watcher.watch([TEST_DIR]);

    rmSync(filePath);
    await sleep(120); // debounce(20) + buffer

    expect(stash.onFileDeleted).toHaveBeenCalledWith(filePath);
    watcher.close();
  });

  test("debounce fires once per burst of events for the same path", async () => {
    const filePath = join(TEST_DIR, "b.ts");
    writeFileSync(filePath, "const b = 1;\n");

    const stash = makeMockStash();
    const watcher = new FileWatcher(stash, 80);
    watcher.watch([TEST_DIR]);

    // Rapid create/delete cycles on same path generate multiple fs events
    // all within the debounce window — should collapse to one handleChange call
    rmSync(filePath);
    writeFileSync(filePath, "const b = 2;\n");
    rmSync(filePath);
    writeFileSync(filePath, "const b = 3;\n");
    rmSync(filePath);

    await sleep(250); // debounce(80) + generous buffer

    expect(stash.onFileDeleted).toHaveBeenCalledTimes(1);
    expect(stash.onFileDeleted).toHaveBeenCalledWith(filePath);
    watcher.close();
  });

  test("close() cancels pending debounce timers", async () => {
    const filePath = join(TEST_DIR, "c.ts");
    writeFileSync(filePath, "const c = 1;\n");

    const stash = makeMockStash();
    const watcher = new FileWatcher(stash, 500); // long debounce
    watcher.watch([TEST_DIR]);

    rmSync(filePath);
    await sleep(60); // let fs.watch fire and register the debounce timer
    watcher.close(); // cancel the timer before it fires

    await sleep(600); // wait longer than debounce — nothing should fire
    expect(stash.onFileDeleted).not.toHaveBeenCalled();
  });
});