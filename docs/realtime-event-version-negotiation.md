# Realtime Event Version Negotiation Protocol

## Overview
When frontend and backend deployments overlap, websocket event schemas may diverge. This specification defines how clients and servers negotiate event schema versions, envelope payloads, maintain deprecation windows, and safely handle unexpected events.

## 1. Handshake & Version Negotiation
Clients may declare their supported realtime event version during connection handshake or via the `negotiate-version` event:

```json
// Client -> Server on connection or emit('negotiate-version')
{
  "supportedVersion": 2
}
```

The server responds with negotiation status:
```json
// Server -> Client
{
  "acceptedVersion": 2,
  "isDeprecated": false,
  "minSupportedVersion": 1,
  "maxSupportedVersion": 2,
  "supported": true
}
```

If unnegotiated, the server assumes legacy Version 1 (`eventVersion: 1`).

## 2. Event Envelope Structure
Modern clients (V2+) receive version-enveloped events:
```json
{
  "eventVersion": 2,
  "minSupportedVersion": 1,
  "maxSupportedVersion": 2,
  "deprecatedVersions": [1],
  "deprecationWindowDays": 30,
  "data": {
    "id": "notif-1234",
    "type": "comment_notification"
  },
  "timestamp": "2026-09-25T08:00:00.000Z"
}
```

Legacy V1 clients receive raw unboxed structures with backward compatibility flags.

## 3. Deprecation Windows
- When an event schema version is deprecated, a 30-day minimum deprecation window is maintained before sunset.
- The `deprecationWindowDays` and `deprecatedVersions` fields communicate retirement timelines directly in event payloads.

## 4. Rollout and Rollback Procedures
- **Rollout**:
  1. Backend deploys support for `V(N+1)` while continuing to format `V(N)` payloads for older clients.
  2. Frontend deploys with support for `V(N+1)` negotiation.
  3. Deprecation window begins for `V(N-1)`.
- **Rollback**:
  - If a backend deploy is rolled back to `V(N)`, client negotiators cap accepted versions to `V(N)`, ensuring graceful degradation without connection tears.
  - Clients ignore unknown event types safely using `safelyConsumeRealtimeEvent`.
