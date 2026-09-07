// Virtual HTTP range server. Responses come from the host peer, never Vercel/storage.
// Keep only a rolling, in-memory cache of useful original-file byte blocks.
const BLOCK_SIZE = 256 * 1024;
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const PLAYHEAD_WINDOW_SECONDS = 60;
const files = new Map();
const playheads = new Map();
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "relay-client")
    event.ports[0]?.postMessage({ clientId: event.source.id });
  if (event.data?.type === "relay-playhead" && event.source?.id) {
    const { token, currentTime, duration } = event.data;
    if (
      typeof token === "string" &&
      Number.isFinite(currentTime) &&
      Number.isFinite(duration) &&
      duration > 0
    ) {
      const key = `${event.source.id}/${token}`;
      const playhead = { currentTime, duration, touched: Date.now() };
      playheads.set(key, playhead);
      const file = files.get(key);
      if (file) file.playhead = playhead;
    }
  }
});

function rpc(port, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.onmessage = null;
      reject(new Error("File transfer timed out"));
    }, 35000);
    port.onmessage = (event) => {
      clearTimeout(timer);
      event.data.error
        ? reject(new Error(event.data.error))
        : resolve(event.data);
    };
    port.postMessage(message);
  });
}

// Single byte ranges, including suffix requests used for MP4 metadata at EOF.
function rangeFor(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  )
    return null;
  return { start, end, partial: true };
}

function cacheKey(clientId, token) {
  return `${clientId}/${token}`;
}

function cacheFor(key, info) {
  let file = files.get(key);
  if (!file || file.info.size !== info.size || file.info.mime !== info.mime) {
    file = {
      info,
      blocks: new Map(),
      bytes: 0,
      playhead: playheads.get(key),
      lastUsed: Date.now(),
    };
    files.set(key, file);
  }
  file.lastUsed = Date.now();
  return file;
}

function isPinned(start, file) {
  return start < 1024 * 1024 || start >= file.info.size - 1024 * 1024;
}

function distanceFromPlayhead(start, file) {
  const playhead = file.playhead;
  if (!playhead) return 0;
  const seconds = (start / file.info.size) * playhead.duration;
  return Math.max(0, Math.abs(seconds - playhead.currentTime) - PLAYHEAD_WINDOW_SECONDS);
}

function totalCacheBytes() {
  let total = 0;
  files.forEach((file) => { total += file.bytes; });
  return total;
}

function trim() {
  let total = totalCacheBytes();
  if (total <= MAX_CACHE_BYTES) return;
  const candidates = [];
  files.forEach((file) => {
    file.blocks.forEach((block, start) => {
      if (!isPinned(start, file)) candidates.push({ file, start, block });
    });
  });
  candidates.sort((a, b) => {
    const distance = distanceFromPlayhead(b.start, b.file) - distanceFromPlayhead(a.start, a.file);
    return distance || a.block.used - b.block.used;
  });
  for (const { file, start, block } of candidates) {
    if (total <= MAX_CACHE_BYTES) break;
    file.blocks.delete(start);
    file.bytes -= block.data.byteLength;
    total -= block.data.byteLength;
  }
}

async function blockFor(port, file, start) {
  const cached = file.blocks.get(start);
  if (cached) {
    cached.used = Date.now();
    return cached.data;
  }
  const { buffer } = await rpc(port, {
    type: "read",
    offset: start,
    length: Math.min(BLOCK_SIZE, file.info.size - start),
  });
  if (!(buffer instanceof ArrayBuffer)) throw new Error("Invalid original-file block");
  const data = new Uint8Array(buffer);
  file.blocks.set(start, { data, used: Date.now() });
  file.bytes += data.byteLength;
  trim();
  return data;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith("/__relay_media/")
  )
    return;
  event.respondWith(
    (async () => {
      const [, , clientId, token] = url.pathname.split("/");
      const client = await self.clients.get(clientId);
      if (!client || !token)
        return new Response("Viewer tab closed", { status: 410 });
      const channel = new MessageChannel();
      const port = channel.port1;
      let cancelled = false;
      const close = () => {
        if (!cancelled) {
          cancelled = true;
          port.postMessage({ type: "cancel" });
          port.close();
        }
      };
      try {
        const metadata = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Viewer did not respond")),
            10000,
          );
          port.onmessage = (event) => {
            clearTimeout(timer);
            event.data.error
              ? reject(new Error(event.data.error))
              : resolve(event.data);
          };
        });
        client.postMessage({ type: "relay-open", token }, [channel.port2]);
        const info = await metadata;
        const file = cacheFor(cacheKey(clientId, token), info);
        const range = rangeFor(event.request.headers.get("range"), info.size);
        if (!range) {
          close();
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${info.size}` },
          });
        }
        const headers = {
          "Content-Type": info.mime,
          "Accept-Ranges": "bytes",
          "Content-Length": String(range.end - range.start + 1),
          "Cache-Control": "no-store",
        };
        if (range.partial)
          headers["Content-Range"] =
            `bytes ${range.start}-${range.end}/${info.size}`;
        if (event.request.method === "HEAD") {
          close();
          return new Response(null, {
            status: range.partial ? 206 : 200,
            headers,
          });
        }
        let offset = range.start;
        const body = new ReadableStream(
          {
            async pull(controller) {
              try {
                const blockStart = Math.floor(offset / BLOCK_SIZE) * BLOCK_SIZE;
                const block = await blockFor(port, file, blockStart);
                if (cancelled) return;
                const startInBlock = offset - blockStart;
                const length = Math.min(block.byteLength - startInBlock, range.end - offset + 1);
                if (length <= 0) throw new Error("Incomplete original-file block");
                controller.enqueue(block.slice(startInBlock, startInBlock + length));
                offset += length;
                if (offset > range.end) {
                  controller.close();
                  close();
                }
              } catch (error) {
                if (!cancelled) controller.error(error);
                close();
              }
            },
            cancel: close,
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          status: range.partial ? 206 : 200,
          headers,
        });
      } catch {
        close();
        return new Response("Host file unavailable", { status: 503 });
      }
    })(),
  );
});
