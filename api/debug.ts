import type { VercelRequest, VercelResponse } from "@vercel/node";

const text = (value: unknown, maximum: number) =>
  typeof value === "string" ? value.slice(0, maximum) : "";

// Ephemeral observability for control-plane events. Do not add file payloads,
// room URLs, creator tokens, or WebRTC packets here.
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const body = req.body || {};
  const event = text(body.event, 80);
  const roomId = text(body.roomId, 64);
  if (!event || !roomId) return res.status(400).json({ error: "Invalid diagnostic." });
  console.log(
    JSON.stringify({
      type: "relay-debug",
      event,
      roomId,
      at: typeof body.at === "number" ? body.at : Date.now(),
      paused: typeof body.paused === "boolean" ? body.paused : undefined,
      currentTime: typeof body.currentTime === "number" ? body.currentTime : undefined,
      playbackRate: typeof body.playbackRate === "number" ? body.playbackRate : undefined,
      revision: typeof body.revision === "number" ? body.revision : undefined,
      target: typeof body.target === "number" ? body.target : undefined,
      actual: typeof body.actual === "number" ? body.actual : undefined,
    }),
  );
  return res.status(204).end();
}
