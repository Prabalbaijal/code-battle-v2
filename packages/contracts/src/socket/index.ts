/**
 * Typed Socket.IO event maps shared by realtime nodes and the web client.
 * Server → client events are filled in during Phase 3 (plan §13.4).
 */
export interface ServerEnvelope<T> {
  eventId: string;
  type: string;
  ts: string;
  seq?: number;
  data: T;
}

export interface ClientToServerEvents {
  'presence:ping': () => void;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ServerToClientEvents {}
