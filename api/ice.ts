import type { VercelRequest, VercelResponse } from "@vercel/node";

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

// TURN credentials are supplied to WebRTC peers at connection time. Keep the
// provider account key/secret out of this endpoint; use only a restricted TURN
// username and credential with a quota/expiry at the provider.
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const urls = (process.env.TURN_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => /^(turn|turns):/i.test(url));
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  const iceServers: IceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
  ];
  if (urls.length && username && credential)
    iceServers.push({ urls, username, credential });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ iceServers });
}
