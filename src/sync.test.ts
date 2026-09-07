import { describe, expect, it } from 'vitest'
import { correctedTime, isNewer } from './sync'
import type { PlaybackState } from './types'

const state = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({ paused: false, currentTime: 10, playbackRate: 1, updatedAt: 1000, revision: 1, ...overrides })

describe('playback state ordering', () => {
  it('accepts newer revisions and rejects stale events', () => {
    expect(isNewer(state({ revision: 2 }), state())).toBe(true)
    expect(isNewer(state({ revision: 0 }), state())).toBe(false)
    expect(isNewer(state({ revision: 1, updatedAt: 900 }), state())).toBe(false)
  })

  it('projects a playing state forward by elapsed network time', () => {
    expect(correctedTime(state(), 3000)).toBe(12)
    expect(correctedTime(state({ paused: true }), 3000)).toBe(10)
    expect(correctedTime(state({ playbackRate: 1.5 }), 3000)).toBe(13)
  })
})
