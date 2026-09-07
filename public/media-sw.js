// Virtual HTTP range server. Responses come from the host peer, never Vercel/storage.
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "relay-client")
    event.ports[0]?.postMessage({ clientId: event.source.id });
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
                const length = Math.min(256 * 1024, range.end - offset + 1);
                const { buffer } = await rpc(port, {
                  type: "read",
                  offset,
                  length,
                });
                if (cancelled) return;
                if (
                  !(buffer instanceof ArrayBuffer) ||
                  buffer.byteLength !== length
                )
                  throw new Error("Incomplete file chunk");
                controller.enqueue(new Uint8Array(buffer));
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
