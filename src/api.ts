import type { Room, RoomMode } from './types'

const localRooms = new Map<string, Room>()
function randomId(size = 8) { return crypto.getRandomValues(new Uint8Array(size)).reduce((s, n) => s + n.toString(36), '').slice(0, size) }

export async function createRoom(mode: RoomMode, sourceUrl?: string): Promise<Room> {
  try {
    const response = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, sourceUrl }) })
    if (response.ok) return response.json()
  } catch { /* local preview fallback */ }
  const room: Room = { id: randomId(), mode, sourceUrl, expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(), creatorToken: crypto.randomUUID() }
  localRooms.set(room.id, room); localStorage.setItem(`relay-room:${room.id}`, JSON.stringify(room)); return room
}

export async function getRoom(id: string): Promise<Room | null> {
  try { const response = await fetch(`/api/rooms?id=${encodeURIComponent(id)}`); if (response.ok) return response.json() } catch { /* local preview fallback */ }
  const room = localRooms.get(id) ?? JSON.parse(localStorage.getItem(`relay-room:${id}`) || 'null')
  return room && new Date(room.expiresAt) > new Date() ? room : null
}
