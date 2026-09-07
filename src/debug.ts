import type { PlaybackState } from "./types";

type DebugFields = Record<string, boolean | number | string | undefined>;

// This intentionally reports only control-plane diagnostics. Original video
// bytes remain exclusively on the WebRTC data channel and are never logged.
export function debugEvent(
  event: string,
  roomId: string,
  fields: DebugFields = {},
) {
  if (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  )
    return;
  const payload = JSON.stringify({
    event,
    roomId,
    at: Date.now(),
    ...fields,
  });
  void fetch("/api/debug", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Diagnostics must never interfere with playback or peer connectivity.
  });
}

export function playbackFields(state: PlaybackState): DebugFields {
  return {
    paused: state.paused,
    currentTime: Number(state.currentTime.toFixed(3)),
    playbackRate: state.playbackRate,
    revision: state.revision,
  };
}
