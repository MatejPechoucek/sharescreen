import { RemoteFile, type FileInfo } from "./file-transfer";

export async function originalFileSource(remote: RemoteFile, info: FileInfo) {
  if (!("serviceWorker" in navigator))
    throw new Error(
      "This browser cannot stream original files. Use a recent Chrome, Edge, Firefox, or Safari browser.",
    );
  await navigator.serviceWorker.register("/media-sw.js", { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller)
    await new Promise<void>((resolve, reject) => {
      const changed = () => {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          changed,
        );
        resolve();
      };
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          changed,
        );
        reject(new Error("Reload the viewer to enable file playback."));
      }, 10000);
      navigator.serviceWorker.addEventListener("controllerchange", changed, {
        once: true,
      });
    });
  const token = crypto.randomUUID();
  const connections = new Map<MessagePort, AbortController>();
  const onMessage = (event: MessageEvent) => {
    if (
      event.data?.type !== "relay-open" ||
      event.data.token !== token ||
      !event.ports[0]
    )
      return;
    const port = event.ports[0];
    const abort = new AbortController();
    connections.set(port, abort);
    port.onmessage = async (event) => {
      if (event.data?.type === "cancel") {
        abort.abort();
        port.close();
        connections.delete(port);
        return;
      }
      if (event.data?.type !== "read") return;
      try {
        const buffer = await remote.read(
          info,
          event.data.offset,
          event.data.length,
          abort.signal,
        );
        if (!abort.signal.aborted) port.postMessage({ buffer }, [buffer]);
      } catch (error) {
        if (!abort.signal.aborted) port.postMessage({ error: String(error) });
      }
    };
    port.postMessage(info);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  try {
    const clientId = await new Promise<string>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error("File player did not initialize."));
      }, 10000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(event.data.clientId);
      };
      registration.active!.postMessage({ type: "relay-client" }, [
        channel.port2,
      ]);
    });
    return {
      url: `/__relay_media/${clientId}/${token}`,
      close() {
        navigator.serviceWorker.removeEventListener("message", onMessage);
        connections.forEach((abort, port) => {
          abort.abort();
          port.close();
        });
        connections.clear();
      },
    };
  } catch (error) {
    navigator.serviceWorker.removeEventListener("message", onMessage);
    throw error;
  }
}
