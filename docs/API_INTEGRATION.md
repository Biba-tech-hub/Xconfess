# API Integration Guide

This guide helps third-party developers integrate with the xConfess HTTP API.
It covers authentication, public endpoints, rate limits, error handling, webhook delivery, and copy-paste examples in `curl`, JavaScript, and Python.

## Base URL

All endpoints are served under the server base URL plus the global API prefix:

- `https://<your-host>/api`

For local development, the backend runs at `http://localhost:5000/api` by default.

## Authentication Overview

xConfess uses stateless JWT authentication for protected routes.
Third-party integrations should authenticate by exchanging email/password credentials for an access token.

### Supported auth endpoints

- `POST /api/users/register` — create a new account
- `POST /api/users/login` — login with email/password
- `POST /api/auth/login` — alternative login endpoint (same payload)
- `GET /api/auth/me` — get profile for current JWT user
- `GET /api/auth/session` — get authenticated session information
- `POST /api/auth/logout` — acknowledge logout
- `POST /api/auth/forgot-password` — request password reset
- `POST /api/auth/reset-password` — complete password reset

### Login request

`POST /api/auth/login`

Request body:

```json
{
  "email": "alice@example.com",
  "password": "Str0ng!Pass#1"
}
```

Successful response:

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "anonymousUserId": "anon_7f3a2b1c",
  "user": {
    "id": 1,
    "username": "alice_42",
    "role": "user",
    "is_active": true
  }
}
```

> Tip: `POST /api/users/login` is equivalent for login flows and can be used interchangeably.

### Use the JWT

Include the token on protected requests:

```http
Authorization: Bearer <access_token>
```

### Profile endpoints

- `GET /api/auth/me`
- `GET /api/auth/session`
- `GET /api/users/profile`

These return the current authenticated user profile. Use whichever route best fits your integration.

## Login anomaly detection and step-up challenges

Login attempts are scored for risk. High-risk attempts require a second factor
(step-up challenge) or are blocked, depending on the configured policy. Every
anomaly and step-up event is correlated by a `requestId` so operators can trace
a single attempt end to end.

### Anomaly signals

| Signal              | Description |
|---------------------|-------------|
| `credential_stuffing` | Many distinct accounts attempted from the same source in a short window. |
| `impossible_travel`   | Two successful logins from geographically distant locations within an implausible time window. |
| `velocity`            | Login attempt rate for an account or source exceeds the configured threshold. |
| `device_novelty`      | Login from a device fingerprint not previously seen for the account. |
| `ip_novelty`          | Login from an IP address/ASN not previously seen for the account. |

### Risk scoring

Each signal contributes a weighted score; the sum is clamped to `0–100`.

| Signal              | Weight |
|---------------------|--------|
| `credential_stuffing` | 40 |
| `impossible_travel`   | 35 |
| `velocity`            | 20 |
| `device_novelty`      | 15 |
| `ip_novelty`          | 10 |

Policy thresholds:

- `score < 40` — allow, no challenge.
- `40 ≤ score < 70` — require a step-up challenge (second factor).
- `score ≥ 70` — block the attempt.

### Step-up challenge flow

When a login is challenged, the login response does not return an access token.
Instead it returns a challenge that must be completed before a token is issued.

`POST /api/auth/login` (challenged) response:

```json
{
  "status": "step_up_required",
  "requestId": "req_5b1e9c",
  "challengeId": "chal_2f7a",
  "riskScore": 55,
  "signals": ["device_novelty", "ip_novelty"],
  "expiresAt": "2026-04-25T10:05:00.000Z"
}
```

Complete the challenge:

`POST /api/auth/login/step-up`

```json
{
  "challengeId": "chal_2f7a",
  "code": "123456"
}
```

On success the normal login response (with `access_token`) is returned. On
failure the challenge can be retried until `expiresAt`, after which a new login
attempt is required.

Blocked attempts return `403 Forbidden`:

```json
{
  "status": "blocked",
  "requestId": "req_5b1e9c",
  "riskScore": 80,
  "signals": ["credential_stuffing", "velocity"]
}
```

### Correlation by request ID

Every login attempt is assigned a `requestId`. The same `requestId` is echoed on
the login response, the step-up challenge, and any anomaly/step-up event emitted
to operators, so a single attempt can be reconstructed across systems. Clients
should log the `requestId` from responses for support and debugging.

### Privacy limits

Anomaly detection follows data minimization:

- Only derived signals and scores are stored; raw credentials are never retained.
- IP addresses and device fingerprints are stored as salted hashes, not raw values.
- Signal history is retained for a bounded window (default 30 days) and then purged.
- Operators see signal names and scores, not raw sensitive identifiers.

## Account deletion orchestration

Account deletion is a stateful, idempotent job. Deletion spans posts, messages,
exports, notifications, analytics, and chain references, each with different
retention requirements, so the API exposes an explicit lifecycle rather than a
single destructive call.

### Lifecycle states

| `state`         | Meaning | Terminal |
|-----------------|---------|----------|
| `requested`     | Deletion was requested but not yet confirmed by the user. | no |
| `confirmed`     | The user confirmed intent; the grace period has started. | no |
| `grace_period`  | Waiting out the configurable grace window; deletion can still be cancelled. | no |
| `processing`    | The job is actively deleting and anonymizing records. | no |
| `completed`     | All deletable records are gone and retained records are de-identified. | yes |
| `failed`        | The job hit a terminal error; inspect `failureReason` and retry. | yes |
| `cancelled`     | The user cancelled during the grace period; nothing was deleted. | yes |

Transitions are one-directional: `requested → confirmed → grace_period →
processing → completed | failed`, with `cancelled` reachable only from
`confirmed` or `grace_period`.

### Endpoints

- `POST /api/account/deletion` — request deletion (enters `requested`)
- `POST /api/account/deletion/confirm` — confirm intent (enters `confirmed`/`grace_period`)
- `POST /api/account/deletion/cancel` — cancel during the grace period
- `GET /api/account/deletion` — fetch current job status

All endpoints require the `Authorization: Bearer <access_token>` header and
operate on the authenticated user only.

### Request deletion

`POST /api/account/deletion`

```json
{
  "reason": "Leaving the platform"
}
```

Response:

```json
{
  "state": "requested",
  "jobId": "del_9f2c1a",
  "gracePeriodSeconds": 604800,
  "requestedAt": "2026-04-25T10:00:00.000Z",
  "scheduledFor": null
}
```

### Confirm deletion

`POST /api/account/deletion/confirm`

```json
{
  "confirmationToken": "del_9f2c1a"
}
```

Confirmation is required before any data is touched. On success the job enters
`grace_period` and `scheduledFor` is set to the end of the grace window.

### Cancel deletion

`POST /api/account/deletion/cancel`

Cancellation is only accepted while the job is in `confirmed` or
`grace_period`. Once `processing` begins, cancellation returns `409 Conflict`.

### Status

`GET /api/account/deletion`

```json
{
  "state": "grace_period",
  "jobId": "del_9f2c1a",
  "gracePeriodSeconds": 604800,
  "requestedAt": "2026-04-25T10:00:00.000Z",
  "scheduledFor": "2026-05-02T10:00:00.000Z",
  "retainedRecords": [
    { "category": "financial", "reason": "legal_retention", "anonymized": true }
  ]
}
```

### Idempotency and observability

Deletion requests are idempotent: repeating `POST /api/account/deletion` while a
job is active returns the existing job rather than creating a new one. Every
state transition is recorded with a timestamp so the user-facing status is
always accurate.

### Anonymization and legal retention

Records that must be retained for legal or financial reasons (for example,
settled tips and audit logs) are **de-identified** rather than deleted: direct
identifiers are replaced with a stable pseudonym and the original values are
discarded. Each retained category is reported in `retainedRecords` with a
`reason` and `anonymized: true` so the retention is justified and auditable.

## Public endpoint reference

### Create confession

`POST /api/confessions`

Request body:

```json
{
  "message": "I finally took a break and it helped.",
  "gender": "other",
  "tags": ["wellbeing", "work"],
  "stellarTxHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Response example:

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "message": "I finally took a break and it helped.",
  "gender": "other",
  "tags": ["wellbeing", "work"],
  "view_count": 0,
  "created_at": "2026-04-25T10:00:00.000Z"
}
```

### List confessions

`GET /api/confessions`

Query parameters:

- `page` (optional)
- `limit` (optional)

Response shape:

```json
{
  "data": [ /* confession objects */ ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

### Search confessions

`GET /api/confessions/search`

Search parameters are validated and allow hybrid query behavior.

### Full-text search

`GET /api/confessions/search/fulltext`

Same query shape as `/confessions/search` but performs a full-text search over confession content.

### Trending confessions

`GET /api/confessions/trending/top`

Returns the current top trending confessions.

### Tags

- `GET /api/confessions/tags` — list all available tags
- `GET /api/confessions/tags/:tag` — list confessions for a tag

### Confession details and updates

- `PUT /api/confessions/:id` — update an existing confession
- `DELETE /api/confessions/:id` — soft-delete a confession
- `PATCH /api/confessions/:id/restore` — restore a soft-deleted confession

### Stellar anchoring

- `POST /api/confessions/:id/anchor` — anchor a confession on Stellar
- `GET /api/confessions/:id/stellar/verify` — verify a confession anchor

### Reactions

`POST /api/reactions`

Request body:

```json
{
  "confessionId": "4f8f8eb0-b6d8-4a92-8f77-6fa3c7aa2e67",
  "anonymousUserId": "2c11e9ce-4f2f-4f06-a5d8-faf2917fd5d9",
  "emoji": "🔥"
}
```

### Messages

- `POST /api/messages` — send an anonymous message to a confession author
- `POST /api/messages/reply` — reply to an anonymous message as the confession author
- `GET /api/messages/threads` — list message threads for authenticated user
- `GET /api/messages` — list messages in a conversation thread

`POST /api/messages` body:

```json
{
  "confession_id": "4f8f8eb0-b6d8-4a92-8f77-6fa3c7aa2e67",
  "content": "Thanks for sharing this."
}
```

### Reports

`POST /api/reports`

Request body:

```json
{
  "confessionId": "4f8f8eb0-b6d8-4a92-8f77-6fa3c7aa2e67",
  "type": "spam",
  "reason": "Repeated promotional content"
}
```

### Tipping

- `GET /api/confessions/:id/tips` — list tips for a confession
