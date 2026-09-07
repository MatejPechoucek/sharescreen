# Relay video rooms

Vite/React on Vercel, with Supabase room metadata and Realtime signaling.

## Original-quality local files

The host selects a file. Viewers receive its **original encoded bytes**, on demand,
over a reliable, ordered WebRTC data channel. There is no video/audio re-encoding,
resolution scaling, microphone capture, or file upload to Vercel/Supabase.

A service worker provides the viewer's video element with a virtual HTTP resource
under `/__relay_media/`. It answers byte-range requests using data from the host
tab, including requests for metadata at the end of an MP4. The browser starts
playing while later ranges arrive and can request a different range when seeking.
No whole-file ArrayBuffer/Blob is created on the viewer. Application reads are
bounded to 256 KiB, split into messages smaller than 16 KiB with send-buffer
backpressure. A maximum of eight reads may be outstanding per peer.

The service worker keeps a rolling in-memory cache of the exact byte blocks the
browser asks for. It favors blocks approximating one minute before/after the
viewer playhead and evicts older/farther blocks, with a **48 MB total cap** across
active original-file sources. This is only an optimization: it never changes the
bytes served or substitutes a rough byte/time estimate for an actual range request.
The browser's own media buffer remains the authority for decoding and may evict
data separately.

Original audio stays inside the original file. Each viewer controls their own
volume/mute. If autoplay is blocked, use **Enable video & sound**. Host play, pause,
seek, and playback speed remain synchronized separately from file transfer.

### Requirements and limitations

- Use HTTPS (or localhost); service workers are required for progressive file playback.
- Chrome is the tested browser. Other browsers must support service workers with
  streaming responses, WebRTC data channels, and the file's container/video/audio codecs.
- MP4 with H.264/AAC and WebM with browser-supported codecs are suitable choices.
  An MKV/HEVC/DTS/AC-3 file is not guaranteed to decode in a given browser. Sending
  bytes losslessly cannot add a codec the browser lacks; there is no automatic transcoding.
- Keep the host tab open and the file selected. Reloading the host requires selecting
  the file again. Viewer reload/reconnection requests a new connection and file ranges.
- Slow links buffer instead of reducing quality. Host upload scales with the number
  of viewers; clients can re-request bytes after a seek. The received-byte counter
  includes repeated reads and is not a whole-file download percentage.
- STUN is configured; some networks need TURN. There is no TURN provider configured.
- Browser playback buffers consume memory, but application cache memory is capped at
  48 MB and does not scale with the entire movie size. Native decoding/rendering
  performance still depends on device hardware.

## Development and deployment

1. `npm install`
2. Configure the variables in `.env.example`. Only publishable/anon keys belong in
   `VITE_` variables. Keep the secret/service-role key server-side.
3. Apply `supabase/schema.sql` to your Supabase project.
4. `npm run dev` starts the frontend. Use Vercel development/functions for `/api/rooms`,
   or the browser test's optional `RELAY_API_ORIGIN` proxy for testing with an existing backend.
5. `npm test` and `npm run build`.
6. Deploy with Vercel's Vite preset, `npm run build`, output `dist`. The root `api/`
   functions and `public/media-sw.js` must be deployed with the frontend.

Without Supabase, BroadcastChannel/local metadata only support same-browser local
preview, not separate incognito profiles or devices. Production needs Supabase.

## Repeatable browser quality test

Requires Google Chrome and FFmpeg. Generate original test files (35 seconds,
1920×1080, 60 fps, stereo AAC):

```sh
mkdir -p /tmp/relay-fixtures
ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=60 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 35 \
  -c:v libx264 -preset ultrafast -b:v 8M -maxrate 8M -bufsize 16M \
  -g 60 -pix_fmt yuv420p -c:a aac -b:a 192k -ac 2 -movflags +faststart \
  /tmp/relay-fixtures/front.mp4
ffmpeg -i /tmp/relay-fixtures/front.mp4 -c copy /tmp/relay-fixtures/tail.mp4
RELAY_TEST_URL=https://YOUR-DEPLOYMENT.vercel.app \
RELAY_TEST_FILE=/tmp/relay-fixtures/front.mp4 \
RELAY_TEST_TAIL_FILE=/tmp/relay-fixtures/tail.mp4 npm run test:browser
```

The test creates temporary rooms on the specified deployment. It uses independent
host/viewer Chrome profiles and a second viewer, throttles host file reads, verifies
playback starts before complete transfer, compares a received byte range's SHA-256
with the source file, measures decoded frames and a non-silent audio waveform, and
checks pause/resume, unbuffered seeking, speed, viewer reload, and file replacement.
Screenshots and JSON results are saved in a printed temporary directory.

For local testing, set `RELAY_TEST_URL=http://127.0.0.1:5173` and optionally
`RELAY_API_ORIGIN=https://YOUR-DEPLOYMENT.vercel.app`. The frontend still needs its
Supabase variables for communication across independent browser profiles.

Unit tests cover byte identity across packet boundaries, read limits, range errors,
suffix metadata requests, and offsets beyond 4 GB.
