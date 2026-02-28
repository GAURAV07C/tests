import { AppUI } from "./ui.js";
import { WebRtcManager, } from "./webrtc.js";
const STORAGE = {
    userId: "remote_support_user_id",
    roomId: "remote_support_room_id",
    role: "remote_support_role",
    cameraApproved: "remote_support_camera_approved",
};
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isRole(value) {
    return value === "host" || value === "client";
}
function isRoomState(value) {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.id !== "string" ||
        typeof value.hostUserId !== "string" ||
        typeof value.controlActive !== "boolean" ||
        typeof value.cameraActive !== "boolean") {
        return false;
    }
    if (value.clientUserId !== undefined && typeof value.clientUserId !== "string") {
        return false;
    }
    if (value.hostSocketId !== undefined && typeof value.hostSocketId !== "string") {
        return false;
    }
    if (value.clientSocketId !== undefined && typeof value.clientSocketId !== "string") {
        return false;
    }
    return true;
}
function isRoomEnvelope(value) {
    return isRecord(value) && isRoomState(value.room);
}
function isRoleRoomEnvelope(value) {
    return isRecord(value) && isRoomState(value.room) && isRole(value.role);
}
function isErrorEnvelope(value) {
    return isRecord(value) && typeof value.message === "string";
}
function isSignal(value) {
    if (!isRecord(value) || typeof value.type !== "string") {
        return false;
    }
    if (value.type === "offer" || value.type === "answer") {
        return typeof value.sdp === "string" && value.sdp.length > 0;
    }
    if (value.type === "ice-candidate") {
        return isRecord(value.candidate) && typeof value.candidate.candidate === "string";
    }
    return false;
}
function isSignalEnvelope(value) {
    return (isRecord(value) &&
        typeof value.roomId === "string" &&
        typeof value.fromUserId === "string" &&
        isSignal(value.signal));
}
function isMediaKindEnvelope(value) {
    return (isRecord(value) &&
        typeof value.roomId === "string" &&
        typeof value.streamId === "string" &&
        (value.kind === "screen" || value.kind === "camera"));
}
function isCameraRequestEnvelope(value) {
    return (isRecord(value) &&
        typeof value.roomId === "string" &&
        typeof value.hostUserId === "string");
}
function isCameraPermissionEnvelope(value) {
    return (isRecord(value) &&
        typeof value.roomId === "string" &&
        typeof value.granted === "boolean");
}
function isPeerDisconnectEnvelope(value) {
    return (isRecord(value) &&
        typeof value.roomId === "string" &&
        isRole(value.role));
}
function isPeerReconnectEnvelope(value) {
    return (isRecord(value) &&
        typeof value.roomId === "string" &&
        isRole(value.role) &&
        (value.userId === undefined || typeof value.userId === "string"));
}
function isIdentifyResult(value) {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.userId !== "string" || typeof value.restored !== "boolean") {
        return false;
    }
    if (value.role !== undefined && !isRole(value.role)) {
        return false;
    }
    if (value.room !== undefined && !isRoomState(value.room)) {
        return false;
    }
    return true;
}
function errorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return "Unknown error";
}
function normalizePointer(event, element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return {
        x: Math.min(Math.max(x, 0), 1),
        y: Math.min(Math.max(y, 0), 1),
    };
}
function getOrCreateUserId() {
    const storedUserId = localStorage.getItem(STORAGE.userId);
    if (storedUserId && storedUserId.length >= 10) {
        return storedUserId;
    }
    const userId = crypto.randomUUID();
    localStorage.setItem(STORAGE.userId, userId);
    return userId;
}
function loadStoredSession() {
    const roomId = localStorage.getItem(STORAGE.roomId);
    const role = localStorage.getItem(STORAGE.role);
    if (!roomId || !/^\d{6}$/.test(roomId) || !isRole(role)) {
        return null;
    }
    return { roomId, role };
}
function persistSession(roomId, role) {
    localStorage.setItem(STORAGE.roomId, roomId);
    localStorage.setItem(STORAGE.role, role);
}
function clearPersistedSession() {
    localStorage.removeItem(STORAGE.roomId);
    localStorage.removeItem(STORAGE.role);
}
function readBooleanFlag(key) {
    return localStorage.getItem(key) === "true";
}
function writeBooleanFlag(key, value) {
    localStorage.setItem(key, value ? "true" : "false");
}
function registerServiceWorker(ui) {
    if (!("serviceWorker" in navigator)) {
        return;
    }
    let hasRefreshed = false;
    window.addEventListener("load", () => {
        void (async () => {
            try {
                const registration = await navigator.serviceWorker.register("/service-worker.js", { type: "module" });
                await registration.update();
                if (registration.waiting) {
                    registration.waiting.postMessage({ type: "SKIP_WAITING" });
                }
                registration.addEventListener("updatefound", () => {
                    const installingWorker = registration.installing;
                    if (!installingWorker) {
                        return;
                    }
                    installingWorker.addEventListener("statechange", () => {
                        if (installingWorker.state === "installed" &&
                            navigator.serviceWorker.controller &&
                            registration.waiting) {
                            registration.waiting.postMessage({ type: "SKIP_WAITING" });
                        }
                    });
                });
                navigator.serviceWorker.addEventListener("controllerchange", () => {
                    if (hasRefreshed) {
                        return;
                    }
                    hasRefreshed = true;
                    window.location.reload();
                });
                ui.showToast("PWA ready for install.", "success");
            }
            catch (error) {
                ui.showToast(`Service worker failed: ${errorMessage(error)}`, "error");
            }
        })();
    });
}
const ui = new AppUI();
ui.closeCameraModal();
const socket = io({
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
});
const state = {
    userId: getOrCreateUserId(),
    role: null,
    room: null,
    reconnecting: false,
    pendingSession: loadStoredSession(),
    cameraPermissionApproved: readBooleanFlag(STORAGE.cameraApproved),
    cameraRequestPending: false,
};
const rtc = new WebRtcManager({
    roleProvider: () => state.role,
    localUserIdProvider: () => state.userId,
    hostUserIdProvider: () => state.room?.hostUserId ?? null,
    onSignal: (signal) => {
        if (!state.room) {
            return;
        }
        socket.emit("webrtc:signal", { roomId: state.room.id, signal });
    },
    onControlChannelStatus: (active) => {
        if (state.role === "host" && state.room) {
            socket.emit("control:status", { roomId: state.room.id, active });
        }
        if (state.role === "host") {
            ui.setControlActive(active);
        }
    },
    onRemoteScreenStream: (stream) => {
        ui.setScreenStream(stream);
    },
    onRemoteCameraStream: (stream) => {
        ui.setCameraStream(stream);
    },
    onRemoteMediaCommand: (command) => {
        if (state.role !== "client" || !state.room) {
            return;
        }
        if (command === "toggle-camera") {
            if (!rtc.hasLocalCameraStream()) {
                if (state.cameraRequestPending) {
                    return;
                }
                if (!state.cameraPermissionApproved) {
                    ui.showToast("Host requested camera. Please allow Camera + Voice once from request button.", "error");
                    return;
                }
                state.cameraRequestPending = true;
                refreshActionAvailability();
                const roomId = state.room.id;
                void (async () => {
                    try {
                        await rtc.startCameraStream();
                        socket.emit("camera:permission", { roomId, granted: true });
                        syncCameraStateWithLocalMedia();
                        ui.showToast("Host turned camera on.", "success");
                    }
                    catch (error) {
                        state.cameraPermissionApproved = false;
                        writeBooleanFlag(STORAGE.cameraApproved, false);
                        socket.emit("camera:permission", { roomId, granted: false });
                        socket.emit("camera:state", { roomId, active: false });
                        ui.showToast(`Host camera command failed: ${errorMessage(error)}`, "error");
                    }
                    finally {
                        state.cameraRequestPending = false;
                        refreshActionAvailability();
                    }
                })();
                return;
            }
            const nextEnabled = !rtc.isLocalCameraEnabled();
            if (!rtc.setLocalCameraEnabled(nextEnabled)) {
                ui.showToast("Host requested camera toggle but stream is not available.", "error");
                return;
            }
            syncCameraStateWithLocalMedia();
            refreshActionAvailability();
            ui.showToast(nextEnabled ? "Host turned camera on." : "Host turned camera off.");
            return;
        }
        const nextEnabled = !rtc.isLocalMicrophoneEnabled();
        if (!rtc.setLocalMicrophoneEnabled(nextEnabled)) {
            ui.showToast("Host requested mic toggle but stream is not available.", "error");
            return;
        }
        syncCameraStateWithLocalMedia();
        refreshActionAvailability();
        ui.showToast(nextEnabled ? "Host unmuted microphone." : "Host muted microphone.");
    },
    onLocalStreamKind: (streamId, kind) => {
        if (!state.room) {
            return;
        }
        socket.emit("media:kind", { roomId: state.room.id, streamId, kind });
    },
});
function refreshLocalMediaToggleState() {
    const hasLocalCameraStream = rtc.hasLocalCameraStream();
    const canToggle = socket.connected &&
        state.role === "client" &&
        hasLocalCameraStream &&
        !state.cameraRequestPending;
    ui.setToggleCameraState(canToggle, rtc.isLocalCameraEnabled());
    ui.setToggleMicState(canToggle, rtc.isLocalMicrophoneEnabled());
}
function refreshActionAvailability() {
    if (!socket.connected) {
        ui.setCreateRoomEnabled(false);
        ui.setJoinEnabled(false);
        ui.setStartShareEnabled(false);
        ui.setEnableCameraEnabled(false);
        ui.setRemoteMediaControlEnabled(false);
        refreshLocalMediaToggleState();
        return;
    }
    if (state.role === "host") {
        ui.setCreateRoomEnabled(false);
        ui.setJoinEnabled(false);
        ui.setStartShareEnabled(false);
        const hasClient = Boolean(state.room?.clientSocketId);
        ui.setEnableCameraEnabled(hasClient);
        ui.setRemoteMediaControlEnabled(hasClient);
        refreshLocalMediaToggleState();
        return;
    }
    if (state.role === "client") {
        ui.setCreateRoomEnabled(false);
        ui.setJoinEnabled(false);
        ui.setStartShareEnabled(true);
        ui.setEnableCameraEnabled(false);
        ui.setRemoteMediaControlEnabled(false);
        refreshLocalMediaToggleState();
        return;
    }
    ui.setCreateRoomEnabled(true);
    ui.setJoinEnabled(true);
    ui.setStartShareEnabled(false);
    ui.setEnableCameraEnabled(false);
    ui.setRemoteMediaControlEnabled(false);
    refreshLocalMediaToggleState();
}
function applyRoomState(room) {
    state.room = room;
    ui.setRoomCode(room.id);
    ui.setJoinInputValue(room.id);
    ui.setControlActive(room.controlActive);
    ui.setCameraActive(room.cameraActive);
    if (state.role) {
        persistSession(room.id, state.role);
        state.pendingSession = { roomId: room.id, role: state.role };
    }
    refreshActionAvailability();
}
function clearRoomState(clearStoredSession) {
    rtc.resetSession();
    state.role = null;
    state.room = null;
    state.cameraRequestPending = false;
    ui.setRole(null);
    ui.setRoomCode(null);
    ui.setControlActive(false);
    ui.setCameraActive(false);
    ui.setScreenStream(null);
    ui.setCameraStream(null);
    ui.closeCameraModal();
    if (clearStoredSession) {
        clearPersistedSession();
        state.pendingSession = null;
    }
    refreshActionAvailability();
}
function setRole(role) {
    state.role = role;
    ui.setRole(role);
}
function updateConnectionUi() {
    ui.setConnectionState(socket.connected, state.reconnecting);
    refreshActionAvailability();
}
async function handleSessionRecovery(room, role) {
    setRole(role);
    applyRoomState(room);
    try {
        await rtc.rebuildAfterReconnect();
    }
    catch (error) {
        ui.showToast(`Failed to rebuild WebRTC: ${errorMessage(error)}`, "error");
    }
}
async function attemptStoredRejoin() {
    if (!state.pendingSession) {
        return;
    }
    socket.emit("rejoin-room", {
        roomId: state.pendingSession.roomId,
        role: state.pendingSession.role,
    });
}
function syncCameraStateWithLocalMedia() {
    if (state.role !== "client" || !state.room) {
        return;
    }
    socket.emit("camera:state", {
        roomId: state.room.id,
        active: rtc.isLocalCameraMediaActive(),
    });
}
async function handleCameraRequest() {
    if (state.role !== "client" || !state.room) {
        return;
    }
    if (state.cameraRequestPending) {
        return;
    }
    state.cameraRequestPending = true;
    const roomId = state.room.id;
    let approved = state.cameraPermissionApproved;
    if (!approved) {
        approved = await ui.requestCameraApproval();
        state.cameraPermissionApproved = approved;
        writeBooleanFlag(STORAGE.cameraApproved, approved);
    }
    socket.emit("camera:permission", { roomId, granted: approved });
    if (!approved) {
        socket.emit("camera:state", { roomId, active: false });
        ui.showToast("Camera + voice request denied.");
        state.cameraRequestPending = false;
        refreshActionAvailability();
        return;
    }
    try {
        await rtc.startCameraStream();
        syncCameraStateWithLocalMedia();
        ui.showToast("Camera + voice stream started.", "success");
    }
    catch (error) {
        state.cameraPermissionApproved = false;
        writeBooleanFlag(STORAGE.cameraApproved, false);
        socket.emit("camera:permission", { roomId, granted: false });
        socket.emit("camera:state", { roomId, active: false });
        ui.showToast(`Camera + voice start failed: ${errorMessage(error)}`, "error");
    }
    state.cameraRequestPending = false;
    refreshActionAvailability();
}
ui.bindCreateRoom(() => {
    socket.emit("room:create");
});
ui.bindJoinRoom((rawRoomId) => {
    const roomId = rawRoomId.replace(/\D/g, "").slice(0, 6);
    if (!/^\d{6}$/.test(roomId)) {
        ui.showToast("Room code must be 6 digits.", "error");
        return;
    }
    socket.emit("room:join", { roomId });
});
ui.bindStartShare(() => {
    if (state.role !== "client" || !state.room) {
        return;
    }
    void (async () => {
        try {
            const stream = await rtc.startScreenShare();
            for (const track of stream.getTracks()) {
                track.addEventListener("ended", () => {
                    ui.showToast("Screen share stopped.");
                });
            }
            ui.showToast("Screen sharing started.", "success");
        }
        catch (error) {
            ui.showToast(`Screen share failed: ${errorMessage(error)}`, "error");
        }
    })();
});
ui.bindEnableCamera(() => {
    if (state.role !== "host" || !state.room) {
        return;
    }
    socket.emit("camera:request", { roomId: state.room.id });
});
function sendHostRemoteMediaCommand(command) {
    if (state.role !== "host") {
        return false;
    }
    return rtc.sendControlMessage({ type: command });
}
ui.bindRemoteToggleCamera(() => {
    if (sendHostRemoteMediaCommand("toggle-camera")) {
        ui.showToast("Remote camera toggle request sent.");
        return;
    }
    ui.showToast("Control channel not ready yet.", "error");
});
ui.bindRemoteToggleMic(() => {
    if (sendHostRemoteMediaCommand("toggle-mic")) {
        ui.showToast("Remote mic toggle request sent.");
        return;
    }
    ui.showToast("Control channel not ready yet.", "error");
});
ui.bindToggleCamera(() => {
    if (state.role !== "client" || !state.room) {
        return;
    }
    const nextEnabled = !rtc.isLocalCameraEnabled();
    if (!rtc.setLocalCameraEnabled(nextEnabled)) {
        ui.showToast("No camera track available.", "error");
        return;
    }
    syncCameraStateWithLocalMedia();
    refreshActionAvailability();
    ui.showToast(nextEnabled ? "Camera turned on." : "Camera turned off.");
});
ui.bindToggleMic(() => {
    if (state.role !== "client" || !state.room) {
        return;
    }
    const nextEnabled = !rtc.isLocalMicrophoneEnabled();
    if (!rtc.setLocalMicrophoneEnabled(nextEnabled)) {
        ui.showToast("No microphone track available.", "error");
        return;
    }
    syncCameraStateWithLocalMedia();
    refreshActionAvailability();
    ui.showToast(nextEnabled ? "Microphone unmuted." : "Microphone muted.");
});
const screenVideo = ui.getScreenVideoElement();
let lastMouseMoveAt = 0;
screenVideo.addEventListener("mousemove", (event) => {
    if (state.role !== "host") {
        return;
    }
    const now = performance.now();
    if (now - lastMouseMoveAt < 33) {
        return;
    }
    lastMouseMoveAt = now;
    const normalized = normalizePointer(event, screenVideo);
    if (!normalized) {
        return;
    }
    rtc.sendControlMessage({
        type: "mousemove",
        x: normalized.x,
        y: normalized.y,
    });
});
screenVideo.addEventListener("click", (event) => {
    if (state.role !== "host") {
        return;
    }
    const normalized = normalizePointer(event, screenVideo);
    if (!normalized) {
        return;
    }
    rtc.sendControlMessage({
        type: "click",
        x: normalized.x,
        y: normalized.y,
        button: event.button,
    });
});
screenVideo.addEventListener("wheel", (event) => {
    if (state.role !== "host") {
        return;
    }
    event.preventDefault();
    rtc.sendControlMessage({
        type: "scroll",
        deltaX: event.deltaX,
        deltaY: event.deltaY,
    });
}, { passive: false });
socket.on("connect", () => {
    state.reconnecting = false;
    updateConnectionUi();
    socket.emit("identify", { userId: state.userId });
    ui.showToast(`Connected (${socket.id}).`, "success");
});
socket.on("disconnect", () => {
    state.reconnecting = true;
    updateConnectionUi();
    ui.showToast("Connection lost. Reconnecting...", "error");
});
socket.on("identify:ok", (payload) => {
    if (!isIdentifyResult(payload)) {
        return;
    }
    if (payload.restored && payload.role && payload.room) {
        void handleSessionRecovery(payload.room, payload.role);
        ui.showToast(`Session restored as ${payload.role}.`, "success");
        return;
    }
    void attemptStoredRejoin();
});
socket.on("session:restored", (payload) => {
    if (!isRoleRoomEnvelope(payload)) {
        return;
    }
    void handleSessionRecovery(payload.room, payload.role);
});
socket.on("room:created", (payload) => {
    if (!isRoomEnvelope(payload)) {
        return;
    }
    setRole("host");
    applyRoomState(payload.room);
    ui.showToast(`Room ${payload.room.id} created.`, "success");
});
socket.on("room:joined", (payload) => {
    if (!isRoomEnvelope(payload)) {
        return;
    }
    setRole("client");
    applyRoomState(payload.room);
    ui.showToast(`Joined room ${payload.room.id}.`, "success");
});
socket.on("room:rejoined", (payload) => {
    if (!isRoleRoomEnvelope(payload)) {
        return;
    }
    void handleSessionRecovery(payload.room, payload.role);
    ui.showToast(`Rejoined room ${payload.room.id}.`, "success");
});
socket.on("room:client-joined", (payload) => {
    if (!isRoomEnvelope(payload) || state.role !== "host") {
        return;
    }
    applyRoomState(payload.room);
    ui.showToast("Client connected.", "success");
});
socket.on("room:update", (payload) => {
    if (!isRoomEnvelope(payload)) {
        return;
    }
    if (!state.room || payload.room.id !== state.room.id) {
        return;
    }
    applyRoomState(payload.room);
});
socket.on("webrtc:signal", (payload) => {
    if (!isSignalEnvelope(payload)) {
        return;
    }
    if (!state.room || payload.roomId !== state.room.id) {
        return;
    }
    void (async () => {
        try {
            await rtc.handleSignal(payload.signal);
        }
        catch (error) {
            ui.showToast(`WebRTC signaling failed: ${errorMessage(error)}`, "error");
        }
    })();
});
socket.on("media:kind", (payload) => {
    if (!isMediaKindEnvelope(payload)) {
        return;
    }
    if (state.role !== "host" || !state.room || payload.roomId !== state.room.id) {
        return;
    }
    rtc.setRemoteStreamKind(payload.streamId, payload.kind);
});
socket.on("camera:request", (payload) => {
    if (!isCameraRequestEnvelope(payload)) {
        return;
    }
    if (state.role !== "client" ||
        !state.room ||
        payload.roomId !== state.room.id ||
        state.room.clientUserId !== state.userId ||
        payload.hostUserId !== state.room.hostUserId ||
        payload.hostUserId === state.userId) {
        return;
    }
    void handleCameraRequest();
});
socket.on("camera:permission", (payload) => {
    if (!isCameraPermissionEnvelope(payload)) {
        return;
    }
    if (state.role !== "host" || !state.room || payload.roomId !== state.room.id) {
        return;
    }
    ui.showToast(payload.granted
        ? "Client approved camera + voice."
        : "Client denied camera + voice.", payload.granted ? "success" : "error");
});
socket.on("peer:disconnected", (payload) => {
    if (!isPeerDisconnectEnvelope(payload)) {
        return;
    }
    if (!state.room || payload.roomId !== state.room.id) {
        return;
    }
    rtc.clearForPeerDisconnect();
    ui.setControlActive(false);
    ui.setCameraActive(false);
    ui.setScreenStream(null);
    ui.setCameraStream(null);
    ui.showToast("Peer disconnected. Waiting for reconnect...", "error");
});
socket.on("peer:reconnected", (payload) => {
    if (!isPeerReconnectEnvelope(payload)) {
        return;
    }
    if (!state.room || payload.roomId !== state.room.id) {
        return;
    }
    void (async () => {
        try {
            await rtc.rebuildAfterReconnect();
            if (state.role === "client" &&
                (rtc.hasLocalScreenStream() || rtc.hasLocalCameraStream())) {
                ui.showToast("Restored local streams after reconnect.", "success");
            }
            else {
                ui.showToast("Peer reconnected.", "success");
            }
        }
        catch (error) {
            ui.showToast(`Reconnect media failed: ${errorMessage(error)}`, "error");
        }
    })();
});
socket.on("room:error", (payload) => {
    if (!isErrorEnvelope(payload)) {
        return;
    }
    if (payload.message.includes("Room not found for rejoin")) {
        clearPersistedSession();
        state.pendingSession = null;
        clearRoomState(true);
    }
    ui.showToast(payload.message, "error");
});
if (state.pendingSession) {
    ui.setJoinInputValue(state.pendingSession.roomId);
    ui.showToast("Stored session found. Will auto-rejoin when connected.");
}
clearRoomState(false);
updateConnectionUi();
registerServiceWorker(ui);
