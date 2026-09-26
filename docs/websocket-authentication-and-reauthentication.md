# WebSocket Authentication and Reauthentication Protocol

## Overview
Long-lived WebSocket connections require explicit handling when authentication tokens expire, session cookies change, or user roles/permissions are revoked. This protocol defines the lifecycle from handshake to in-flight re-authentication and server-initiated revocation.

## 1. Handshake Authentication
When establishing a connection, clients MUST provide valid credentials through one of three prioritized vectors:
1. `handshake.auth.token` (Primary: Recommended Socket.io client configuration)
2. `Authorization: Bearer <token>` HTTP header
3. Secure HttpOnly cookies (`token`, `access_token`, or `jwt`)

Handshake verification is enforced by `WsJwtGuard`. Missing or expired tokens are rejected with standard error codes (`NO_TOKEN_PROVIDED`, `EXPIRED_TOKEN`, `MALFORMED_TOKEN`). Sensitive headers are scrubbed from socket instances to prevent credential leakage into logs.

## 2. In-Flight Reauthentication (`auth:refresh`)
To prevent connection drops when short-lived access tokens expire:
- The client emits an `auth:refresh` event with the newly refreshed JWT:
  ```json
  // Client -> Server
  {
    "token": "<new_jwt_access_token>"
  }
  ```
- The server validates the new token:
  - **Success**: Server updates the socket's attached `userId` and user room subscriptions, returning:
    ```json
    // Server -> Client
    {
      "success": true,
      "userId": "123",
      "timestamp": "2026-09-25T08:00:00.000Z"
    }
    ```
  - **Failure**: If the token is invalid, malformed, or revoked, the server emits `auth:revoked` and immediately closes the underlying socket (`disconnect(true)`).

## 3. Server-Initiated Revocation Disconnects
When a user logs out, rotates passwords, or is deactivated by moderation:
- The backend triggers `NotificationGateway.revokeUserSessions(userId, reason)`.
- All open sockets belonging to that user receive an `auth:revoked` payload:
  ```json
  {
    "reason": "SESSION_REVOKED",
    "timestamp": "2026-09-25T08:00:00.000Z"
  }
  ```
- All sockets are immediately terminated server-side.

## 4. Channel Authorization Boundaries
- Sockets are automatically isolated into private rooms (`user:<userId>`).
- Subscription requests to other user channels are strictly rejected with `subscription:rejected`.
