export type RoomMode = 'url' | 'file'

export type PlaybackState = {
  paused: boolean
  currentTime: number
  playbackRate: number
  updatedAt: number
  revision: number
}

export type RoomEvent =
  | { type: 'playback'; state: PlaybackState }
  | { type: 'request-sync' }
  | { type: 'webrtc-signal'; payload: unknown }
  | { type: 'host-status'; online: boolean }

export type Room = { id: string; mode: RoomMode; sourceUrl?: string; expiresAt: string; creatorToken?: string }
