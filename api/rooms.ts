import { createClient } from '@supabase/supabase-js'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const rooms = new Map<string, any>()
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY) : null
const id = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10)
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(x => x.toString(16).padStart(2, '0')).join('')

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    const { mode, sourceUrl } = req.body || {}
    if (!['url', 'file'].includes(mode) || (mode === 'url' && (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)))) return res.status(400).json({ error: 'Invalid room source.' })
    const creatorToken = crypto.randomUUID(); const room = { id: id(), mode, source_url: mode === 'url' ? sourceUrl : null, expires_at: new Date(Date.now() + 24 * 3600000).toISOString(), creator_token_hash: await hash(creatorToken) }
    if (supabase) { const { error } = await supabase.from('rooms').insert(room); if (error) return res.status(500).json({ error: error.message }) } else rooms.set(room.id, room)
    return res.status(201).json({ id: room.id, mode: room.mode, sourceUrl: sourceUrl || undefined, expiresAt: room.expires_at, creatorToken })
  }
  if (req.method === 'GET') {
    const roomId = String(req.query.id || ''); let room: any
    if (supabase) { const result = await supabase.from('rooms').select('id,mode,source_url,expires_at').eq('id', roomId).gt('expires_at', new Date().toISOString()).maybeSingle(); room = result.data }
    else room = rooms.get(roomId)
    if (!room || new Date(room.expires_at) <= new Date()) return res.status(404).json({ error: 'Room not found or expired.' })
    return res.json({ id: room.id, mode: room.mode, sourceUrl: room.source_url || undefined, expiresAt: room.expires_at })
  }
  return res.status(405).end()
}
