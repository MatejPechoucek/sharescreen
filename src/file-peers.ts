import {
  fileInfo,
  RemoteFile,
  serveFile,
  type FileInfo,
} from "./file-transfer";

type Signal = {
  kind: "ready" | "offer" | "answer" | "ice";
  from: string;
  to?: string;
  session: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};
type Peer = {
  pc: RTCPeerConnection;
  session: string;
  channel?: RTCDataChannel;
  serve?: ReturnType<typeof serveFile>;
  remote?: RemoteFile;
  candidates: RTCIceCandidateInit[];
};

export class FilePeers {
  private peers = new Map<string, Peer>();
  private source: { file: File; info: FileInfo } | null = null;
  private session = crypto.randomUUID();
  private attemptStarted = Date.now();
  private closed = false;
  private queue = Promise.resolve();
  private iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
  ];
  private iceReady: Promise<void>;
  constructor(
    private options: {
      id: string;
      isHost: boolean;
      send: (payload: Signal) => void;
      onFile: (remote: RemoteFile, info: FileInfo) => void;
      onProgress: (bytes: number) => void;
      onStatus: (status: string) => void;
      onError: (message: string) => void;
    },
  ) {
    this.iceReady = fetch("/api/ice")
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json();
        if (!Array.isArray(payload.iceServers)) return;
        const servers = payload.iceServers.filter(
          (server: unknown): server is RTCIceServer =>
            Boolean(
              server &&
                typeof server === "object" &&
                (typeof (server as RTCIceServer).urls === "string" ||
                  Array.isArray((server as RTCIceServer).urls)),
            ),
        );
        if (servers.length) this.iceServers = servers;
      })
      .catch(() => {
        // Direct P2P with the bundled STUN server remains available.
      });
  }
  setFile(file: File) {
    this.source = { file, info: fileInfo(file) };
    this.peers.forEach((peer) => peer.serve?.announce());
  }
  async tick() {
    await this.iceReady;
    if (this.closed || this.options.isHost) return;
    if (
      [...this.peers.values()].some(
        (p) =>
          p.pc.connectionState === "connected" &&
          p.channel?.readyState === "open",
      )
    )
      return;
    if (Date.now() - this.attemptStarted > 15000) {
      this.peers.forEach((peer) => this.dispose(peer));
      this.peers.clear();
      this.session = crypto.randomUUID();
      this.attemptStarted = Date.now();
    }
    this.options.send({
      kind: "ready",
      from: this.options.id,
      session: this.session,
    });
  }
  signal(payload: unknown) {
    const message = payload as Signal;
    if (
      !message ||
      typeof message.from !== "string" ||
      typeof message.session !== "string" ||
      message.from === this.options.id ||
      (message.to && message.to !== this.options.id)
    )
      return;
    this.queue = this.queue
      .then(() => this.handle(message))
      .catch((error) => {
        if (!this.closed)
          this.options.onError(`File connection: ${String(error)}`);
      });
  }
  private create(id: string, session: string) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = { pc, session, candidates: [] };
    this.peers.set(id, peer);
    pc.onicecandidate = (event) => {
      if (event.candidate && !this.closed)
        this.options.send({
          kind: "ice",
          from: this.options.id,
          to: id,
          session,
          candidate: event.candidate.toJSON(),
        });
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      )
        this.options.onStatus("Connection interrupted. Retrying…");
    };
    const attach = (channel: RTCDataChannel) => {
      peer.channel = channel;
      if (this.options.isHost)
        peer.serve = serveFile(channel, () => this.source);
      else {
        const remote = new RemoteFile(
          channel,
          (info) => this.options.onFile(remote, info),
          this.options.onProgress,
        );
        peer.remote = remote;
      }
      channel.onopen = () =>
        this.options.onStatus(
          this.options.isHost
            ? "Sending original file on demand"
            : "Connected to host · waiting for file",
        );
      channel.onclose = () => {
        if (this.peers.get(id) === peer) this.peers.delete(id);
        peer.serve?.close();
        peer.pc.close();
        if (!this.closed && !this.options.isHost) {
          this.attemptStarted = 0;
          this.options.onStatus("Host disconnected. Reconnecting…");
        }
      };
    };
    if (this.options.isHost)
      attach(pc.createDataChannel("original-file-v1", { ordered: true }));
    else pc.ondatachannel = (event) => attach(event.channel);
    return peer;
  }
  private async handle(message: Signal) {
    if (this.closed) return;
    await this.iceReady;
    const { isHost, id } = this.options;
    let peer = this.peers.get(message.from);
    if (isHost && message.kind === "ready") {
      if (peer && peer.session !== message.session) {
        this.dispose(peer);
        this.peers.delete(message.from);
        peer = undefined;
      }
      if (!peer) {
        peer = this.create(message.from, message.session);
        await peer.pc.setLocalDescription(await peer.pc.createOffer());
      }
      if (peer.pc.localDescription)
        this.options.send({
          kind: "offer",
          from: id,
          to: message.from,
          session: message.session,
          description: peer.pc.localDescription.toJSON(),
        });
      return;
    }
    if (!isHost && message.session !== this.session) return;
    if (
      !isHost &&
      message.kind === "offer" &&
      message.description?.type === "offer"
    ) {
      if (!peer) peer = this.create(message.from, message.session);
      if (!peer.pc.remoteDescription) {
        await peer.pc.setRemoteDescription(message.description);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        for (const candidate of peer.candidates.splice(0))
          await peer.pc.addIceCandidate(candidate);
      }
      this.options.send({
        kind: "answer",
        from: id,
        to: message.from,
        session: message.session,
        description: peer.pc.localDescription!.toJSON(),
      });
      return;
    }
    // ICE can arrive before SDP; create a receiver placeholder and queue candidates.
    if (!peer && !isHost && message.kind === "ice")
      peer = this.create(message.from, message.session);
    if (!peer || peer.session !== message.session) return;
    if (
      isHost &&
      message.kind === "answer" &&
      message.description?.type === "answer" &&
      !peer.pc.remoteDescription
    ) {
      await peer.pc.setRemoteDescription(message.description);
      for (const candidate of peer.candidates.splice(0))
        await peer.pc.addIceCandidate(candidate);
    } else if (message.kind === "ice" && message.candidate) {
      if (peer.pc.remoteDescription)
        await peer.pc.addIceCandidate(message.candidate);
      else if (peer.candidates.length < 100)
        peer.candidates.push(message.candidate);
    }
  }
  private dispose(peer: Peer) {
    peer.serve?.close();
    peer.remote?.cancelAll();
    peer.channel?.close();
    peer.pc.close();
  }
  close() {
    this.closed = true;
    this.peers.forEach((peer) => this.dispose(peer));
    this.peers.clear();
  }
}
