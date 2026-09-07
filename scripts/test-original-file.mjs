import { chromium } from "playwright";
import { readFile, writeFile, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const origin = process.env.RELAY_TEST_URL || "http://127.0.0.1:5173";
const apiOrigin = process.env.RELAY_API_ORIGIN;
const output = await mkdtemp(join(tmpdir(), "relay-quality-"));
console.log("Evidence:", output);
const fixture = process.env.RELAY_TEST_FILE;
if (!fixture)
  throw new Error(
    "Set RELAY_TEST_FILE to the 1080p60 test MP4. See README.md.",
  );
const replacement = process.env.RELAY_TEST_TAIL_FILE || fixture;
const total = (await stat(fixture)).size;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const hostContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const viewerContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const host = await hostContext.newPage();
const viewer = await viewerContext.newPage();
const results = [];
for (const [name, page] of [
  ["host", host],
  ["viewer", viewer],
]) {
  page.on("pageerror", (e) => console.log(name, "ERROR", e.message));
  page.on("console", (m) => {
    if (m.type() === "error")
      console.log(name, "console", m.text().slice(0, 250));
  });
  if (apiOrigin)
    await page.route("**/api/rooms**", async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: apiOrigin + url.pathname + url.search,
      });
      await route.fulfill({ response });
    });
  await page.addInitScript(() => {
    window.testPeers = [];
    window.testChannels = [];
    window.testSent = 0;
    window.testReads = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(...args) {
        super(...args);
        window.testPeers.push(this);
        this.addEventListener("datachannel", (e) =>
          window.testChannels.push(e.channel),
        );
      }
      createDataChannel(...args) {
        const ch = super.createDataChannel(...args);
        window.testChannels.push(ch);
        const send = ch.send.bind(ch);
        ch.send = (data) => {
          if (typeof data !== "string") window.testSent += data.byteLength;
          return send(data);
        };
        return ch;
      }
    };
  });
}
// Limit file reads to roughly 1.4 MB/s. Native video playback does not use this JS method.
await host.addInitScript(() => {
  const slice = File.prototype.slice;
  File.prototype.slice = function (start, end, ...args) {
    window.testReads.push({ start, end });
    const blob = slice.call(this, start, end, ...args);
    const read = blob.arrayBuffer.bind(blob);
    blob.arrayBuffer = async () => {
      await new Promise((r) => setTimeout(r, 10));
      return read();
    };
    return blob;
  };
});
const inspect = async (page) =>
  page.evaluate(() => {
    const v = document.querySelector("video");
    const q = v?.getVideoPlaybackQuality();
    return {
      role: document.querySelector(".room-pill")?.textContent,
      status: document.querySelector(".status")?.textContent,
      message: document.querySelector(".message")?.textContent,
      video: v && {
        paused: v.paused,
        ready: v.readyState,
        time: v.currentTime,
        width: v.videoWidth,
        height: v.videoHeight,
        rate: v.playbackRate,
        audioBytes: v.webkitAudioDecodedByteCount,
        quality: q && {
          total: q.totalVideoFrames,
          dropped: q.droppedVideoFrames,
        },
        src: v.currentSrc,
      },
      sent: window.testSent,
      peerStates: window.testPeers.map((p) => p.connectionState),
      channelStates: window.testChannels.map((c) => c.readyState),
    };
  });
const checkpoint = async (name) => {
  const result = {
    name,
    host: await inspect(host),
    viewer: await inspect(viewer),
  };
  results.push(result);
  console.log(JSON.stringify(result));
};
const enable = async () => {
  const button = viewer.getByRole("button", { name: "Enable video & sound" });
  if (await button.isVisible()) await button.click();
};
try {
  await host.goto(origin);
  await host.getByRole("button", { name: "Local file", exact: true }).click();
  await host.getByRole("button", { name: "Create private room" }).click();
  await host.waitForURL("**/room/**");
  console.log("room", host.url(), "fileBytes", total);
  await viewer.goto(host.url());
  await viewer.locator("video").waitFor();
  await host.locator("input[type=file]").first().setInputFiles(fixture);
  await host.locator("video").evaluate((video) => {
    video.loop = true;
  });
  await host
    .getByRole("button", { name: "Play", exact: true })
    .click({ force: true });
  await viewer.waitForFunction(
    () => document.querySelector("video")?.readyState >= 3,
    null,
    { timeout: 45000 },
  );
  await enable();
  await viewer.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && !v.paused && v.currentTime > 0.1;
    },
    null,
    { timeout: 15000 },
  );
  await checkpoint("progressive-start");
  const initial = results.at(-1);
  assert(
    initial.host.sent < total,
    "Playback must start before the full file arrives",
  );
  assert.equal(initial.viewer.video.width, 1920);
  assert.equal(initial.viewer.video.height, 1080);
  await viewer.waitForTimeout(3000);
  await checkpoint("playing");
  assert(results.at(-1).viewer.video.audioBytes > 0, "Audio must decode");
  const audio = await viewer.evaluate(async () => {
    const v = document.querySelector("video");
    const ac = new AudioContext();
    await ac.resume();
    const analyser = ac.createAnalyser();
    const source = ac.createMediaElementSource(v);
    source.connect(analyser);
    analyser.connect(ac.destination);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      analyser.getFloatTimeDomainData(samples);
      peak = Math.max(
        peak,
        Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length),
      );
    }
    return { rms: peak, state: ac.state };
  });
  console.log("AUDIO", JSON.stringify(audio));
  assert(audio.rms > 0.005, "Viewer must output a non-silent audio waveform");
  await host
    .getByRole("button", { name: "Pause", exact: true })
    .click({ force: true });
  await viewer.waitForFunction(() => document.querySelector("video").paused);
  await checkpoint("paused");
  // Fetch a range through the exact media path and verify against original file bytes.
  const offset = 1024 * 1024,
    length = 65536;
  const actual = await viewer.evaluate(
    async ({ offset, length }) => {
      const response = await fetch(document.querySelector("video").currentSrc, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      });
      const bytes = await response.arrayBuffer();
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      return {
        status: response.status,
        length: bytes.byteLength,
        hash: [...new Uint8Array(hash)]
          .map((x) => x.toString(16).padStart(2, "0"))
          .join(""),
      };
    },
    { offset, length },
  );
  const bytes = await readFile(fixture);
  assert.equal(
    actual.hash,
    createHash("sha256")
      .update(bytes.subarray(offset, offset + length))
      .digest("hex"),
  );
  assert.equal(actual.status, 206);
  console.log("EXACT_BYTES", JSON.stringify(actual));
  // A host can scrub and hit play immediately. The viewer must not resume at
  // its old/default position while the destination range is still loading.
  await viewer.evaluate(() => {
    window.testPlayPositions = [];
    document.querySelector("video").addEventListener("play", (event) => {
      window.testPlayPositions.push(event.currentTarget.currentTime);
    });
  });
  await host.locator(".seekbar").fill("28");
  await host
    .getByRole("button", { name: "Play", exact: true })
    .click({ force: true });
  await viewer.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return !v.paused && v.readyState >= 3 && v.currentTime > 28.2;
    },
    null,
    { timeout: 30000 },
  );
  const playPositions = await viewer.evaluate(() => window.testPlayPositions);
  assert(
    playPositions.every((time) => time > 27),
    `Viewer started before reaching the host seek target: ${playPositions}`,
  );
  await checkpoint("seek-unbuffered");
  await host
    .getByRole("button", { name: "Pause", exact: true })
    .click({ force: true });
  await host.locator(".seekbar").fill("5");
  await host.locator(".speed-button").click({ force: true });
  await host
    .locator(".speed-menu")
    .getByRole("button", { name: "1.5×", exact: true })
    .click();
  await host
    .getByRole("button", { name: "Play", exact: true })
    .click({ force: true });
  await viewer.waitForFunction(
    () => document.querySelector("video").playbackRate === 1.5,
  );
  await checkpoint("speed");
  await viewer.reload();
  await viewer.waitForFunction(
    () => document.querySelector("video")?.readyState >= 3,
    null,
    { timeout: 45000 },
  );
  await enable();
  await viewer.waitForFunction(() => !document.querySelector("video").paused);
  await checkpoint("reload");
  await host
    .getByRole("button", { name: "Pause", exact: true })
    .click({ force: true });
  await host.locator(".seekbar").fill("2");
  await host.locator(".speed-button").click({ force: true });
  await host
    .locator(".speed-menu")
    .getByRole("button", { name: "1×", exact: true })
    .click();
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  if (apiOrigin)
    await second.route("**/api/rooms**", async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: apiOrigin + url.pathname + url.search,
      });
      await route.fulfill({ response });
    });
  await second.goto(host.url());
  await second.waitForFunction(
    () => document.querySelector("video")?.readyState >= 3,
    null,
    { timeout: 45000 },
  );
  await host
    .getByRole("button", { name: "Play", exact: true })
    .click({ force: true });
  await second.waitForTimeout(500);
  const secondEnable = second.getByRole("button", {
    name: "Enable video & sound",
  });
  if (await secondEnable.isVisible()) await secondEnable.click();
  await second.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return !v.paused && v.currentTime > 2.2;
    },
    null,
    { timeout: 20000 },
  );
  const before = await inspect(viewer);
  await viewer.waitForTimeout(4000);
  const after = await inspect(viewer);
  const fps =
    (after.video.quality.total - before.video.quality.total) /
    (after.video.time - before.video.time);
  console.log(
    "FPS",
    fps,
    "dropped",
    after.video.quality.dropped - before.video.quality.dropped,
  );
  assert(fps > 45 && fps < 80);
  assert.equal(
    await second.locator("video").evaluate((v) => v.videoWidth),
    1920,
  );
  assert(
    (await second
      .locator("video")
      .evaluate((v) => v.webkitAudioDecodedByteCount)) > 0,
  );
  console.log("SECOND_VIEWER_PASS");
  const oldSource = await viewer.locator("video").evaluate((v) => v.currentSrc);
  await host.locator("input[type=file]").first().setInputFiles(replacement);
  await host
    .getByRole("button", { name: "Play", exact: true })
    .click({ force: true });
  await viewer.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && !v.paused && v.readyState >= 3 && v.currentTime > 0.1;
    },
    null,
    { timeout: 45000 },
  );
  await viewer.waitForFunction(
    (old) => document.querySelector("video").currentSrc !== old,
    oldSource,
  );
  await checkpoint("source-replacement");
  await viewer.screenshot({ path: join(output, "viewer.png") });
  await host.screenshot({ path: join(output, "host.png") });
  console.log(
    "PASS progressive playback, exact bytes, 1080p, audible PCM, seek, pause/resume, speed, separate profiles and reload",
  );
} catch (error) {
  await checkpoint("failure");
  await viewer.screenshot({ path: join(output, "failure.png") });
  throw error;
} finally {
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ origin, total, results }, null, 2),
  );
  await browser.close();
}
