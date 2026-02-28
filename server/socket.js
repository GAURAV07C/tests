import { attachSocket, canUserActAsClient, canUserControlRoom, createRoom, findRoomByUserId, getRoom, removeSocket, } from "./memoryStore.js";
const ROOM_ID_PATTERN = /^\d{6}$/;
const USER_ID_PATTERN = /^[a-z0-9-]{10,80}$/i;
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isRoomId(value) {
    return typeof value === "string" && ROOM_ID_PATTERN.test(value);
}
function isBoolean(value) {
    return typeof value === "boolean";
}
function isUserId(value) {
    return typeof value === "string" && USER_ID_PATTERN.test(value);
}
function isRole(value) {
    return value === "host" || value === "client";
}
function isIdentifyPayload(payload) {
    return isRecord(payload) && isUserId(payload.userId);
}
function isRoomJoinPayload(payload) {
    return isRecord(payload) && isRoomId(payload.roomId);
}
function isRejoinRoomPayload(payload) {
    return (isRecord(payload) && isRoomId(payload.roomId) && isRole(payload.role));
}
function isControlStatusPayload(payload) {
    return (isRecord(payload) && isRoomId(payload.roomId) && isBoolean(payload.active));
}
function isCameraRequestPayload(payload) {
    return isRecord(payload) && isRoomId(payload.roomId);
}
function isCameraPermissionPayload(payload) {
    return (isRecord(payload) &&
        isRoomId(payload.roomId) &&
        isBoolean(payload.granted));
}
function isCameraStatePayload(payload) {
    return (isRecord(payload) && isRoomId(payload.roomId) && isBoolean(payload.active));
}
function isMediaKindPayload(payload) {
    return (isRecord(payload) &&
        isRoomId(payload.roomId) &&
        typeof payload.streamId === "string" &&
        payload.streamId.length > 0 &&
        (payload.kind === "screen" || payload.kind === "camera"));
}
function isIceCandidatePayload(payload) {
    if (!isRecord(payload)) {
        return false;
    }
    if (typeof payload.candidate !== "string") {
        return false;
    }
    if (payload.sdpMid !== undefined &&
        payload.sdpMid !== null &&
        typeof payload.sdpMid !== "string") {
        return false;
    }
    if (payload.sdpMLineIndex !== undefined &&
        payload.sdpMLineIndex !== null &&
        typeof payload.sdpMLineIndex !== "number") {
        return false;
    }
    if (payload.usernameFragment !== undefined &&
        payload.usernameFragment !== null &&
        typeof payload.usernameFragment !== "string") {
        return false;
    }
    return true;
}
function isWebRtcSignal(payload) {
    if (!isRecord(payload) || typeof payload.type !== "string") {
        return false;
    }
    if (payload.type === "offer" || payload.type === "answer") {
        return typeof payload.sdp === "string" && payload.sdp.length > 0;
    }
    if (payload.type === "ice-candidate") {
        return isIceCandidatePayload(payload.candidate);
    }
    return false;
}
function isWebRtcSignalPayload(payload) {
    return (isRecord(payload) && isRoomId(payload.roomId) && isWebRtcSignal(payload.signal));
}
function emitError(socket, message) {
    socket.emit("room:error", { message });
}
function snapshotRoom(room) {
    return { ...room };
}
function getUserId(socket) {
    const raw = socket.data.userId;
    return typeof raw === "string" ? raw : null;
}
function isCurrentSocketForRole(room, role, socketId) {
    return role === "host"
        ? room.hostSocketId === socketId
        : room.clientSocketId === socketId;
}
function roleOfUserInRoom(room, userId) {
    if (room.hostUserId === userId) {
        return "host";
    }
    if (room.clientUserId === userId) {
        return "client";
    }
    return null;
}
function roomPeerSocketId(room, role) {
    const peerSocketId = role === "host" ? room.clientSocketId : room.hostSocketId;
    const selfSocketId = role === "host" ? room.hostSocketId : room.clientSocketId;
    if (!peerSocketId || peerSocketId === selfSocketId) {
        return undefined;
    }
    return peerSocketId;
}
function normalizeRoomState(room) {
    let changed = false;
    if (room.clientUserId && room.clientUserId === room.hostUserId) {
        delete room.clientUserId;
        changed = true;
    }
    if (room.clientSocketId && room.hostSocketId && room.clientSocketId === room.hostSocketId) {
        delete room.clientSocketId;
        changed = true;
    }
    if (!room.clientUserId && room.clientSocketId) {
        delete room.clientSocketId;
        changed = true;
    }
    if (changed) {
        room.controlActive = false;
        room.cameraActive = false;
    }
}
function socketUserIdBySocketId(io, socketId) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (!targetSocket) {
        return null;
    }
    return getUserId(targetSocket);
}
function emitRoomUpdate(io, room) {
    const payload = { room: snapshotRoom(room) };
    if (room.hostSocketId) {
        io.to(room.hostSocketId).emit("room:update", payload);
    }
    if (room.clientSocketId) {
        io.to(room.clientSocketId).emit("room:update", payload);
    }
}
function restoreSession(io, socket, room, role) {
    normalizeRoomState(room);
    attachSocket(room, role, socket.id);
    normalizeRoomState(room);
    socket.join(room.id);
    socket.emit("session:restored", {
        room: snapshotRoom(room),
        role,
    });
    const peerSocketId = roomPeerSocketId(room, role);
    if (peerSocketId) {
        io.to(peerSocketId).emit("peer:reconnected", {
            roomId: room.id,
            role,
            userId: getUserId(socket),
        });
    }
    emitRoomUpdate(io, room);
}
function ensureIdentified(socket) {
    const userId = getUserId(socket);
    if (!userId) {
        emitError(socket, "Identify first.");
        return null;
    }
    return userId;
}
export function registerSocketHandlers(io) {
    io.on("connection", (socket) => {
        socket.emit("socket:ready", { socketId: socket.id });
        socket.on("identify", (payload) => {
            if (!isIdentifyPayload(payload)) {
                emitError(socket, "Invalid identify payload.");
                return;
            }
            socket.data.userId = payload.userId;
            const match = findRoomByUserId(payload.userId);
            if (!match) {
                socket.emit("identify:ok", {
                    userId: payload.userId,
                    restored: false,
                });
                return;
            }
            restoreSession(io, socket, match.room, match.role);
            socket.emit("identify:ok", {
                userId: payload.userId,
                restored: true,
                role: match.role,
                room: snapshotRoom(match.room),
            });
        });
        socket.on("room:create", () => {
            const userId = ensureIdentified(socket);
            if (!userId) {
                return;
            }
            const existing = findRoomByUserId(userId);
            if (existing?.role === "host") {
                restoreSession(io, socket, existing.room, "host");
                socket.emit("room:created", { room: snapshotRoom(existing.room) });
                return;
            }
            if (existing?.role === "client") {
                emitError(socket, "Already joined another room as client.");
                return;
            }
            const room = createRoom(userId, socket.id);
            socket.join(room.id);
            socket.emit("room:created", { room: snapshotRoom(room) });
            emitRoomUpdate(io, room);
        });
        socket.on("room:join", (payload) => {
            if (!isRoomJoinPayload(payload)) {
                emitError(socket, "Invalid room join payload.");
                return;
            }
            const userId = ensureIdentified(socket);
            if (!userId) {
                return;
            }
            const room = getRoom(payload.roomId);
            if (!room) {
                emitError(socket, "Room not found.");
                return;
            }
            normalizeRoomState(room);
            const existingRoom = findRoomByUserId(userId);
            if (existingRoom && existingRoom.room.id !== room.id) {
                emitError(socket, "Already attached to another room.");
                return;
            }
            if (room.hostUserId === userId) {
                emitError(socket, "Host cannot join as client.");
                return;
            }
            if (room.clientUserId &&
                room.clientUserId !== userId &&
                room.clientSocketId) {
                emitError(socket, "Room already has a different client.");
                return;
            }
            room.clientUserId = userId;
            room.clientSocketId = socket.id;
            room.controlActive = false;
            room.cameraActive = false;
            socket.join(room.id);
            socket.emit("room:joined", { room: snapshotRoom(room) });
            if (room.hostSocketId) {
                io.to(room.hostSocketId).emit("room:client-joined", {
                    room: snapshotRoom(room),
                    clientUserId: userId,
                });
            }
            emitRoomUpdate(io, room);
        });
        socket.on("rejoin-room", (payload) => {
            if (!isRejoinRoomPayload(payload)) {
                emitError(socket, "Invalid rejoin payload.");
                return;
            }
            const userId = ensureIdentified(socket);
            if (!userId) {
                return;
            }
            const room = getRoom(payload.roomId);
            if (!room) {
                emitError(socket, "Room not found for rejoin.");
                return;
            }
            normalizeRoomState(room);
            if (payload.role === "host") {
                if (room.hostUserId !== userId) {
                    emitError(socket, "Only host owner can rejoin as host.");
                    return;
                }
            }
            else {
                if (room.hostUserId === userId) {
                    emitError(socket, "Host cannot rejoin as client.");
                    return;
                }
                if (!room.clientUserId) {
                    room.clientUserId = userId;
                }
                if (room.clientUserId !== userId) {
                    emitError(socket, "Only assigned client can rejoin as client.");
                    return;
                }
            }
            restoreSession(io, socket, room, payload.role);
            socket.emit("room:rejoined", {
                room: snapshotRoom(room),
                role: payload.role,
            });
        });
        socket.on("webrtc:signal", (payload) => {
            if (!isWebRtcSignalPayload(payload)) {
                emitError(socket, "Invalid WebRTC signal payload.");
                return;
            }
            const userId = ensureIdentified(socket);
            if (!userId) {
                return;
            }
            const room = getRoom(payload.roomId);
            if (!room) {
                emitError(socket, "Room not found for signaling.");
                return;
            }
            normalizeRoomState(room);
            const role = roleOfUserInRoom(room, userId);
            if (!role) {
                emitError(socket, "Unauthorized signaling attempt.");
                return;
            }
            if (!isCurrentSocketForRole(room, role, socket.id)) {
                emitError(socket, "Stale socket signaling rejected.");
                return;
            }
            const targetSocketId = roomPeerSocketId(room, role);
            if (!targetSocketId) {
                return;
            }
            io.to(targetSocketId).emit("webrtc:signal", {
                roomId: room.id,
                fromUserId: userId,
                signal: payload.signal,
            });
        });
        socket.on("control:status", (payload) => {
            if (!isControlStatusPayload(payload)) {
                emitError(socket, "Invalid control status payload.");
                return;
            }
            const userId = ensureIdentified(socket);
            if (!userId) {
                return;
            }
            const room = getRoom(payload.roomId);
            if (!room) {
                emitError(socket, "Room not found for control update.");
                return;
            }
            normalizeRoomState(room);
            if (!canUserControlRoom(room, userId) || room.hostSocketId !== socket.id) {
                emitError(socket, "Only active host can update control state.");
                return;
            }
            room.controlActive = payload.active && Boolean(room.clientSocketId);
            emitRoomUpdate(io, room);
        });
        socket.on("camera:request", (payload) => {
            if (!isCameraRequestPayload(payload)) {
                emitError(socket, "Invalid camera request payload.");
                return;
            }
            const userId = ensureIdentified(socket);
            if (!userId) {
                return;
            }
            const room = getRoom(payload.roomId);
            if (!room) {
                emitError(socket, "Room not found for camera request.");
                return;
            }
            normalizeRoomState(room);
            if (!canUserControlRoom(room, userId) || room.hostSocketId !== socket.id) {
                emitError(socket, "Only host can request camera.");
                return;
            }
            if (!room.clientSocketId) {
                emitError(socket, "No connected client available.");
                return;
            }
            const targetUserId = socketUserIdBySocketId(io, room.clientSocketId);
            if (!room.clientUserId ||
                !targetUserId ||
                targetUserId !== room.clientUserId ||
                targetUserId === room.hostUserId) {
                delete room.clientSocketId;
                if (room.clientUserId === room.hostUserId) {
                    delete room.clientUserId;
                }
                room.controlActive = false;
                room.cameraActive = false;
                emitRoomUpdate(io, room);
                emitError(socket, "No valid connected client available.");
                return;
            }
            io.to(room.clientSocketId).emit("camera:request", {
                roomId: room.id,
                hostUserId: room.hostUserId,
            });
        });
        socket.on("camera:permission", (payload) => {
            if (!isCameraPermissionPayload(payload)) {
                emitError(socket, "Invalid camera permission payload.");
                return;
            }
            const userId = ensureIdentified(socket);
            if (!userId) {
                return;
            }
            const room = getRoom(payload.roomId);
            if (!room) {
                emitError(socket, "Room not found for camera permission.");
                return;
            }
            normalizeRoomState(room);
            if (!canUserActAsClient(room, userId) || room.clientSocketId !== socket.id) {
                emitError(socket, "Only active client can report camera permission.");
                return;
            }
            if (!payload.granted) {
                room.cameraActive = false;
            }
            if (room.hostSocketId) {
                io.to(room.hostSocketId).emit("camera:permission", {
                    roomId: room.id,
                    granted: payload.granted,
                });
            }
            emitRoomUpdate(io, room);
        });
        socket.on("camera:state", (payload) => {
            if (!isCameraStatePayload(payload)) {
                emitError(socket, "Invalid camera state payload.");
                return;
            }
            const userId = ensureIdentified(socket);
            if (!userId) {
                return;
            }
            const room = getRoom(payload.roomId);
            if (!room) {
                emitError(socket, "Room not found for camera state.");
                return;
            }
            normalizeRoomState(room);
            if (!canUserActAsClient(room, userId) || room.clientSocketId !== socket.id) {
                emitError(socket, "Only active client can update camera state.");
                return;
            }
            room.cameraActive = payload.active;
            emitRoomUpdate(io, room);
        });
        socket.on("media:kind", (payload) => {
            if (!isMediaKindPayload(payload)) {
                emitError(socket, "Invalid media metadata payload.");
                return;
            }
            const userId = ensureIdentified(socket);
            if (!userId) {
                return;
            }
            const room = getRoom(payload.roomId);
            if (!room) {
                emitError(socket, "Room not found for media metadata.");
                return;
            }
            normalizeRoomState(room);
            if (!canUserActAsClient(room, userId) || room.clientSocketId !== socket.id) {
                emitError(socket, "Only active client can publish media metadata.");
                return;
            }
            if (room.hostSocketId) {
                io.to(room.hostSocketId).emit("media:kind", {
                    roomId: room.id,
                    streamId: payload.streamId,
                    kind: payload.kind,
                });
            }
        });
        socket.on("disconnect", () => {
            const detached = removeSocket(socket.id);
            if (!detached) {
                return;
            }
            const peerSocketId = detached.role === "host"
                ? detached.room.clientSocketId
                : detached.room.hostSocketId;
            if (peerSocketId) {
                io.to(peerSocketId).emit("peer:disconnected", {
                    roomId: detached.room.id,
                    role: detached.role,
                });
            }
            emitRoomUpdate(io, detached.room);
        });
    });
}
