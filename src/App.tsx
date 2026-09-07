import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check, Copy, Film, Link2, LoaderCircle, Maximize, MonitorPlay, Pause, Play, Radio, Settings, ShieldCheck, SkipBack, SkipForward, Upload, Users, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react'
import { createRoom, getRoom } from './api'
import { correctedTime, createPlaybackState, isNewer, RoomBus } from './sync'
import type { PlaybackState, Room, RoomEvent, RoomMode } from './types'

const peerConfig: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
const roomIdFromPath = () => location.pathname.match(/^\/room\/([^/]+)/)?.[1]

function App() {
  const [roomId, setRoomId] = useState(roomIdFromPath())
  const [room, setRoom] = useState<Room | null>(null)
  const [loading, setLoading] = useState(Boolean(roomId))
  useEffect(() => { if (roomId) getRoom(roomId).then(setRoom).finally(() => setLoading(false)) }, [roomId])
  if (loading) return <Shell><div className="loading"><LoaderCircle className="spin" /> Opening room…</div></Shell>
  if (roomId && !room) return <Shell><EmptyState icon={<X />} title="This room is unavailable" copy="The link may have expired, or the room was removed after a period of inactivity." action={<button className="button primary" onClick={() => { history.pushState({}, '', '/'); setRoomId(undefined) }}>Create a new room <ArrowRight size={16} /></button>} /></Shell>
  return room ? <RoomScreen room={room} onExit={() => { history.pushState({}, '', '/'); setRoomId(undefined); setRoom(null) }} /> : <CreateScreen onCreated={newRoom => { setRoom(newRoom); setRoomId(newRoom.id); history.pushState({}, '', `/room/${newRoom.id}`) }} />
}

function Shell({ children }: { children: React.ReactNode }) { return <main className="app"><header className="topbar"><a className="brand" href="/"><span className="brand-mark"><Radio size={17} /></span> relay</a><span className="top-note">private video rooms</span></header>{children}<footer>Encrypted signaling · no video files stored · rooms expire automatically</footer></main> }

function CreateScreen({ onCreated }: { onCreated: (room: Room) => void }) {
  const [mode, setMode] = useState<RoomMode>('url'); const [url, setUrl] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const submit = async () => { setError(''); if (mode === 'url' && !/^https?:\/\//i.test(url)) return setError('Enter a complete video URL beginning with https://'); setBusy(true); try { const room = await createRoom(mode, mode === 'url' ? url : undefined); sessionStorage.setItem(`relay-host:${room.id}`, room.creatorToken || ''); onCreated(room) } catch { setError('Could not create the room. Please try again.') } finally { setBusy(false) } }
  return <Shell><section className="hero"><div className="eyebrow"><span className="live-dot" /> WATCH TOGETHER</div><h1>One room.<br /><em>One timeline.</em></h1><p className="lede">A calm, synchronized space for watching video together. Share a link, press play, and stay in step.</p><div className="create-card"><div className="mode-tabs"><button className={mode === 'url' ? 'selected' : ''} onClick={() => setMode('url')}><Link2 size={17} /> Video URL</button><button className={mode === 'file' ? 'selected' : ''} onClick={() => setMode('file')}><Upload size={17} /> Local file</button></div>{mode === 'url' ? <label className="field"><span>Public video URL</span><input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/video.mp4" onKeyDown={e => e.key === 'Enter' && submit()} /></label> : <div className="file-note"><div className="icon-box"><Film size={22} /></div><div><strong>Stream from your computer</strong><p>Your file stays in your browser and streams peer-to-peer. Nothing is uploaded.</p></div></div>}{error && <p className="error">{error}</p>}<button className="button primary create" onClick={submit} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <MonitorPlay size={17} />} Create private room <ArrowRight size={16} /></button><div className="trust"><ShieldCheck size={15} /> Unlisted link · expires in 24 hours · no account needed</div></div></section><section className="feature-row"><Feature icon={<Users />} title="Invite quietly" copy="Only people with your link can join." /><Feature icon={<Wifi />} title="Stay in sync" copy="Play, pause, seek, and speed together." /><Feature icon={<ShieldCheck />} title="Keep control" copy="Only the room creator controls playback." /></section></Shell>
}
function Feature({ icon, title, copy }: { icon: React.ReactNode; title: string; copy: string }) { return <div className="feature"><span className="feature-icon">{icon}</span><div><strong>{title}</strong><p>{copy}</p></div></div> }

function RoomScreen({ room, onExit }: { room: Room; onExit: () => void }) {
  const isHost = Boolean(sessionStorage.getItem(`relay-host:${room.id}`));
  return <Shell><RoomView room={room} isHost={isHost} onExit={onExit} /></Shell>
}

function RoomView({ room, isHost, onExit }: { room: Room; isHost: boolean; onExit: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null); const busRef = useRef<RoomBus>(); const peers = useRef(new Map<string, RTCPeerConnection>()); const waitingViewers = useRef(new Set<string>()); const streamRef = useRef<MediaStream>(); const revision = useRef(0); const stateRef = useRef<PlaybackState | null>(null); const viewerId = useMemo(() => crypto.randomUUID(), [])
  const [fileUrl, setFileUrl] = useState(''); const [fileName, setFileName] = useState(''); const [connection, setConnection] = useState<'connecting' | 'connected' | 'offline'>('connecting'); const [copied, setCopied] = useState(false); const [message, setMessage] = useState(''); const [playback, setPlayback] = useState<PlaybackState | null>(null)
  const viewerLink = `${location.origin}/room/${room.id}`
  const sendPlayback = useCallback(() => { const video = videoRef.current; if (!video || !isHost) return; const next = createPlaybackState(video, ++revision.current); stateRef.current = next; setPlayback(next); busRef.current?.send({ type: 'playback', state: next }) }, [isHost])

  const makePeer = useCallback(async (id: string) => { if (!streamRef.current || peers.current.has(id)) return; const peer = new RTCPeerConnection(peerConfig); peers.current.set(id, peer); streamRef.current.getTracks().forEach(track => peer.addTrack(track, streamRef.current!)); peer.onicecandidate = e => e.candidate && busRef.current?.send({ type: 'webrtc-signal', payload: { kind: 'candidate', from: viewerId, to: id, candidate: e.candidate } }); peer.onconnectionstatechange = () => setConnection(peer.connectionState === 'connected' ? 'connected' : peer.connectionState === 'failed' ? 'offline' : 'connecting'); const offer = await peer.createOffer(); await peer.setLocalDescription(offer); await busRef.current?.send({ type: 'webrtc-signal', payload: { kind: 'offer', from: viewerId, to: id, offer } }) }, [viewerId])

  useEffect(() => { const video = videoRef.current; if (!video) return; const onEvent = () => { if (isHost && room.mode === 'file' && !streamRef.current && (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream) streamRef.current = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream!(); if (isHost) { waitingViewers.current.forEach(id => { void makePeer(id) }); sendPlayback() } }; video.addEventListener('play', onEvent); video.addEventListener('pause', onEvent); video.addEventListener('ratechange', onEvent); video.addEventListener('seeked', onEvent); return () => { video.removeEventListener('play', onEvent); video.removeEventListener('pause', onEvent); video.removeEventListener('ratechange', onEvent); video.removeEventListener('seeked', onEvent) } }, [isHost, sendPlayback, makePeer, fileUrl])
  useEffect(() => {
    const handler = async (event: RoomEvent) => {
      if (event.type === 'host-status') { setConnection(event.online ? 'connected' : 'offline'); return }
      if (event.type === 'request-sync' && isHost && stateRef.current) return void busRef.current?.send({ type: 'playback', state: stateRef.current })
      if (event.type === 'playback' && !isHost && isNewer(event.state, stateRef.current)) {
        stateRef.current = event.state; setPlayback(event.state)
        const video = videoRef.current
        if (video) { video.playbackRate = event.state.playbackRate; const target = correctedTime(event.state); if (Math.abs(video.currentTime - target) > 0.35) video.currentTime = target; if (event.state.paused) video.pause(); else video.play().catch(() => setMessage('Tap play to allow playback in this browser.')) }
      }
      if (event.type !== 'webrtc-signal') return
      const payload = event.payload as any
      if (isHost) {
        if (payload.kind === 'viewer-ready') { waitingViewers.current.add(payload.from); return void makePeer(payload.from) }
        if (payload.to !== viewerId) return
        if (payload.kind === 'answer') await peers.current.get(payload.from)?.setRemoteDescription(payload.answer)
        if (payload.kind === 'candidate') await peers.current.get(payload.from)?.addIceCandidate(payload.candidate).catch(() => {})
        return
      }
      if (payload.to !== viewerId) return
      if (payload.kind === 'offer') {
        const peer = new RTCPeerConnection(peerConfig); peers.current.set('host', peer)
        peer.ontrack = e => { if (videoRef.current && e.streams[0]) { videoRef.current.srcObject = e.streams[0]; if (stateRef.current && !stateRef.current.paused) videoRef.current.play().catch(() => setMessage('Tap play to allow playback in this browser.')) } }
        peer.onconnectionstatechange = () => setConnection(peer.connectionState === 'connected' ? 'connected' : peer.connectionState === 'failed' ? 'offline' : 'connecting')
        peer.onicecandidate = e => e.candidate && busRef.current?.send({ type: 'webrtc-signal', payload: { kind: 'candidate', from: viewerId, to: payload.from, candidate: e.candidate } })
        await peer.setRemoteDescription(payload.offer); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer)
        await busRef.current?.send({ type: 'webrtc-signal', payload: { kind: 'answer', from: viewerId, to: payload.from, answer } })
      } else if (payload.kind === 'candidate') await peers.current.get('host')?.addIceCandidate(payload.candidate).catch(() => {})
    }
    const bus = new RoomBus(room.id, handler); busRef.current = bus
    bus.connect().then(() => { setConnection('connected'); if (isHost) bus.send({ type: 'host-status', online: true }); if (!isHost) { bus.send({ type: 'request-sync' }); bus.send({ type: 'webrtc-signal', payload: { kind: 'viewer-ready', from: viewerId } }) } })
    const announceOffline = () => { if (isHost) void bus.send({ type: 'host-status', online: false }) }; window.addEventListener('beforeunload', announceOffline)
    const interval = window.setInterval(() => isHost && stateRef.current && bus.send({ type: 'playback', state: { ...stateRef.current, updatedAt: Date.now() } }), 3000)
    return () => { window.clearInterval(interval); window.removeEventListener('beforeunload', announceOffline); peers.current.forEach(p => p.close()); bus.close() }
  }, [room.id, isHost, viewerId, makePeer])
  const pickFile = (file?: File) => { if (!file) return; const url = URL.createObjectURL(file); setFileName(file.name); setFileUrl(url); const video = videoRef.current; if (video) { video.src = url; video.load() } }
  const copyLink = async () => { await navigator.clipboard?.writeText(viewerLink); setCopied(true); setTimeout(() => setCopied(false), 1800) }
  const selectSource = () => { if (room.mode === 'file') return <label className="file-picker"><Upload size={18} /><span>{fileName || 'Choose a video file'}</span><input type="file" accept="video/*" onChange={e => pickFile(e.target.files?.[0])} /></label>; return null }
  return <section className="room-page"><div className="room-head"><div><button className="back" onClick={onExit}>← New room</button><div className="room-title"><span className="room-pill">{isHost ? 'HOST' : 'VIEWER'}</span><span>Room <b>{room.id}</b></span></div></div><div className="room-actions"><span className={`status ${connection}`}><i /> {connection === 'connected' ? 'Connected' : connection === 'offline' ? 'Host offline' : 'Connecting'}</span><button className="button subtle" onClick={copyLink}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy viewer link'}</button></div></div><div className="player-wrap"><div className="video-shell">{room.mode === 'file' && !fileUrl && isHost ? <div className="empty-player"><div className="empty-player-icon"><Upload /></div><h2>Choose a local video</h2><p>The file stays on this device. Once selected, viewers receive a direct browser stream.</p>{selectSource()}</div> : <VideoPlayer videoRef={videoRef} src={room.mode === 'url' ? room.sourceUrl : fileUrl} isHost={isHost} onError={() => setMessage('This video could not be played. Check that the URL is public, supports browser playback, and allows range requests.')} />}</div><aside className="room-sidebar"><div className="sidebar-section"><div className="side-label">ROOM ACCESS</div><div className="link-card"><Link2 size={16} /><span>{viewerLink.replace(/^https?:\/\//, '')}</span><button onClick={copyLink}><Copy size={15} /></button></div><p className="side-hint">Share this link with viewers. It grants playback access, never control.</p></div><div className="sidebar-section"><div className="side-label">{isHost ? 'HOST CONTROLS' : 'PLAYBACK'}</div>{isHost ? <><p className="side-hint">Your timeline is authoritative. Every play, pause, seek, and speed change is shared automatically.</p>{room.mode === 'file' && fileUrl && <><div className="selected-file"><Film size={16} /><span>{fileName}</span></div>{selectSource()}</>}</> : <><div className="viewer-lock"><ShieldCheck size={17} /><span>Viewer mode</span></div><p className="side-hint">Playback follows the host. Your controls are disabled to keep everyone together.</p></>}</div>{room.mode === 'file' && <div className="warning"><strong><WifiOff size={15} /> Local stream</strong><span>The host browser and selected file must stay open. Restrictive networks may need TURN relay support.</span></div>}{message && <div className="message">{message}</div>}</aside></div><div className="room-footer"><span><span className="live-dot" /> {isHost ? 'You are hosting' : 'Following host timeline'}</span><span>Room expires {new Date(room.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div></section>
}

function VideoPlayer({ videoRef, src, isHost, onError }: { videoRef: React.RefObject<HTMLVideoElement | null>; src?: string; isHost: boolean; onError: () => void }) {
  const [playing, setPlaying] = useState(false); const [current, setCurrent] = useState(0); const [duration, setDuration] = useState(0); const [volume, setVolume] = useState(1); const [muted, setMuted] = useState(false); const [speed, setSpeed] = useState(1); const [showSpeed, setShowSpeed] = useState(false); const playerRef = useRef<HTMLDivElement>(null)
  const video = videoRef.current
  useEffect(() => { const element = videoRef.current; if (!element) return; const update = () => { setPlaying(!element.paused); setCurrent(element.currentTime); setDuration(element.duration || 0) }; element.addEventListener('timeupdate', update); element.addEventListener('loadedmetadata', update); element.addEventListener('durationchange', update); element.addEventListener('play', update); element.addEventListener('pause', update); update(); return () => { element.removeEventListener('timeupdate', update); element.removeEventListener('loadedmetadata', update); element.removeEventListener('durationchange', update); element.removeEventListener('play', update); element.removeEventListener('pause', update) } }, [src])
  const togglePlay = () => { const element = videoRef.current; if (!element) return; element.paused ? element.play().catch(() => {}) : element.pause() }
  const seek = (value: number) => { const element = videoRef.current; if (element && Number.isFinite(value)) { element.currentTime = value; setCurrent(value) } }
  const changeSpeed = (value: number) => { const element = videoRef.current; if (element) element.playbackRate = value; setSpeed(value); setShowSpeed(false) }
  const changeVolume = (value: number) => { const element = videoRef.current; if (element) { element.volume = value; element.muted = value === 0; } setVolume(value); setMuted(value === 0) }
  const toggleMute = () => { const element = videoRef.current; if (!element) return; element.muted = !element.muted; setMuted(element.muted) }
  const fullscreen = () => { if (document.fullscreenElement) document.exitFullscreen(); else playerRef.current?.requestFullscreen() }
  return <div className={`custom-player ${playing ? 'is-playing' : ''} ${isHost ? 'host-player' : 'viewer-player'}`} ref={playerRef}>
    <video ref={videoRef as React.RefObject<HTMLVideoElement>} src={src} onError={onError} playsInline className="video" onClick={isHost ? togglePlay : undefined} />
    {isHost && <div className="player-vignette" />}
    <div className="player-controls">
      <input className="seekbar" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(current, duration || 0)} onChange={e => seek(Number(e.target.value))} disabled={!isHost || !duration} aria-label="Video progress" />
      <div className="controls-row"><div className="controls-left"><button className="player-button main-control" onClick={togglePlay} disabled={!isHost} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>{isHost && <><button className="player-button desktop-only" onClick={() => seek(Math.max(0, current - 10))} aria-label="Back 10 seconds"><SkipBack size={16} /></button><button className="player-button desktop-only" onClick={() => seek(Math.min(duration, current + 10))} aria-label="Forward 10 seconds"><SkipForward size={16} /></button></>}<span className="timecode">{formatTime(current)} <i>/</i> {formatTime(duration)}</span></div><div className="controls-right"><button className="player-button" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>{muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>{isHost && <input className="volume-slider" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={e => changeVolume(Number(e.target.value))} aria-label="Volume" />}<div className="speed-wrap">{isHost && <button className="player-button speed-button" onClick={() => setShowSpeed(!showSpeed)}><Settings size={16} /><span>{speed}×</span></button>}{showSpeed && <div className="speed-menu">{[0.5, 1, 1.25, 1.5, 2].map(value => <button key={value} className={speed === value ? 'active' : ''} onClick={() => changeSpeed(value)}>{value}×</button>)}</div>}</div><button className="player-button" onClick={fullscreen} aria-label="Fullscreen"><Maximize size={17} /></button></div></div>
    </div>
    {!isHost && <div className="viewer-overlay"><span><ShieldCheck size={14} /> Following host</span></div>}
  </div>
}

function formatTime(value: number) { if (!Number.isFinite(value) || value < 0) return '0:00'; const total = Math.floor(value); const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const seconds = total % 60; return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds).padStart(2, '0')}` }

function EmptyState({ icon, title, copy, action }: { icon: React.ReactNode; title: string; copy: string; action: React.ReactNode }) { return <div className="empty-state"><span className="empty-icon">{icon}</span><h1>{title}</h1><p>{copy}</p>{action}</div> }
export default App
