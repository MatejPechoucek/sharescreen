// Original bytes only: no captureStream, media encoder, or whole-file allocation.
export const READ_SIZE = 256 * 1024;
const PACKET_SIZE = 16 * 1024 - 8;
export type FileInfo = { id: string; name: string; size: number; mime: string };
export const fileInfo = (file: File): FileInfo => ({
  id: crypto.randomUUID(),
  name: file.name,
  size: file.size,
  mime:
    file.type ||
    (/\.webm$/i.test(file.name)
      ? "video/webm"
      : /\.(mp4|m4v|mov)$/i.test(file.name)
        ? "video/mp4"
        : "application/octet-stream"),
});

export function validRead(offset: number, length: number, size: number) {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length > 0 &&
    length <= READ_SIZE &&
    offset + length <= size
  );
}

async function drain(channel: RTCDataChannel) {
  if (channel.readyState !== "open")
    throw new Error("The host connection closed.");
  if (channel.bufferedAmount <= READ_SIZE) return;
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer);
      channel.removeEventListener("bufferedamountlow", low);
      channel.removeEventListener("close", closed);
      error ? reject(error) : resolve();
    };
    const low = () => done();
    const closed = () => done(new Error("The host connection closed."));
    const timer = setTimeout(
      () => done(new Error("File transfer timed out.")),
      30000,
    );
    channel.addEventListener("bufferedamountlow", low);
    channel.addEventListener("close", closed);
  });
}

export function serveFile(
  channel: RTCDataChannel,
  source: () => { file: File; info: FileInfo } | null,
) {
  channel.bufferedAmountLowThreshold = READ_SIZE / 2;
  const jobs = new Map<number, AbortController>();
  let queue = Promise.resolve();
  const announce = () => {
    const current = source();
    if (current && channel.readyState === "open")
      channel.send(JSON.stringify({ type: "file", info: current.info }));
  };
  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string" || event.data.length > 4096) return;
    let request: {
      type: string;
      id: number;
      fileId: string;
      offset: number;
      length: number;
    };
    try {
      request = JSON.parse(event.data);
    } catch {
      return;
    }
    if (request.type === "cancel") {
      jobs.get(request.id)?.abort();
      return;
    }
    if (request.type !== "read") return;
    const current = source();
    const fail = (error: string) => {
      if (channel.readyState === "open")
        channel.send(JSON.stringify({ type: "error", id: request.id, error }));
    };
    if (
      !current ||
      current.info.id !== request.fileId ||
      !validRead(request.offset, request.length, current.file.size) ||
      !Number.isInteger(request.id) ||
      request.id < 1 ||
      request.id > 0xffffffff ||
      jobs.size >= 8 ||
      jobs.has(request.id)
    ) {
      fail("This file request is no longer available.");
      return;
    }
    const abort = new AbortController();
    jobs.set(request.id, abort);
    queue = queue
      .then(async () => {
        for (
          let position = 0;
          position < request.length;
          position += PACKET_SIZE
        ) {
          if (abort.signal.aborted || source()?.info.id !== current.info.id)
            return;
          await drain(channel);
          const end = Math.min(request.length, position + PACKET_SIZE);
          const data = await current.file
            .slice(request.offset + position, request.offset + end)
            .arrayBuffer();
          if (abort.signal.aborted) return;
          const packet = new Uint8Array(8 + data.byteLength);
          const header = new DataView(packet.buffer);
          header.setUint32(0, request.id);
          header.setUint32(4, position);
          packet.set(new Uint8Array(data), 8);
          channel.send(packet);
        }
      })
      .catch((error) => fail(String(error)))
      .finally(() => jobs.delete(request.id));
  };
  channel.addEventListener("open", announce);
  channel.addEventListener("message", onMessage);
  const close = () => {
    jobs.forEach((job) => job.abort());
    channel.removeEventListener("open", announce);
    channel.removeEventListener("message", onMessage);
  };
  channel.addEventListener("close", close, { once: true });
  announce();
  return { announce, close };
}

export class RemoteFile {
  private serial = 0;
  private pending = new Map<
    number,
    {
      data: Uint8Array<ArrayBuffer>;
      received: number;
      done: (error?: Error) => void;
    }
  >();
  private info: FileInfo | null = null;
  bytesReceived = 0;
  constructor(
    private channel: RTCDataChannel,
    onFile: (info: FileInfo) => void,
    private onProgress: (bytes: number) => void,
  ) {
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (
          message.type === "file" &&
          typeof message.info?.id === "string" &&
          typeof message.info.name === "string" &&
          Number.isSafeInteger(message.info.size) &&
          message.info.size > 0 &&
          typeof message.info.mime === "string"
        ) {
          if (this.info?.id === message.info.id) return;
          this.cancelAll("The host selected another file.");
          this.info = message.info;
          this.bytesReceived = 0;
          onFile(message.info);
        } else if (message.type === "error")
          this.pending.get(message.id)?.done(new Error(message.error));
        return;
      }
      const packet = event.data as ArrayBuffer;
      if (packet.byteLength < 8) return;
      const view = new DataView(packet);
      const job = this.pending.get(view.getUint32(0));
      if (!job) return;
      const offset = view.getUint32(4);
      const length = packet.byteLength - 8;
      if (offset !== job.received || offset + length > job.data.byteLength) {
        job.done(new Error("Invalid file chunk."));
        return;
      }
      job.data.set(new Uint8Array(packet, 8), offset);
      job.received += length;
      this.bytesReceived += length;
      this.onProgress(this.bytesReceived);
      if (job.received === job.data.byteLength) job.done();
    };
    channel.addEventListener("close", () =>
      this.cancelAll("Host disconnected. Reconnecting…"),
    );
  }
  read(
    info: FileInfo,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (
      signal?.aborted ||
      this.channel.readyState !== "open" ||
      this.info?.id !== info.id
    )
      return Promise.reject(new Error("The file connection is unavailable."));
    if (!validRead(offset, length, info.size) || this.pending.size >= 8)
      return Promise.reject(new Error("Invalid or excessive file request."));
    const id = (this.serial = (this.serial % 0xffffffff) + 1);
    return new Promise((resolve, reject) => {
      const data = new Uint8Array(length);
      const done = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        if (error) {
          if (this.channel.readyState === "open")
            this.channel.send(JSON.stringify({ type: "cancel", id }));
          reject(error);
        } else resolve(data.buffer);
      };
      const abort = () => done(new Error("File request cancelled."));
      const timer = setTimeout(
        () =>
          done(
            new Error("The host is not sending data. Check the connection."),
          ),
        30000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { data, received: 0, done });
      try {
        this.channel.send(
          JSON.stringify({ type: "read", id, fileId: info.id, offset, length }),
        );
      } catch (error) {
        done(error as Error);
      }
    });
  }
  cancelAll(reason = "File transfer closed.") {
    this.pending.forEach((job) => job.done(new Error(reason)));
  }
}
