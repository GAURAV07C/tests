const RTC_CONFIGURATION = {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
};
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function isInboundControlMessage(payload) {
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
        return (isFiniteNumber(payload.x) &&
            isFiniteNumber(payload.y) &&
            isFiniteNumber(payload.button));
    }
    if (payload.type === "scroll") {
        return isFiniteNumber(payload.deltaX) && isFiniteNumber(payload.deltaY);
    }
    if (payload.type === "toggle-camera" || payload.type === "toggle-mic") {
        return true;
    }
    return false;
}
export class WebRtcManager {
    options;
    peerConnection = null;
    controlChannel = null;
    screenSenders = [];
    cameraSenders = [];
    localScreenStream = null;
    localCameraStream = null;
    streamKinds = new Map();
    pendingRemoteStreams = new Map();
    pendingIceCandidates = [];
    isNegotiating = false;
    hasQueuedRenegotiation = false;
    constructor(options) {
        this.options = options;
    }
    hasLocalScreenStream() {
        return Boolean(this.localScreenStream);
    }
    hasLocalCameraStream() {
        return Boolean(this.localCameraStream);
    }
    isLocalCameraEnabled() {
        if (!this.localCameraStream) {
            return false;
        }
        const tracks = this.localCameraStream.getVideoTracks();
        return tracks.length > 0 && tracks.some((track) => track.enabled);
    }
    isLocalMicrophoneEnabled() {
        if (!this.localCameraStream) {
            return false;
        }
        const tracks = this.localCameraStream.getAudioTracks();
        return tracks.length > 0 && tracks.some((track) => track.enabled);
    }
    setLocalCameraEnabled(enabled) {
        if (!this.localCameraStream) {
            return false;
        }
        const tracks = this.localCameraStream.getVideoTracks();
        if (tracks.length === 0) {
            return false;
        }
        for (const track of tracks) {
            track.enabled = enabled;
        }
        return true;
    }
    setLocalMicrophoneEnabled(enabled) {
        if (!this.localCameraStream) {
            return false;
        }
        const tracks = this.localCameraStream.getAudioTracks();
        if (tracks.length === 0) {
            return false;
        }
        for (const track of tracks) {
            track.enabled = enabled;
        }
        return true;
    }
    isLocalCameraMediaActive() {
        if (!this.localCameraStream) {
            return false;
        }
        return this.localCameraStream.getTracks().some((track) => track.enabled);
    }
    setRemoteStreamKind(streamId, kind) {
        this.streamKinds.set(streamId, kind);
        const pendingStream = this.pendingRemoteStreams.get(streamId);
        if (!pendingStream) {
            return;
        }
        this.pendingRemoteStreams.delete(streamId);
        this.applyRemoteStream(kind, pendingStream);
    }
    async startScreenShare() {
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
    async stopScreenShare() {
        this.removeSenders(this.screenSenders);
        this.screenSenders = [];
        this.stopStream(this.localScreenStream);
        this.localScreenStream = null;
        if (this.peerConnection && this.options.roleProvider() === "client") {
            await this.negotiateAsClient();
        }
    }
    async startCameraStream() {
        if (this.options.roleProvider() !== "client") {
            throw new Error("Only client can start camera and microphone.");
        }
        if (!window.isSecureContext) {
            throw new Error("Camera and microphone require HTTPS or localhost.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
        });
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
    async stopCameraStream() {
        this.removeSenders(this.cameraSenders);
        this.cameraSenders = [];
        this.stopStream(this.localCameraStream);
        this.localCameraStream = null;
        if (this.peerConnection && this.options.roleProvider() === "client") {
            await this.negotiateAsClient();
        }
    }
    async rebuildAfterReconnect() {
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
    async handleSignal(signal) {
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
        }
        else {
            this.pendingIceCandidates.push(signal.candidate);
        }
    }
    sendControlMessage(message) {
        if (this.options.roleProvider() !== "host") {
            return false;
        }
        if (!this.controlChannel || this.controlChannel.readyState !== "open") {
            return false;
        }
        const senderUserId = this.options.localUserIdProvider();
        if (!senderUserId) {
            return false;
        }
        let payload;
        if (message.type === "scroll") {
            payload = {
                type: "scroll",
                deltaX: message.deltaX,
                deltaY: message.deltaY,
                senderUserId,
            };
        }
        else if (message.type === "click") {
            payload = {
                type: "click",
                x: clamp(message.x, 0, 1),
                y: clamp(message.y, 0, 1),
                button: message.button,
                senderUserId,
            };
        }
        else if (message.type === "toggle-camera") {
            payload = {
                type: "toggle-camera",
                senderUserId,
            };
        }
        else if (message.type === "toggle-mic") {
            payload = {
                type: "toggle-mic",
                senderUserId,
            };
        }
        else {
            payload = {
                type: "mousemove",
                x: clamp(message.x, 0, 1),
                y: clamp(message.y, 0, 1),
                senderUserId,
            };
        }
        this.controlChannel.send(JSON.stringify(payload));
        return true;
    }
    clearRemoteMedia() {
        this.streamKinds.clear();
        this.pendingRemoteStreams.clear();
        this.options.onRemoteScreenStream(null);
        this.options.onRemoteCameraStream(null);
    }
    clearForPeerDisconnect() {
        this.closePeerConnection(true);
        this.clearRemoteMedia();
        this.options.onControlChannelStatus(false);
    }
    resetSession() {
        this.closePeerConnection(false);
        this.pendingIceCandidates.length = 0;
        this.isNegotiating = false;
        this.hasQueuedRenegotiation = false;
        this.localScreenStream = null;
        this.localCameraStream = null;
        this.clearRemoteMedia();
        this.options.onControlChannelStatus(false);
    }
    ensurePeerConnection() {
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
            if (connection.connectionState === "failed" ||
                connection.connectionState === "disconnected" ||
                connection.connectionState === "closed") {
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
    attachControlChannel(channel) {
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
    handleControlMessage(rawData) {
        if (this.options.roleProvider() !== "client") {
            return;
        }
        if (typeof rawData !== "string") {
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(rawData);
        }
        catch {
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
        if (parsed.type === "toggle-camera" || parsed.type === "toggle-mic") {
            this.options.onRemoteMediaCommand(parsed.type);
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
    dispatchMouseEvent(type, x, y, button) {
        const target = document.elementFromPoint(x, y);
        if (!target) {
            return;
        }
        target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button,
        }));
    }
    applyRemoteStream(kind, stream) {
        if (kind === "screen") {
            this.options.onRemoteScreenStream(stream);
            return;
        }
        this.options.onRemoteCameraStream(stream);
    }
    async negotiateAsClient() {
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
        }
        finally {
            this.isNegotiating = false;
            if (this.hasQueuedRenegotiation) {
                this.hasQueuedRenegotiation = false;
                void this.negotiateAsClient();
            }
        }
    }
    replaceOutgoingScreenStream(connection, stream) {
        this.removeSenders(this.screenSenders);
        this.stopStream(this.localScreenStream);
        this.localScreenStream = stream;
        this.screenSenders = stream
            .getTracks()
            .map((track) => connection.addTrack(track, stream));
    }
    replaceOutgoingCameraStream(connection, stream) {
        this.removeSenders(this.cameraSenders);
        this.stopStream(this.localCameraStream);
        this.localCameraStream = stream;
        this.cameraSenders = stream
            .getTracks()
            .map((track) => connection.addTrack(track, stream));
    }
    addLocalTracksToConnection(connection) {
        this.screenSenders = [];
        this.cameraSenders = [];
        if (this.localScreenStream) {
            this.screenSenders = this.localScreenStream
                .getTracks()
                .map((track) => connection.addTrack(track, this.localScreenStream));
            this.options.onLocalStreamKind(this.localScreenStream.id, "screen");
        }
        if (this.localCameraStream) {
            this.cameraSenders = this.localCameraStream
                .getTracks()
                .map((track) => connection.addTrack(track, this.localCameraStream));
            this.options.onLocalStreamKind(this.localCameraStream.id, "camera");
        }
    }
    removeSenders(senders) {
        if (!this.peerConnection) {
            return;
        }
        for (const sender of senders) {
            try {
                this.peerConnection.removeTrack(sender);
            }
            catch {
                // Ignore removeTrack failures for stale senders.
            }
        }
    }
    closePeerConnection(preserveLocalStreams) {
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
    stopStream(stream) {
        if (!stream) {
            return;
        }
        for (const track of stream.getTracks()) {
            track.stop();
        }
    }
    async flushPendingIceCandidates(connection) {
        if (!connection.remoteDescription) {
            return;
        }
        const queued = [...this.pendingIceCandidates];
        this.pendingIceCandidates.length = 0;
        for (const candidate of queued) {
            try {
                await connection.addIceCandidate(candidate);
            }
            catch {
                // Ignore stale candidates.
            }
        }
    }
}
