import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import type { PlaybackState, RoomEvent } from "./types";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key) : null;

export function isNewer(
  incoming: PlaybackState,
  current: PlaybackState | null,
) {
  return (
    !current ||
    incoming.revision > current.revision ||
    (incoming.revision === current.revision &&
      incoming.updatedAt > current.updatedAt)
  );
}

export function correctedTime(state: PlaybackState, now = Date.now()) {
  return state.paused
    ? state.currentTime
    : state.currentTime +
        (Math.max(0, now - state.updatedAt) / 1000) * state.playbackRate;
}

export function createPlaybackState(
  video: HTMLVideoElement,
  revision: number,
): PlaybackState {
  return {
    paused: video.paused,
    currentTime: video.currentTime,
    playbackRate: video.playbackRate,
    updatedAt: Date.now(),
    revision,
  };
}

type Handler = (event: RoomEvent) => void;
export class RoomBus {
  private channel: RealtimeChannel | null = null;
  private fallback: BroadcastChannel | null = null;
  private closed = false;
  constructor(
    private roomId: string,
    private handler: Handler,
  ) {}
  async connect() {
    if (supabase) {
      this.channel = supabase
        .channel(`room:${this.roomId}`)
        .on("broadcast", { event: "room-event" }, ({ payload }) =>
          this.handler(payload as RoomEvent),
        );
      await new Promise<void>((resolve, reject) => {
        this.channel!.subscribe((status, error) => {
          if (status === "SUBSCRIBED") resolve();
          else if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          )
            reject(error || new Error("Room connection interrupted."));
        });
      });
    } else if ("BroadcastChannel" in window) {
      this.fallback = new BroadcastChannel(`room:${this.roomId}`);
      this.fallback.onmessage = (event) =>
        this.handler(event.data as RoomEvent);
    }
  }
  async send(event: RoomEvent) {
    if (this.closed) return;
    if (this.channel)
      await this.channel.send({
        type: "broadcast",
        event: "room-event",
        payload: event,
      });
    else this.fallback?.postMessage(event);
  }
  async close() {
    this.closed = true;
    if (this.channel && supabase) await supabase.removeChannel(this.channel);
    this.fallback?.close();
  }
}
