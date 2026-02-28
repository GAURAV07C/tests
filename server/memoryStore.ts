import { Role, Room } from "./types.js";

const ROOM_ID_PATTERN = /^\d{6}$/;

export const rooms = new Map<string, Room>();

function randomRoomId(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

function ensureRoomId(): string {
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

export function createRoom(hostUserId: string, hostSocketId: string): Room {
  const room: Room = {
    id: ensureRoomId(),
    hostUserId,
    hostSocketId,
    controlActive: false,
    cameraActive: false,
  };

  rooms.set(room.id, room);
  return room;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function findRoomByUserId(
  userId: string,
): { room: Room; role: Role } | undefined {
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

export function findRoomBySocketId(
  socketId: string,
): { room: Room; role: Role } | undefined {
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

export function attachSocket(room: Room, role: Role, socketId: string): void {
  if (role === "host") {
    room.hostSocketId = socketId;
    return;
  }

  room.clientSocketId = socketId;
}

export function clearSocket(room: Room, role: Role): void {
  if (role === "host") {
    delete room.hostSocketId;
  } else {
    delete room.clientSocketId;
  }

  room.controlActive = false;
  room.cameraActive = false;
}

export function removeSocket(socketId: string): { room: Room; role: Role } | undefined {
  const result = findRoomBySocketId(socketId);
  if (!result) {
    return undefined;
  }

  clearSocket(result.room, result.role);
  return result;
}

export function canUserControlRoom(room: Room, userId: string): boolean {
  return room.hostUserId === userId;
}

export function canUserActAsClient(room: Room, userId: string): boolean {
  return room.clientUserId === userId;
}
