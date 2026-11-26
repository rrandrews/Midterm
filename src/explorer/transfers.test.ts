import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginTransfer,
  cleanupPaneTransfers,
  clearFinishedTransfers,
  dismissTransfer,
  explorerTransfers,
  formatBytes,
  formatEta,
  formatRate,
  resetTransfersForTest,
  transferFraction,
} from "./transfers";

afterEach(() => {
  resetTransfersForTest();
  vi.useRealTimers();
});

describe("explorer transfer store", () => {
  it("formats byte sizes, rates, and ETAs cleanly", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
    expect(formatRate(2.5 * 1024 * 1024)).toBe("2.5 MB/s");
    expect(formatEta(500, 1000)).toBe("<1s");
    expect(formatEta(25_000, 1000)).toBe("25s");
    expect(formatEta(135_000, 1000)).toBe("2m 15s");
    expect(formatEta(3_660_000, 1000)).toBe("1h 1m");
    expect(formatEta(0, 1000)).toBeNull();
  });

  it("tracks single-item copy progress, completion, and auto-dismiss", () => {
    vi.useFakeTimers();
    const handle = beginTransfer({
      paneId: "exp-1",
      mode: "copy",
      sources: ["/tmp/archive.zip"],
      destDir: "/tmp/out",
    });

    expect(explorerTransfers()).toHaveLength(1);
    expect(explorerTransfers()[0].visible).toBe(true);
    expect(explorerTransfers()[0].label).toBe("archive.zip");

    handle.onItemProgress({
      bytesTransferred: 500,
      totalBytes: 1000,
      filesCompleted: 0,
      totalFiles: 1,
      currentFile: "archive.zip",
    });
    expect(transferFraction(explorerTransfers()[0])).toBeCloseTo(0.5);

    handle.finishItem();
    handle.finish({ status: "done" });
    expect(explorerTransfers()[0].status).toBe("done");
    expect(transferFraction(explorerTransfers()[0])).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(explorerTransfers()).toHaveLength(0);
  });

  it("aggregates multi-item progress smoothly and supports cancellation", () => {
    const handle = beginTransfer({
      paneId: "exp-1",
      mode: "copy",
      sources: ["/tmp/a.bin", "/tmp/b.bin"],
      destDir: "/tmp/out",
    });

    handle.startItem("/tmp/a.bin");
    handle.onItemProgress({
      bytesTransferred: 500,
      totalBytes: 1000,
      filesCompleted: 0,
      totalFiles: 1,
      currentFile: "a.bin",
    });
    expect(transferFraction(explorerTransfers()[0])).toBeCloseTo(0.25);

    handle.finishItem();
    handle.startItem("/tmp/b.bin");
    handle.onItemProgress({
      bytesTransferred: 500,
      totalBytes: 1000,
      filesCompleted: 0,
      totalFiles: 1,
      currentFile: "b.bin",
    });
    expect(transferFraction(explorerTransfers()[0])).toBeCloseTo(0.75);

    explorerTransfers()[0].cancel();
    expect(handle.signal.aborted).toBe(true);
    handle.finish({ status: "cancelled" });
    expect(explorerTransfers()[0].status).toBe("cancelled");

    dismissTransfer(handle.id);
    expect(explorerTransfers()).toHaveLength(0);
  });

  it("suppresses instant single-item same-host moves unless they take time or fail", () => {
    vi.useFakeTimers();
    const fast = beginTransfer({
      paneId: "exp-1",
      mode: "move",
      sources: ["/tmp/a.txt"],
      destDir: "/tmp/sub",
    });
    expect(explorerTransfers()[0].visible).toBe(false);
    fast.finish({ status: "done" });
    expect(explorerTransfers()).toHaveLength(0);

    const slow = beginTransfer({
      paneId: "exp-1",
      mode: "move",
      sources: ["/tmp/big.bin"],
      destDir: "/tmp/sub",
    });
    vi.advanceTimersByTime(150);
    expect(explorerTransfers()[0].visible).toBe(true);
    slow.finish({ status: "error", error: "Permission denied" });
    expect(explorerTransfers()[0].status).toBe("error");
    clearFinishedTransfers("exp-1");
    expect(explorerTransfers()).toHaveLength(0);
  });

  it("classifies cross-host SSH uploads and downloads", () => {
    const upload = beginTransfer({
      paneId: "exp-1",
      mode: "copy",
      sources: ["/Users/dev/file.txt"],
      destDir: "ssh://prod-0123456789ab/home/demo",
    });
    expect(explorerTransfers()[0].kind).toBe("upload");
    expect(explorerTransfers()[0].visible).toBe(true);
    upload.finish({ status: "done" });

    const download = beginTransfer({
      paneId: "exp-2",
      mode: "copy",
      sources: ["ssh://prod-0123456789ab/home/demo/file.txt"],
      destDir: "/Users/dev",
    });
    const entry = explorerTransfers().find((t) => t.id === download.id)!;
    expect(entry.kind).toBe("download");
    expect(entry.visible).toBe(true);
    download.finish({ status: "done" });
  });

  it("uses file counts for zero-byte trees and drops detached records after pane disposal", () => {
    const emptyTree = beginTransfer({
      paneId: "exp-3",
      mode: "copy",
      sources: ["/tmp/empty-files"],
      destDir: "/tmp/out",
    });
    emptyTree.onItemProgress({
      bytesTransferred: 0,
      totalBytes: 0,
      filesCompleted: 2,
      totalFiles: 8,
      currentFile: "f2",
    });
    expect(transferFraction(explorerTransfers()[0])).toBeCloseTo(0.25);

    cleanupPaneTransfers("exp-3");
    emptyTree.finish({ status: "error", error: "failed after close" });
    expect(explorerTransfers()).toHaveLength(0);
  });
});
