import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { StashStore } from "filestash-sdk";

const fsMock = vi.hoisted(() => ({ watch: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), watch: fsMock.watch }));

const { FileWatcher } = await import("filestash-sdk");

const stash = { onFileDeleted: vi.fn() } as unknown as StashStore;
let stderr: { mockRestore(): void; mock: { calls: unknown[][] } };

beforeEach(() => {
  fsMock.watch.mockReset();
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
});

function logged(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join("");
}

describe("FileWatcher fails open", () => {
  test("fs.watch throwing while starting is logged and does not propagate", () => {
    fsMock.watch.mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: System limit for number of file watchers reached"), { code: "ENOSPC" });
    });
    const watcher = new FileWatcher(stash);

    expect(() => watcher.watch(["/a", "/b"])).not.toThrow();
    expect(logged().match(/file watching disabled/g)).toHaveLength(2);
    expect(logged()).toContain("ENOSPC");
    expect(() => watcher.close()).not.toThrow();
  });

  test("one failing path does not stop the others from being watched", () => {
    const good = Object.assign(new EventEmitter(), { close: vi.fn() });
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("EMFILE");
    });
    fsMock.watch.mockImplementationOnce(() => good);
    const watcher = new FileWatcher(stash);

    watcher.watch(["/bad", "/good"]);
    watcher.close();
    expect(good.close).toHaveBeenCalledTimes(1);
  });

  test("an error event is logged, closes that watcher and never throws", () => {
    const emitter = Object.assign(new EventEmitter(), { close: vi.fn() });
    fsMock.watch.mockImplementation(() => emitter);
    const watcher = new FileWatcher(stash);
    watcher.watch(["/a"]);

    expect(() => emitter.emit("error", new Error("EMFILE: too many open files"))).not.toThrow();
    expect(logged()).toContain("file watching stopped");
    expect(emitter.close).toHaveBeenCalledTimes(1);
    watcher.close();
    expect(emitter.close).toHaveBeenCalledTimes(1);
  });
});
