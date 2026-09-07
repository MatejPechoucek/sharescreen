import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  fileInfo,
  RemoteFile,
  serveFile,
  READ_SIZE,
  validRead,
} from "./file-transfer";

class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "arraybuffer";
  onmessage?: (event: MessageEvent) => void;
  other!: Channel;
  send(data: string | Uint8Array) {
    const copied = typeof data === "string" ? data : data.slice().buffer;
    queueMicrotask(() => {
      const event = new MessageEvent("message", { data: copied });
      this.other.dispatchEvent(event);
      this.other.onmessage?.(event);
    });
  }
}

describe("original file transport", () => {
  it("returns identical bytes across packet boundaries and out-of-order range requests", async () => {
    const host = new Channel();
    const viewer = new Channel();
    host.other = viewer;
    viewer.other = host;
    const bytes = new Uint8Array(READ_SIZE * 3 + 9).map(
      (_, index) => (index * 31) % 251,
    );
    const file = new File([bytes], "test.mp4", { type: "video/mp4" });
    const info = fileInfo(file);
    let remote!: RemoteFile;
    const ready = new Promise<void>((resolve) => {
      remote = new RemoteFile(
        viewer as unknown as RTCDataChannel,
        () => resolve(),
        () => {},
      );
    });
    const server = serveFile(host as unknown as RTCDataChannel, () => ({
      file,
      info,
    }));
    await ready;
    const [tail, beginning, middle] = await Promise.all([
      remote.read(info, bytes.length - 9, 9),
      remote.read(info, 0, READ_SIZE),
      remote.read(info, READ_SIZE + 7, READ_SIZE),
    ]);
    expect(new Uint8Array(beginning)).toEqual(bytes.slice(0, READ_SIZE));
    expect(new Uint8Array(middle)).toEqual(
      bytes.slice(READ_SIZE + 7, READ_SIZE * 2 + 7),
    );
    expect(new Uint8Array(tail)).toEqual(bytes.slice(-9));
    server.close();
    remote.cancelAll();
  });
  it("bounds allocations but permits offsets beyond 4 GB", () => {
    expect(validRead(8 * 1024 ** 3, READ_SIZE, 10 * 1024 ** 3)).toBe(true);
    for (const [offset, length] of [
      [-1, 1],
      [0, READ_SIZE + 1],
      [1.5, 1],
      [100, 0],
      [99, 2],
    ])
      expect(validRead(offset, length, 100)).toBe(false);
  });
});

describe("virtual media HTTP ranges", () => {
  const context = { self: { addEventListener() {} } } as Record<string, any>;
  runInNewContext(
    readFileSync(new URL("../public/media-sw.js", import.meta.url), "utf8"),
    context,
  );
  const range = context.rangeFor as (
    header: string | null,
    size: number,
  ) => unknown;
  it("handles prefix, open-ended and suffix metadata reads", () => {
    expect(range("bytes=0-1", 100)).toEqual({
      start: 0,
      end: 1,
      partial: true,
    });
    expect(range("bytes=80-", 100)).toEqual({
      start: 80,
      end: 99,
      partial: true,
    });
    expect(range("bytes=-8", 100)).toEqual({
      start: 92,
      end: 99,
      partial: true,
    });
    expect(range(null, 100)).toEqual({ start: 0, end: 99, partial: false });
    expect(range("bytes=9000000000-", 10000000000)).toEqual({
      start: 9000000000,
      end: 9999999999,
      partial: true,
    });
  });
  it("rejects unsatisfiable and malformed ranges", () => {
    for (const header of [
      "bytes=100-",
      "bytes=9-2",
      "bytes=-0",
      "bytes=-",
      "bytes=0-2,4-6",
      "junk",
    ])
      expect(range(header, 100)).toBe(null);
  });
});
