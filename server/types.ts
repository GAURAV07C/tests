export type Role = "host" | "client";

export type StreamKind = "screen" | "camera";

export interface Room {
  id: string;
  hostUserId: string;
  clientUserId?: string;
  hostSocketId?: string;
  clientSocketId?: string;
  controlActive: boolean;
  cameraActive: boolean;
}

export interface IdentifyPayload {
  userId: string;
}

export interface RoomJoinPayload {
  roomId: string;
}

export interface RejoinRoomPayload {
  roomId: string;
  role: Role;
}

export interface ControlStatusPayload {
  roomId: string;
  active: boolean;
}

export interface CameraRequestPayload {
  roomId: string;
}

export interface CameraPermissionPayload {
  roomId: string;
  granted: boolean;
}

export interface CameraStatePayload {
  roomId: string;
  active: boolean;
}

export interface MediaKindPayload {
  roomId: string;
  streamId: string;
  kind: StreamKind;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface OfferSignal {
  type: "offer";
  sdp: string;
}

export interface AnswerSignal {
  type: "answer";
  sdp: string;
}

export interface IceCandidateSignal {
  type: "ice-candidate";
  candidate: IceCandidatePayload;
}

export type WebRtcSignal = OfferSignal | AnswerSignal | IceCandidateSignal;

export interface WebRtcSignalPayload {
  roomId: string;
  signal: WebRtcSignal;
}
