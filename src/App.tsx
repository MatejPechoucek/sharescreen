import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  Film,
  Link2,
  LoaderCircle,
  Maximize,
  MonitorPlay,
  Pause,
  Play,
  Radio,
  Settings,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Upload,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  X,
} from "lucide-react";
import { createRoom, getRoom } from "./api";
import { correctedTime, createPlaybackState, isNewer, RoomBus } from "./sync";
import type { PlaybackState, Room, RoomMode } from "./types";
import { FilePeers } from "./file-peers";
import { originalFileSource } from "./media-source";

const roomIdFromPath = () => location.pathname.match(/^\/room\/([^/]+)/)?.[1];

function App() {
  const [roomId, setRoomId] = useState(roomIdFromPath());
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(Boolean(roomId));
  useEffect(() => {
    if (roomId)
      getRoom(roomId)
        .then(setRoom)
        .finally(() => setLoading(false));
  }, [roomId]);
  if (loading)
    return (
      <Shell>
        <div className="loading">
          <LoaderCircle className="spin" /> Opening room…
        </div>
      </Shell>
    );
  if (roomId && !room)
    return (
      <Shell>
        <EmptyState
          icon={<X />}
          title="This room is unavailable"
          copy="The link may have expired, or the room was removed after a period of inactivity."
          action={
            <button
              className="button primary"
              onClick={() => {
                history.pushState({}, "", "/");
                setRoomId(undefined);
              }}
            >
              Create a new room <ArrowRight size={16} />
            </button>
          }
        />
      </Shell>
    );
  return room ? (
    <RoomScreen
      room={room}
      onExit={() => {
        history.pushState({}, "", "/");
        setRoomId(undefined);
        setRoom(null);
      }}
    />
  ) : (
    <CreateScreen
      onCreated={(newRoom) => {
        setRoom(newRoom);
        setRoomId(newRoom.id);
        history.pushState({}, "", `/room/${newRoom.id}`);
      }}
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Radio size={17} />
          </span>{" "}
          relay
        </a>
        <span className="top-note">private video rooms</span>
      </header>
      {children}
      <footer>
        Encrypted connections · no server-side video storage
      </footer>
    </main>
  );
}

function CreateScreen({ onCreated }: { onCreated: (room: Room) => void }) {
  const [mode, setMode] = useState<RoomMode>("url");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    if (mode === "url" && !/^https?:\/\//i.test(url))
      return setError("Enter a complete video URL beginning with https://");
    setBusy(true);
    try {
      const room = await createRoom(mode, mode === "url" ? url : undefined);
      sessionStorage.setItem(`relay-host:${room.id}`, room.creatorToken || "");
      onCreated(room);
    } catch {
      setError("Could not create the room. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <section className="hero">
        <div className="eyebrow">
          <span className="live-dot" /> WATCH TOGETHER
        </div>
        <h1>
          One room.
          <br />
          <em>One timeline.</em>
        </h1>
        <p className="lede">
          A calm, synchronized space for watching video together. Share a link,
          press play, and stay in step.
        </p>
        <div className="create-card">
          <div className="mode-tabs">
            <button
              className={mode === "url" ? "selected" : ""}
              onClick={() => setMode("url")}
            >
              <Link2 size={17} /> Video URL
            </button>
            <button
              className={mode === "file" ? "selected" : ""}
              onClick={() => setMode("file")}
            >
              <Upload size={17} /> Local file
            </button>
          </div>
          {mode === "url" ? (
            <label className="field">
              <span>Public video URL</span>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/video.mp4"
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>
          ) : (
            <div className="file-note">
              <div className="icon-box">
                <Film size={22} />
              </div>
              <div>
                <strong>Stream from your computer</strong>
                <p>
                  Your file stays in your browser and streams peer-to-peer.
                  Nothing is uploaded to a server.
                </p>
              </div>
            </div>
          )}
          {error && <p className="error">{error}</p>}
          <button
            className="button primary create"
            onClick={submit}
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <MonitorPlay size={17} />
            )}{" "}
            Create private room <ArrowRight size={16} />
          </button>
          <div className="trust">
            <ShieldCheck size={15} /> Unlisted link · expires in 24 hours · no
            account needed
          </div>
        </div>
      </section>
      <section className="feature-row">
        <Feature
          icon={<Users />}
          title="Invite quietly"
          copy="Only people with your link can join."
        />
        <Feature
          icon={<Wifi />}
          title="Stay in sync"
          copy="Play, pause, seek, and speed together."
        />
        <Feature
          icon={<ShieldCheck />}
          title="Keep control"
          copy="Only the room creator controls playback."
        />
      </section>
    </Shell>
  );
}
function Feature({
  icon,
  title,
  copy,
}: {
  icon: React.ReactNode;
  title: string;
  copy: string;
}) {
  return (
    <div className="feature">
      <span className="feature-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{copy}</p>
      </div>
    </div>
  );
}

function RoomScreen({ room, onExit }: { room: Room; onExit: () => void }) {
  const isHost = Boolean(sessionStorage.getItem(`relay-host:${room.id}`));
  return (
    <Shell>
      <RoomView room={room} isHost={isHost} onExit={onExit} />
    </Shell>
  );
}

function RoomView({
  room,
  isHost,
  onExit,
}: {
  room: Room;
  isHost: boolean;
  onExit: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const busRef = useRef<RoomBus>();
  const peersRef = useRef<FilePeers>();
  const fileRef = useRef<File | null>(null);
  const stateRef = useRef<PlaybackState | null>(null);
  // A local-file viewer may receive a host seek before its browser has fetched
  // the byte range for that point in the movie. Keep that seek alive until the
  // media element has really landed there instead of treating one assignment
  // to currentTime as a successful sync.
  const pendingSeekRevision = useRef<number | null>(null);
  const proxyRef = useRef<{ close: () => void; updatePlayhead: (currentTime: number, duration: number) => void }>();
  const sourceGeneration = useRef(0);
  const revision = useRef(Date.now() * 1000);
  const viewerId = useMemo(() => crypto.randomUUID(), []);
  const [fileUrl, setFileUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [connection, setConnection] = useState("Connecting");
  const [transfer, setTransfer] = useState(
    "Waiting for the host to select a file",
  );
  const [bytes, setBytes] = useState(0);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  const viewerLink = `${location.origin}/room/${room.id}`;

  const sendPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!isHost || !video || video.readyState < 1) return;
    const state = createPlaybackState(video, ++revision.current);
    stateRef.current = state;
    void busRef.current?.send({ type: "playback", state });
  }, [isHost]);

  const followHost = useCallback(
    () => {
      const video = videoRef.current;
      const state = stateRef.current;
      if (isHost || !video || !state || video.readyState < 1) return;
      video.playbackRate = state.playbackRate;
      let target = correctedTime(state);
      if (Number.isFinite(video.duration))
        target = Math.min(target, Math.max(0, video.duration - 0.05));
      const tolerance = state.paused ? 0.05 : 0.35;
      const difference = Math.abs(video.currentTime - target);
      const hasPendingSeek = pendingSeekRevision.current === state.revision;
      // Metadata is enough to issue a seek. Waiting for HAVE_FUTURE_DATA here
      // meant a phone could continue buffering its old position indefinitely.
      if (
        !video.seeking &&
        (hasPendingSeek || difference > 1.25) &&
        difference > tolerance
      )
        video.currentTime = target;
      else if (hasPendingSeek && difference <= tolerance)
        pendingSeekRevision.current = null;
      if (state.paused) video.pause();
      else if (video.paused)
        void video
          .play()
          .then(() => setNeedsGesture(false))
          .catch((error) => {
            if (error.name === "NotAllowedError") setNeedsGesture(true);
          });
    },
    [isHost],
  );

  useEffect(() => {
    let active = true;
    let lastHost = Date.now();
    let progressAt = 0;
    const bus = new RoomBus(room.id, (event) => {
      if (!active) return;
      if (event.type === "webrtc-signal" && room.mode === "file")
        peers.signal(event.payload);
      if (event.type === "host-status" && !isHost) {
        lastHost = Date.now();
        setConnection(event.online ? "Connected" : "Host offline");
      }
      if (event.type === "request-sync" && isHost) {
        void bus.send({ type: "host-status", online: true });
        sendPlayback();
      }
      if (
        event.type === "playback" &&
        !isHost &&
        isNewer(event.state, stateRef.current)
      ) {
        const previous = stateRef.current;
        const wasWaitingForSeek = pendingSeekRevision.current !== null;
        const isDiscontinuous =
          !previous ||
          previous.paused !== event.state.paused ||
          previous.playbackRate !== event.state.playbackRate ||
          Math.abs(
            event.state.currentTime - correctedTime(previous, event.state.updatedAt),
          ) > 0.75;
        if (isDiscontinuous || wasWaitingForSeek)
          pendingSeekRevision.current = event.state.revision;
        lastHost = Date.now();
        setConnection("Connected");
        stateRef.current = event.state;
        followHost();
      }
    });
    const peers = new FilePeers({
      id: viewerId,
      isHost,
      send: (payload) => {
        void bus.send({ type: "webrtc-signal", payload });
      },
      onStatus: (status) => {
        if (active) setTransfer(status);
      },
      onError: (error) => {
        if (active) setMessage(error);
      },
      onProgress: (received) => {
        if (active && Date.now() - progressAt > 250) {
          progressAt = Date.now();
          setBytes(received);
        }
      },
      onFile: async (remote, info) => {
        if (!active) return;
        const generation = ++sourceGeneration.current;
        proxyRef.current?.close();
        setFileUrl("");
        setFileName(info.name);
        setBytes(0);
        setMessage("");
        setTransfer("Buffering original file…");
        try {
          const source = await originalFileSource(remote, info);
          if (!active || generation !== sourceGeneration.current) {
            source.close();
            return;
          }
          proxyRef.current = source;
          setFileUrl(source.url);
          setTransfer("Original video + audio · no re-encoding");
        } catch (error) {
          if (active) setMessage(String(error));
        }
      },
    });
    peersRef.current = peers;
    busRef.current = bus;
    if (fileRef.current) peers.setFile(fileRef.current);
    void bus
      .connect()
      .then(() => {
        if (!active) return;
        if (isHost) {
          setConnection("Connected");
          void bus.send({ type: "host-status", online: true });
          sendPlayback();
        } else {
          void bus.send({ type: "request-sync" });
          if (room.mode === "file") peers.tick();
        }
      })
      .catch((error) => {
        if (active) {
          setConnection("Reconnecting");
          setMessage(String(error));
        }
      });
    const interval = window.setInterval(() => {
      if (isHost) {
        void bus.send({ type: "host-status", online: true });
        sendPlayback();
      } else {
        if (room.mode === "file") peers.tick();
        void bus.send({ type: "request-sync" });
        if (Date.now() - lastHost > 10000) setConnection("Host offline");
      }
    }, 2500);
    const announceOffline = () => {
      if (isHost) void bus.send({ type: "host-status", online: false });
    };
    window.addEventListener("pagehide", announceOffline);
    return () => {
      active = false;
      ++sourceGeneration.current;
      clearInterval(interval);
      window.removeEventListener("pagehide", announceOffline);
      announceOffline();
      peers.close();
      proxyRef.current?.close();
      void bus.close();
    };
  }, [room.id, room.mode, isHost, viewerId, followHost, sendPlayback]);

  useEffect(() => {
    if (isHost) return;
    // Some mobile browsers do not emit canplay again while a range request is
    // being retried. A lightweight convergence pass makes a host seek robust
    // across that gap without constantly seeking during normal playback.
    const timer = window.setInterval(() => {
      if (pendingSeekRevision.current !== null) followHost();
    }, 400);
    return () => clearInterval(timer);
  }, [isHost, followHost]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const changed = () => {
      if (isHost) sendPlayback();
    };
    const ready = () => {
      if (isHost) sendPlayback();
      else followHost();
    };
    const playing = () => setNeedsGesture(false);
    const reportPlayhead = () => proxyRef.current?.updatePlayhead(video.currentTime, video.duration);
    for (const name of ["play", "pause", "seeked", "ratechange"])
      video.addEventListener(name, changed);
    video.addEventListener("loadedmetadata", ready);
    video.addEventListener("canplay", ready);
    video.addEventListener("playing", playing);
    video.addEventListener("timeupdate", reportPlayhead);
    video.addEventListener("seeking", reportPlayhead);
    return () => {
      for (const name of ["play", "pause", "seeked", "ratechange"])
        video.removeEventListener(name, changed);
      video.removeEventListener("loadedmetadata", ready);
      video.removeEventListener("canplay", ready);
      video.removeEventListener("playing", playing);
      video.removeEventListener("timeupdate", reportPlayhead);
      video.removeEventListener("seeking", reportPlayhead);
    };
  }, [fileUrl, isHost, followHost, sendPlayback]);

  useEffect(
    () => () => {
      if (fileUrl.startsWith("blob:")) URL.revokeObjectURL(fileUrl);
    },
    [fileUrl],
  );

  const pickFile = (file?: File) => {
    if (!file) return;
    if (file.size === 0) {
      setMessage("This file is empty. Choose a video file.");
      return;
    }
    fileRef.current = file;
    peersRef.current?.setFile(file);
    setFileName(file.name);
    setFileUrl(URL.createObjectURL(file));
    setMessage("");
    setTransfer(
      "Original quality · viewers receive only the portions they need",
    );
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(viewerLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage("Copy the viewer link shown in Room Access.");
    }
  };
  const enablePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    void video
      .play()
      .then(() => {
        setNeedsGesture(false);
        if (stateRef.current?.paused) video.pause();
      })
      .catch(() =>
        setMessage(
          "Playback could not start. Check the host connection and file format.",
        ),
      );
  };
  const selectSource = () => (
    <label className="file-picker">
      <Upload size={18} />
      <span>{fileName ? "Choose another file" : "Choose a video file"}</span>
      <input
        type="file"
        accept="video/*,.mkv,.m4v"
        onChange={(e) => pickFile(e.target.files?.[0])}
      />
    </label>
  );

  return (
    <section className="room-page">
      <div className="room-head">
        <div>
          <button className="back" onClick={onExit}>
            ← New room
          </button>
          <div className="room-title">
            <span className="room-pill">{isHost ? "HOST" : "VIEWER"}</span>
            <span>
              Room <b>{room.id}</b>
            </span>
          </div>
        </div>
        <div className="room-actions">
          <span
            className={`status ${connection === "Connected" ? "connected" : "connecting"}`}
          >
            <i />
            {connection}
          </span>
          <button className="button subtle" onClick={copyLink}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? "Copied" : "Copy viewer link"}
          </button>
        </div>
      </div>
      <div className="player-wrap">
        <div className="video-shell">
          {room.mode === "file" && !fileUrl && isHost ? (
            <div className="empty-player">
              <div className="empty-player-icon">
                <Upload />
              </div>
              <h2>Share the original movie</h2>
              <p>
                Full picture and sound quality. Viewers start watching while the
                next portions arrive.
              </p>
              {selectSource()}
            </div>
          ) : (
            <VideoPlayer
              videoRef={videoRef}
              src={room.mode === "url" ? room.sourceUrl : fileUrl || undefined}
              isHost={isHost}
              onError={() =>
                setMessage(
                  "Cannot play this file or source. Use a browser-compatible video and audio format (for example MP4 with H.264/AAC, or WebM with VP9/Opus). Check that the host is connected.",
                )
              }
            />
          )}
        </div>
        <aside className="room-sidebar">
          <div className="sidebar-section">
            <div className="side-label">ROOM ACCESS</div>
            <div className="link-card">
              <Link2 size={16} />
              <span>{viewerLink.replace(/^https?:\/\//, "")}</span>
              <button aria-label="Copy room link" onClick={copyLink}>
                <Copy size={15} />
              </button>
            </div>
            <p className="side-hint">Share this link with your viewers.</p>
          </div>
          <div className="sidebar-section">
            <div className="side-label">
              {isHost ? "HOST CONTROLS" : "PLAYBACK"}
            </div>
            {isHost ? (
              <>
                <p className="side-hint">
                  Play, pause, seek, and speed changes are shared automatically.
                </p>
                {room.mode === "file" && fileUrl && (
                  <>
                    <div className="selected-file">
                      <Film size={16} />
                      <span>{fileName}</span>
                    </div>
                    {selectSource()}
                  </>
                )}
              </>
            ) : (
              <>
                <div className="viewer-lock">
                  <ShieldCheck size={17} />
                  <span>Following the host</span>
                </div>
                <p className="side-hint">
                  Volume and fullscreen are yours to control.
                </p>
              </>
            )}
          </div>
          {room.mode === "file" && (
            <div className="transfer-info">
              <strong>
                <Film size={15} /> Original quality
              </strong>
              <span>{transfer}</span>
              {bytes > 0 && (
                <span>{(bytes / 1048576).toFixed(1)} MB received</span>
              )}
              <small>
                Keep the host tab open. Slow connections buffer without reducing
                picture or sound quality. A relay may be needed on restrictive
                networks.
              </small>
            </div>
          )}
          {needsGesture && (
            <button
              className="button primary enable-playback"
              onClick={enablePlayback}
            >
              <Play size={16} /> Enable video &amp; sound
            </button>
          )}
          {message && (
            <div className="message" role="alert">
              {message}
            </div>
          )}
        </aside>
      </div>
      <div className="room-footer">
        <span>
          <span className="live-dot" />
          {isHost ? "You are hosting" : "Following host timeline"}
        </span>
        <span>
          Expires{" "}
          {new Date(room.expiresAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
      </div>
    </section>
  );
}
function VideoPlayer({
  videoRef,
  src,
  isHost,
  onError,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  src?: string;
  isHost: boolean;
  onError: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);
  const playerRef = useRef<HTMLDivElement>(null);
  const [buffering, setBuffering] = useState(false);
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const update = () => {
      setPlaying(!element.paused);
      setCurrent(element.currentTime);
      setDuration(element.duration || 0);
    };
    element.addEventListener("timeupdate", update);
    element.addEventListener("loadedmetadata", update);
    element.addEventListener("durationchange", update);
    element.addEventListener("play", update);
    element.addEventListener("pause", update);
    update();
    return () => {
      element.removeEventListener("timeupdate", update);
      element.removeEventListener("loadedmetadata", update);
      element.removeEventListener("durationchange", update);
      element.removeEventListener("play", update);
      element.removeEventListener("pause", update);
    };
  }, [src]);
  const togglePlay = () => {
    const element = videoRef.current;
    if (!element) return;
    element.paused ? element.play().catch(() => {}) : element.pause();
  };
  const seek = (value: number) => {
    const element = videoRef.current;
    if (element && Number.isFinite(value)) {
      element.currentTime = value;
      setCurrent(value);
    }
  };
  const changeSpeed = (value: number) => {
    const element = videoRef.current;
    if (element) element.playbackRate = value;
    setSpeed(value);
    setShowSpeed(false);
  };
  const changeVolume = (value: number) => {
    const element = videoRef.current;
    if (element) {
      element.volume = value;
      element.muted = value === 0;
    }
    setVolume(value);
    setMuted(value === 0);
  };
  const toggleMute = () => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = !element.muted;
    setMuted(element.muted);
  };
  const fullscreen = () => {
    const video = videoRef.current;
    const player = playerRef.current;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    // iPhone Safari supports fullscreen on the media element rather than an
    // arbitrary wrapper. Prefer the standard API everywhere else so the
    // custom controls remain available on iPad, Android, and desktop.
    const legacyVideo = video as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitDisplayingFullscreen?: boolean;
    }) | null;
    const legacyDocument = document as Document & {
      webkitExitFullscreen?: () => void;
    };
    if (legacyVideo?.webkitDisplayingFullscreen) {
      legacyDocument.webkitExitFullscreen?.();
      return;
    }
    if (player?.requestFullscreen) {
      void player.requestFullscreen().catch(() => {
        legacyVideo?.webkitEnterFullscreen?.();
      });
    } else legacyVideo?.webkitEnterFullscreen?.();
  };
  return (
    <div
      className={`custom-player ${playing ? "is-playing" : ""} ${isHost ? "host-player" : "viewer-player"}`}
      ref={playerRef}
    >
      <video
        ref={videoRef as React.RefObject<HTMLVideoElement>}
        src={src}
        onError={() => {
          setBuffering(false);
          onError();
        }}
        onWaiting={() => setBuffering(true)}
        onCanPlay={() => setBuffering(false)}
        onPlaying={() => setBuffering(false)}
        playsInline
        preload="auto"
        className="video"
        onClick={isHost ? togglePlay : undefined}
      />
      {buffering && (
        <div className="buffering-indicator" role="status">
          <LoaderCircle className="spin" size={24} />
          <span>Buffering original quality…</span>
        </div>
      )}
      {isHost && <div className="player-vignette" />}
      <div className="player-controls">
        <input
          className="seekbar"
          type="range"
          min="0"
          max={duration || 0}
          step="0.1"
          value={Math.min(current, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!isHost || !duration}
          aria-label="Video progress"
        />
        <div className="controls-row">
          <div className="controls-left">
            <button
              className="player-button main-control"
              onClick={togglePlay}
              disabled={!isHost}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? (
                <Pause size={19} fill="currentColor" />
              ) : (
                <Play size={19} fill="currentColor" />
              )}
            </button>
            {isHost && (
              <>
                <button
                  className="player-button desktop-only"
                  onClick={() => seek(Math.max(0, current - 10))}
                  aria-label="Back 10 seconds"
                >
                  <SkipBack size={16} />
                </button>
                <button
                  className="player-button desktop-only"
                  onClick={() => seek(Math.min(duration, current + 10))}
                  aria-label="Forward 10 seconds"
                >
                  <SkipForward size={16} />
                </button>
              </>
            )}
            <span className="timecode">
              {formatTime(current)} <i>/</i> {formatTime(duration)}
            </span>
          </div>
          <div className="controls-right">
            <button
              className="player-button"
              onClick={toggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted || volume === 0 ? (
                <VolumeX size={17} />
              ) : (
                <Volume2 size={17} />
              )}
            </button>
            <input
              className="volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
              aria-label="Volume"
            />
            <div className="speed-wrap">
              {isHost && (
                <button
                  className="player-button speed-button"
                  onClick={() => setShowSpeed(!showSpeed)}
                >
                  <Settings size={16} />
                  <span>{speed}×</span>
                </button>
              )}
              {showSpeed && (
                <div className="speed-menu">
                  {[0.5, 1, 1.25, 1.5, 2].map((value) => (
                    <button
                      key={value}
                      className={speed === value ? "active" : ""}
                      onClick={() => changeSpeed(value)}
                    >
                      {value}×
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="player-button"
              onClick={fullscreen}
              aria-label="Fullscreen"
            >
              <Maximize size={17} />
            </button>
          </div>
        </div>
      </div>
      {!isHost && (
        <div className="viewer-overlay">
          <span>
            <ShieldCheck size={14} /> Following host
          </span>
        </div>
      )}
    </div>
  );
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(seconds).padStart(2, "0")}`;
}

function EmptyState({
  icon,
  title,
  copy,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  copy: string;
  action: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h1>{title}</h1>
      <p>{copy}</p>
      {action}
    </div>
  );
}
export default App;
