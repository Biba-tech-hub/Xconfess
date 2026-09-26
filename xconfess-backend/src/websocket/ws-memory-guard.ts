/**
 * WebSocket memory-safety guards for xConfess.
 *
 * Exports two enforcement utilities:
 *
 * 1. WS_PAYLOAD_LIMIT_BYTES — the maximum size (in bytes) of any single
 *    Socket.IO message body.  Oversized payloads are rejected immediately
 *    with a structured error event so clients receive explicit feedback.
 *    The limit is enforced in the notification gateway for all inbound events.
 *
 * 2. WS_MAX_SOCKETS_PER_USER — the maximum number of concurrent Socket.IO
 *    connections a single userId may hold.  Exceeding this cap disconnects
 *    the oldest connection to prevent unbounded heap growth from abandoned
 *    browser tabs.
 *
 * Design rationale (issue #102):
 *  - Long-lived connections with large inbound payloads are the primary
 *    source of unbounded heap growth in the notification gateway.
 *  - Bounding payload size (64 KiB) and per-user sockets (5) keeps the
 *    maximum in-flight WS memory proportional to connected users rather
 *    than growing without a ceiling.
 *  - These limits apply only to application-level payloads; Socket.IO
 *    frame overhead is bounded separately by maxHttpBufferSize in the
 *    IoAdapter (already set to 1 MB in websocket.adapter.ts).
 *
 * These constants are co-located with the enforcement helpers so they are
 * easy to audit and adjust in a single PR.
 */

import { Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

const logger = new Logger('WsMemoryGuard');

/** Maximum inbound payload size in bytes per Socket.IO message. */
export const WS_PAYLOAD_LIMIT_BYTES = 64 * 1024; // 64 KiB

/**
 * Maximum concurrent Socket.IO connections per authenticated user.
 * Extra tabs / devices beyond this cap have their oldest socket disconnected.
 */
export const WS_MAX_SOCKETS_PER_USER = 5;

/**
 * Validate the size of an inbound Socket.IO event payload.
 *
 * @param eventName  Name of the Socket.IO event (for logging).
 * @param payload    Raw payload value received from the client.
 * @returns `true` if the payload is within the allowed size; `false` otherwise.
 *          When `false`, a structured `ws:error` event is emitted to the client.
 */
export function assertPayloadSize(
  client: Socket,
  eventName: string,
  payload: unknown,
): boolean {
  const size = estimatePayloadBytes(payload);

  if (size > WS_PAYLOAD_LIMIT_BYTES) {
    logger.warn(
      `WS_PAYLOAD_TOO_LARGE: event="${eventName}" size=${size}B limit=${WS_PAYLOAD_LIMIT_BYTES}B socketId=${client.id}`,
    );
    client.emit('ws:error', {
      code: 'WS_PAYLOAD_TOO_LARGE',
      event: eventName,
      limitBytes: WS_PAYLOAD_LIMIT_BYTES,
      receivedBytes: size,
      message: `Payload exceeds the ${WS_PAYLOAD_LIMIT_BYTES / 1024} KiB limit`,
    });
    return false;
  }

  return true;
}

/**
 * Enforce the per-user socket cap.
 *
 * When the user already has WS_MAX_SOCKETS_PER_USER connections, this
 * function disconnects the *oldest* socket (the one added first) to make
 * room for the new one.  The evicted socket receives a `ws:error` event
 * before disconnection so the client can display a meaningful message.
 *
 * @param userId      Authenticated user ID.
 * @param newSocketId Socket ID of the newly connected client.
 * @param userSockets The shared Map<userId, Set<socketId>> from the gateway.
 * @param serverRef   Socket.IO server reference for cross-socket emission.
 */
export function enforceSocketCap(
  userId: string,
  newSocketId: string,
  userSockets: Map<string, Set<string>>,
  serverRef: { sockets: { sockets: Map<string, Socket> } } | null,
): void {
  const existing = userSockets.get(userId);
  if (!existing) return;

  // Remove the new socket before checking the cap so we're counting pre-existing ones.
  existing.delete(newSocketId);

  const currentCount = existing.size;

  if (currentCount < WS_MAX_SOCKETS_PER_USER) {
    // Re-add the new socket.
    existing.add(newSocketId);
    return;
  }

  // Cap reached — evict the first (oldest-iterated) socket.
  const [oldestSocketId] = existing;
  existing.delete(oldestSocketId);
  existing.add(newSocketId);

  logger.warn(
    `WS_SOCKET_CAP_EVICT: userId=${userId} evicted=${oldestSocketId} cap=${WS_MAX_SOCKETS_PER_USER}`,
  );

  // Notify and disconnect the evicted socket if we can reach it.
  if (serverRef) {
    const targetSocket = serverRef.sockets.sockets.get(oldestSocketId);
    if (targetSocket) {
      targetSocket.emit('ws:error', {
        code: 'WS_TOO_MANY_CONNECTIONS',
        message: `Connection limit of ${WS_MAX_SOCKETS_PER_USER} per user reached. This oldest session has been disconnected.`,
      });
      targetSocket.disconnect(true);
    }
  }
}

/**
 * Estimate the serialised byte length of a Socket.IO event payload.
 * Uses JSON serialisation length as a conservative upper bound.
 */
export function estimatePayloadBytes(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8');
  if (Buffer.isBuffer(payload)) return payload.length;

  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch {
    // Non-serialisable payload — treat as max to be safe.
    return WS_PAYLOAD_LIMIT_BYTES + 1;
  }
}
