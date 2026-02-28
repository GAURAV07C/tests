export type Role = "host" | "client";
export type StreamKind = "screen" | "camera";

export type WebRtcSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit };

type OutboundControlMessage =
  | { type: "mousemove"; x: number; y: number }
  | { type: "click"; x: number; y: number; button: number }
  | { type: "scroll"; deltaX: number; deltaY: number };

type InboundControlMessage =
  | {
      type: "mousemove";
      x: number;
      y: number;
      senderUserId: string;
    }
  | {
      type: "click";
      x: number;
      y: number;
      button: number;
      senderUserId: string;
    }
  | {
      type: "scroll";
      deltaX: number;
      deltaY: number;
      senderUserId: string;
    };

export interface WebRtcManagerOptions {
  roleProvider: () => Role | null;
  localUserIdProvider: () => string;
  hostUserIdProvider: () => string | null;
  onSignal: (signal: WebRtcSignal) => void;
  onControlChannelStatus: (active: boolean) => void;
  onRemoteScreenStream: (stream: MediaStream | null) => void;
  onRemoteCameraStream: (stream: MediaStream | null) => void;
  onLocalStreamKind: (streamId: string, kind: StreamKind) => void;
}

const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isInboundControlMessage(payload: unknown): payload is InboundControlMessage {
  if (!isRecord(payload) || typeof payload.type !== "string") {
    return false;
  }

  if (typeof payload.senderUserId !== "string" || payload.senderUserId.length < 10) {
    return false;
  }

  if (payload.type === "mousemove") {
    return isFiniteNumber(payload.x) && isFiniteNumber(payload.y);
  }

  if (payload.type === "click") {
    return (
      isFiniteNumber(payload.x) &&
      isFiniteNumber(payload.y) &&
      isFiniteNumber(payload.button)
    );
  }

  if (payload.type === "scroll") {
    return isFiniteNumber(payload.deltaX) && isFiniteNumber(payload.deltaY);
  }

  return false;
}

export class WebRtcManager {
  private peerConnection: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;

  private screenSenders: RTCRtpSender[] = [];
  private cameraSenders: RTCRtpSender[] = [];

  private localScreenStream: MediaStream | null = null;
  private localCameraStream: MediaStream | null = null;

  private readonly streamKinds = new Map<string, StreamKind>();
  private readonly pendingRemoteStreams = new Map<string, MediaStream>();
  private readonly pendingIceCandidates: RTCIceCandidateInit[] = [];

  private isNegotiating = false;
  private hasQueuedRenegotiation = false;

  constructor(private readonly options: WebRtcManagerOptions) {}

  public hasLocalScreenStream(): boolean {
    return Boolean(this.localScreenStream);
  }

  public hasLocalCameraStream(): boolean {
    return Boolean(this.localCameraStream);
  }

  public setRemoteStreamKind(streamId: string, kind: StreamKind): void {
    this.streamKinds.set(streamId, kind);

    const pendingStream = this.pendingRemoteStreams.get(streamId);
    if (!pendingStream) {
      return;
    }

    this.pendingRemoteStreams.delete(streamId);
    this.applyRemoteStream(kind, pendingStream);
  }

  public async startScreenShare(): Promise<MediaStream> {
    if (this.options.roleProvider() !== "client") {
      throw new Error("Only client can start screen sharing.");
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });

    const connection = this.ensurePeerConnection();
    this.replaceOutgoingScreenStream(connection, stream);
    this.options.onLocalStreamKind(stream.id, "screen");
    await this.negotiateAsClient();

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        void this.stopScreenShare();
      });
    }

    return stream;
  }

  public async stopScreenShare(): Promise<void> {
    this.removeSenders(this.screenSenders);
    this.screenSenders = [];
    this.stopStream(this.localScreenStream);
    this.localScreenStream = null;

    if (this.peerConnection && this.options.roleProvider() === "client") {
      await this.negotiateAsClient();
    }
  }

  public async startCameraStream(): Promise<MediaStream> {
    if (this.options.roleProvider() !== "client") {
      throw new Error("Only client can start camera.");
    }

    if (!window.isSecureContext) {
      throw new Error("Camera requires HTTPS or localhost.");
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
    } catch {
      // Fallback to video-only when audio permission/device fails.
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
    }

    const connection = this.ensurePeerConnection();
    this.replaceOutgoingCameraStream(connection, stream);
    this.options.onLocalStreamKind(stream.id, "camera");
    await this.negotiateAsClient();

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        void this.stopCameraStream();
      });
    }

    return stream;
  }

  public async stopCameraStream(): Promise<void> {
    this.removeSenders(this.cameraSenders);
    this.cameraSenders = [];
    this.stopStream(this.localCameraStream);
    this.localCameraStream = null;

    if (this.peerConnection && this.options.roleProvider() === "client") {
      await this.negotiateAsClient();
    }
  }

  public async rebuildAfterReconnect(): Promise<void> {
    this.closePeerConnection(true);

    const role = this.options.roleProvider();
    if (!role) {
      return;
    }

    const connection = this.ensurePeerConnection();

    if (role === "client") {
      this.addLocalTracksToConnection(connection);
      if (this.localScreenStream || this.localCameraStream) {
        await this.negotiateAsClient();
      }
    }
  }

  public async handleSignal(signal: WebRtcSignal): Promise<void> {
    const connection = this.ensurePeerConnection();

    if (signal.type === "offer") {
      await connection.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      await this.flushPendingIceCandidates(connection);

      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);

      if (!answer.sdp) {
        throw new Error("Unable to create answer.");
      }

      this.options.onSignal({ type: "answer", sdp: answer.sdp });
      return;
    }

    if (signal.type === "answer") {
      await connection.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      await this.flushPendingIceCandidates(connection);
      return;
    }

    if (connection.remoteDescription) {
      await connection.addIceCandidate(signal.candidate);
    } else {
      this.pendingIceCandidates.push(signal.candidate);
    }
  }

  public sendControlMessage(message: OutboundControlMessage): void {
    if (this.options.roleProvider() !== "host") {
      return;
    }

    if (!this.controlChannel || this.controlChannel.readyState !== "open") {
      return;
    }

    const senderUserId = this.options.localUserIdProvider();
    if (!senderUserId) {
      return;
    }

    const payload: InboundControlMessage =
      message.type === "scroll"
        ? {
            type: "scroll",
            deltaX: message.deltaX,
            deltaY: message.deltaY,
            senderUserId,
          }
        : message.type === "click"
          ? {
              type: "click",
              x: clamp(message.x, 0, 1),
              y: clamp(message.y, 0, 1),
              button: message.button,
              senderUserId,
            }
          : {
              type: "mousemove",
              x: clamp(message.x, 0, 1),
              y: clamp(message.y, 0, 1),
              senderUserId,
            };

    this.controlChannel.send(JSON.stringify(payload));
  }

  public clearRemoteMedia(): void {
    this.streamKinds.clear();
    this.pendingRemoteStreams.clear();
    this.options.onRemoteScreenStream(null);
    this.options.onRemoteCameraStream(null);
  }

  public clearForPeerDisconnect(): void {
    this.closePeerConnection(true);
    this.clearRemoteMedia();
    this.options.onControlChannelStatus(false);
  }

  public resetSession(): void {
    this.closePeerConnection(false);

    this.pendingIceCandidates.length = 0;
    this.isNegotiating = false;
    this.hasQueuedRenegotiation = false;

    this.localScreenStream = null;
    this.localCameraStream = null;

    this.clearRemoteMedia();
    this.options.onControlChannelStatus(false);
  }

  private ensurePeerConnection(): RTCPeerConnection {
    if (this.peerConnection) {
      return this.peerConnection;
    }

    const connection = new RTCPeerConnection(RTC_CONFIGURATION);

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      this.options.onSignal({
        type: "ice-candidate",
        candidate: event.candidate.toJSON(),
      });
    };

    connection.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) {
        return;
      }

      const streamKind = this.streamKinds.get(stream.id);
      if (!streamKind) {
        this.pendingRemoteStreams.set(stream.id, stream);
        return;
      }

      this.applyRemoteStream(streamKind, stream);
    };

    connection.ondatachannel = (event) => {
      this.attachControlChannel(event.channel);
    };

    connection.onconnectionstatechange = () => {
      if (
        connection.connectionState === "failed" ||
        connection.connectionState === "disconnected" ||
        connection.connectionState === "closed"
      ) {
        this.options.onControlChannelStatus(false);
      }
    };

    this.peerConnection = connection;

    if (this.options.roleProvider() === "client") {
      const dataChannel = connection.createDataChannel("remote-control", {
        ordered: true,
      });
      this.attachControlChannel(dataChannel);
    }

    return connection;
  }

  private attachControlChannel(channel: RTCDataChannel): void {
    this.controlChannel = channel;

    channel.onopen = () => {
      this.options.onControlChannelStatus(channel.readyState === "open");
    };

    channel.onclose = () => {
      this.options.onControlChannelStatus(false);
    };

    channel.onerror = () => {
      this.options.onControlChannelStatus(false);
    };

    channel.onmessage = (event) => {
      this.handleControlMessage(event.data);
    };

    if (channel.readyState === "open") {
      this.options.onControlChannelStatus(true);
    }
  }

  private handleControlMessage(rawData: unknown): void {
    if (this.options.roleProvider() !== "client") {
      return;
    }

    if (typeof rawData !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData) as unknown;
    } catch {
      return;
    }

    if (!isInboundControlMessage(parsed)) {
      return;
    }

    const hostUserId = this.options.hostUserIdProvider();
    if (!hostUserId || parsed.senderUserId !== hostUserId) {
      return;
    }

    if (parsed.type === "scroll") {
      window.scrollBy({ left: parsed.deltaX, top: parsed.deltaY, behavior: "auto" });
      return;
    }

    const point = {
      x: Math.round(clamp(parsed.x, 0, 1) * window.innerWidth),
      y: Math.round(clamp(parsed.y, 0, 1) * window.innerHeight),
    };

    if (parsed.type === "mousemove") {
      this.dispatchMouseEvent("mousemove", point.x, point.y, 0);
      return;
    }

    this.dispatchMouseEvent("mousedown", point.x, point.y, parsed.button);
    this.dispatchMouseEvent("mouseup", point.x, point.y, parsed.button);
    this.dispatchMouseEvent("click", point.x, point.y, parsed.button);
  }

  private dispatchMouseEvent(
    type: "mousemove" | "mousedown" | "mouseup" | "click",
    x: number,
    y: number,
    button: number,
  ): void {
    const target = document.elementFromPoint(x, y);
    if (!target) {
      return;
    }

    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button,
      }),
    );
  }

  private applyRemoteStream(kind: StreamKind, stream: MediaStream): void {
    if (kind === "screen") {
      this.options.onRemoteScreenStream(stream);
      return;
    }

    this.options.onRemoteCameraStream(stream);
  }

  private async negotiateAsClient(): Promise<void> {
    if (this.options.roleProvider() !== "client") {
      return;
    }

    const connection = this.ensurePeerConnection();

    if (this.isNegotiating) {
      this.hasQueuedRenegotiation = true;
      return;
    }

    this.isNegotiating = true;

    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      if (!offer.sdp) {
        throw new Error("Unable to create offer.");
      }

      this.options.onSignal({ type: "offer", sdp: offer.sdp });
    } finally {
      this.isNegotiating = false;

      if (this.hasQueuedRenegotiation) {
        this.hasQueuedRenegotiation = false;
        void this.negotiateAsClient();
      }
    }
  }

  private replaceOutgoingScreenStream(
    connection: RTCPeerConnection,
    stream: MediaStream,
  ): void {
    this.removeSenders(this.screenSenders);
    this.stopStream(this.localScreenStream);

    this.localScreenStream = stream;
    this.screenSenders = stream
      .getTracks()
      .map((track) => connection.addTrack(track, stream));
  }

  private replaceOutgoingCameraStream(
    connection: RTCPeerConnection,
    stream: MediaStream,
  ): void {
    this.removeSenders(this.cameraSenders);
    this.stopStream(this.localCameraStream);

    this.localCameraStream = stream;
    this.cameraSenders = stream
      .getTracks()
      .map((track) => connection.addTrack(track, stream));
  }

  private addLocalTracksToConnection(connection: RTCPeerConnection): void {
    this.screenSenders = [];
    this.cameraSenders = [];

    if (this.localScreenStream) {
      this.screenSenders = this.localScreenStream
        .getTracks()
        .map((track) => connection.addTrack(track, this.localScreenStream as MediaStream));
      this.options.onLocalStreamKind(this.localScreenStream.id, "screen");
    }

    if (this.localCameraStream) {
      this.cameraSenders = this.localCameraStream
        .getTracks()
        .map((track) => connection.addTrack(track, this.localCameraStream as MediaStream));
      this.options.onLocalStreamKind(this.localCameraStream.id, "camera");
    }
  }

  private removeSenders(senders: RTCRtpSender[]): void {
    if (!this.peerConnection) {
      return;
    }

    for (const sender of senders) {
      try {
        this.peerConnection.removeTrack(sender);
      } catch {
        // Ignore removeTrack failures for stale senders.
      }
    }
  }

  private closePeerConnection(preserveLocalStreams: boolean): void {
    if (this.controlChannel) {
      this.controlChannel.onopen = null;
      this.controlChannel.onclose = null;
      this.controlChannel.onerror = null;
      this.controlChannel.onmessage = null;
      this.controlChannel.close();
      this.controlChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null;
      this.peerConnection.ontrack = null;
      this.peerConnection.ondatachannel = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.screenSenders = [];
    this.cameraSenders = [];

    this.pendingIceCandidates.length = 0;
    this.isNegotiating = false;
    this.hasQueuedRenegotiation = false;

    if (!preserveLocalStreams) {
      this.stopStream(this.localScreenStream);
      this.stopStream(this.localCameraStream);
    }
  }

  private stopStream(stream: MediaStream | null): void {
    if (!stream) {
      return;
    }

    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  private async flushPendingIceCandidates(
    connection: RTCPeerConnection,
  ): Promise<void> {
    if (!connection.remoteDescription) {
      return;
    }

    const queued = [...this.pendingIceCandidates];
    this.pendingIceCandidates.length = 0;

    for (const candidate of queued) {
      try {
        await connection.addIceCandidate(candidate);
      } catch {
        // Ignore stale candidates.
      }
    }
  }
}
