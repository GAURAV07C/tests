const ROOM_ID_PATTERN = /^\d{6}$/;
export const rooms = new Map();
function randomRoomId() {
    return Math.floor(Math.random() * 1_000_000)
        .toString()
        .padStart(6, "0");
}
function ensureRoomId() {
    for (let attempts = 0; attempts < 1_000_000; attempts += 1) {
        const roomId = randomRoomId();
        if (!ROOM_ID_PATTERN.test(roomId)) {
            continue;
        }
        if (!rooms.has(roomId)) {
            return roomId;
        }
    }
    throw new Error("Unable to generate unique room code.");
}
export function createRoom(hostUserId, hostSocketId) {
    const room = {
        id: ensureRoomId(),
        hostUserId,
        hostSocketId,
        controlActive: false,
        cameraActive: false,
    };
    rooms.set(room.id, room);
    return room;
}
export function getRoom(roomId) {
    return rooms.get(roomId);
}
export function findRoomByUserId(userId) {
    for (const room of rooms.values()) {
        if (room.hostUserId === userId) {
            return { room, role: "host" };
        }
        if (room.clientUserId === userId) {
            return { room, role: "client" };
        }
    }
    return undefined;
}
export function findRoomBySocketId(socketId) {
    for (const room of rooms.values()) {
        if (room.hostSocketId === socketId) {
            return { room, role: "host" };
        }
        if (room.clientSocketId === socketId) {
            return { room, role: "client" };
        }
    }
    return undefined;
}
export function attachSocket(room, role, socketId) {
    if (role === "host") {
        room.hostSocketId = socketId;
        return;
    }
    room.clientSocketId = socketId;
}
export function clearSocket(room, role) {
    if (role === "host") {
        delete room.hostSocketId;
    }
    else {
        delete room.clientSocketId;
    }
    room.controlActive = false;
    room.cameraActive = false;
}
export function removeSocket(socketId) {
    const result = findRoomBySocketId(socketId);
    if (!result) {
        return undefined;
    }
    clearSocket(result.room, result.role);
    return result;
}
export function canUserControlRoom(room, userId) {
    return room.hostUserId === userId;
}
export function canUserActAsClient(room, userId) {
    return room.clientUserId === userId;
}
