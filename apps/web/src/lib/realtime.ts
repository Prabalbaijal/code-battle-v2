'use client';

import type {
  ClientToServerEvents,
  ServerEnvelope,
  ServerEventName,
  ServerEvents,
  ServerToClientEvents,
  SocketTicket,
} from '@cb/contracts';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from './api';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';
type Handler<K extends ServerEventName> = (msg: ServerEnvelope<ServerEvents[K]>) => void;

/**
 * One socket per tab (plan §13.1, §21.4). It authenticates with a single-use ticket from
 * `/auth/socket-ticket`, so every (re)connect fetches a new one. Events are deduplicated by
 * `eventId`; listeners subscribe per event name.
 */
class RealtimeClient {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents> | undefined;
  private status: RealtimeStatus = 'idle';
  private readonly statusListeners = new Set<() => void>();
  private readonly handlers = new Map<string, Set<(msg: ServerEnvelope<unknown>) => void>>();
  private readonly seen: string[] = [];
  private ping: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private wanted = false;

  getStatus = () => this.status;
  subscribeStatus = (fn: () => void) => {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  };
  private setStatus(s: RealtimeStatus) {
    this.status = s;
    for (const fn of this.statusListeners) fn();
  }

  start() {
    if (this.wanted) return;
    this.wanted = true;
    void this.connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.socket?.disconnect();
    this.socket = undefined;
    this.setStatus('idle');
  }

  on<K extends ServerEventName>(event: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (msg: ServerEnvelope<unknown>) => void);
    this.handlers.set(event, set);
    return () => set.delete(handler as (msg: ServerEnvelope<unknown>) => void);
  }

  private async connect() {
    if (!this.wanted) return;
    this.setStatus(this.attempt ? 'reconnecting' : 'connecting');
    let ticket: SocketTicket;
    try {
      ticket = await api<SocketTicket>('/auth/socket-ticket', { method: 'POST' });
    } catch {
      return this.scheduleRetry();
    }
    // loaded on demand: pages that never connect don't pay for the client
    const { io } = await import('socket.io-client');
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(ticket.url || undefined, {
      transports: ['websocket'],
      auth: { ticket: ticket.ticket },
      reconnection: false, // each attempt needs a fresh ticket, so we reconnect ourselves
    });
    this.socket = socket;
    socket.on('connect', () => {
      this.attempt = 0;
      this.setStatus('connected');
      clearInterval(this.ping);
      this.ping = setInterval(() => socket.emit('presence:ping'), 25_000);
    });
    socket.on('connect_error', () => this.scheduleRetry());
    socket.on('disconnect', () => {
      clearInterval(this.ping);
      if (this.socket === socket) this.scheduleRetry();
    });
    socket.onAny((event: string, msg: ServerEnvelope<unknown>) => {
      if (event === 'server:reconnect') {
        socket.disconnect();
        return;
      }
      if (msg?.eventId) {
        if (this.seen.includes(msg.eventId)) return;
        this.seen.push(msg.eventId);
        if (this.seen.length > 500) this.seen.shift();
      }
      for (const h of this.handlers.get(event) ?? []) h(msg);
    });
  }

  /** Exponential backoff with jitter, capped at 30 s (plan §13.1). */
  private scheduleRetry() {
    if (!this.wanted) return;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = undefined;
    clearTimeout(this.retry);
    this.setStatus('reconnecting');
    const delay = Math.min(30_000, 1000 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
    this.retry = setTimeout(() => void this.connect(), delay);
  }
}

export const realtime = new RealtimeClient();

export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(realtime.subscribeStatus, realtime.getStatus, () => 'idle');
}

/** Subscribe to one server event for the component's lifetime (the latest handler always runs). */
export function useRealtimeEvent<K extends ServerEventName>(event: K, handler: Handler<K>) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => realtime.on(event, (msg) => ref.current(msg)), [event]);
}
