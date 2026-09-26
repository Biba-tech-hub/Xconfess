# Anonymous Identity and Ownership Security Audit

Issue: #1694

## Threat Model

XConfess separates real account identity from anonymous identities. Any anonymous identity linked through `user_anonymous_users` is private account state. A caller must not be able to infer, use, mutate, export, message, report as, or moderate through another account's linked anonymous identity.

The default rule is:

- Linked anonymous identity: usable only by the linked authenticated account.
- Unlinked anonymous identity: usable by public anonymous surfaces that intentionally do not require login.
- Missing or forged linked identity: return `404` so the response does not confirm whether the identity exists.
- Admin exception: admin-only moderation/report/audit endpoints may cross ownership boundaries when protected by `JwtAuthGuard` and `AdminGuard`.

## Endpoint Ownership Matrix

| Surface | Endpoint | IDs accepted | Ownership rule | Failure |
| --- | --- | --- | --- | --- |
| Confessions public feed | `GET /confessions`, `GET /confessions/:id`, search/tag/trending routes | `confessionId`, tag/search query | Public approved, non-deleted surface. No user ownership required. | `404` for missing/deleted item paths |
| Confession create | `POST /confessions` | body only | Creates a fresh anonymous confession through service rules. No linked identity is accepted from caller. | `400` validation |
| Confession mutate | `PUT /confessions/:id`, `DELETE /confessions/:id`, `PATCH /confessions/:id/restore`, schedule routes | `confessionId` | High-risk legacy surface. Must be treated as owner/admin-only before production exposure. | Should be `403`/`404` |
| Comments public read | `GET /confessions/:confessionId/comments` | `confessionId` | Public approved comments only. | Empty/`404` via confession filtering |
| Comments create/edit/delete | `POST/PATCH/DELETE /confessions/:confessionId/comments...` | `confessionId`, `commentId`, `anonymousContextId` | JWT required. Edit/delete compares comment anonymous user to authenticated request anonymous user. | `403`/`404` depending path |
| Reactions | `POST /reactions` | `confessionId`, `anonymousUserId` | Optional JWT. Linked `anonymousUserId` must belong to authenticated caller; unlinked IDs remain public. | `404` for forged/missing anonymous identity |
| Reports | `POST /confessions/:id/report` | `confessionId`, `x-anonymous-user-id`, idempotency key | Optional JWT. Authenticated reports use real `reporterId`; anonymous reports may use only unlinked anonymous identities. Linked IDs cannot be used without owner auth. | `400` missing anon header, `404` forged/missing linked identity |
| Messages | `POST /messages`, reply/thread/inbox routes | `confessionId`, `messageId`, `threadId`, sender anonymous ID in thread | JWT required. Service resolves sender from caller session and verifies thread participant via caller's anonymous links. | `404` for non-participant thread reads |
| Data export | `/data-export/*`, `/export/*` | `exportId`, `jobId`, signed token | JWT endpoints bind requests by `req.user.id`. Signed downloads require the stored token, not only ID. | `401` invalid token, `404` missing owner-bound job |
| User history/profile private | `GET /users/:userId/activities`, `confessions`, settings/delete | `userId` | `OwnershipGuard` requires `req.user.id === :userId`; delete allows admin bypass. | `403` |
| Admin reports/moderation/users | `/admin/*`, comment admin, moderation, email, key rotation, DLQ admin | report/confession/comment/user IDs | Admin-only exception. Must be protected by `JwtAuthGuard` + `AdminGuard`. | `403` for non-admin |
| Tips | `/confessions/:id/tips*`, tip verification | `confessionId`, `tipId`, `txId` | Public tip stats by confession; verification is idempotent by `(confessionId, txId)` and does not accept anonymous account identity. | `404` missing confession, `409` replay/conflict |

## Hardened Endpoints

- `POST /reactions`
  - Now uses `OptionalJwtAuthGuard`.
  - Linked `anonymousUserId` requires the authenticated linked account.
  - Public unlinked anonymous identities continue to work.

- `POST /confessions/:id/report`
  - Anonymous reports now verify the supplied `x-anonymous-user-id`.
  - Linked anonymous identities are rejected for anonymous callers with `404`.
  - Authenticated reports continue to bind to `reporterId`, not a body/header identity.

## Username and Identity Enumeration Resistance

Issue: #27

Registration, login, recovery, and profile endpoints can reveal whether an identity exists through response differences, status codes, headers, or timing. The following rules normalize externally visible behavior while keeping internal logs useful.

### Externally Visible Contract

| Surface | Endpoint | Existing identity | Non-existing identity | Notes |
| --- | --- | --- | --- | --- |
| Registration | `POST /auth/register` | `201` generic success body | `201` generic success body | Duplicate registration must not confirm the account exists. If the email/username is taken, respond with the same shape and status as a fresh registration and notify the real owner out-of-band. |
| Login | `POST /auth/login` | `200` with tokens | `401` generic `Invalid credentials` | Same status, body, and headers for unknown user, wrong password, and disabled account. |
| Password recovery request | `POST /auth/recovery/request` | `202` generic accepted | `202` generic accepted | Always return the same body and status; never echo whether the identifier matched. |
| Password recovery verify | `POST /auth/recovery/verify` | `200`/`400` based on token validity only | `400` generic invalid token | Token validity is the only signal; do not branch on whether the account exists. |
| Profile lookup | `GET /users/:userId` | `200` public profile | `404` generic not found | `404` must not distinguish deleted, private, or never-existed accounts. |
| Username availability | `GET /auth/username-available` | `200` `{ available: false }` | `200` `{ available: true }` | If this endpoint is exposed, it is an explicit product decision and must be rate limited; otherwise remove it. |

### Timing Budget

- Authentication and recovery handlers must run the same code path for existing and non-existing identities, including a constant-cost password hash comparison against a dummy hash when the user is missing.
- Target budget: the difference in p95 latency between existing and non-existing identities must stay within 50 ms on the reference environment.
- Timing tests assert the budget rather than exact equality to avoid flakiness on shared CI runners.

### Internal Logging

- Logs may record the outcome (`login_failed`, `recovery_requested`, `register_duplicate`) and a hashed identifier (`sha256(lowercased(identifier) + LOG_SALT)`).
- Logs must not contain raw email addresses, usernames, or user IDs on enumeration-sensitive paths.
- Operators can still correlate repeated attempts by the hashed identifier without exposing the underlying identity.

### Regression Coverage

- `src/auth/auth-enumeration.spec.ts`
  - Registration returns identical status, body, and headers for new and duplicate identities.
  - Login returns identical status, body, and headers for unknown user, wrong password, and disabled account.
  - Recovery request returns identical status, body, and headers for existing and non-existing identities.
  - Timing budget: p95 delta between existing and non-existing identities stays within 50 ms.
  - Logs on enumeration-sensitive paths contain only hashed identifiers.

## Regression Coverage

- `src/common/security/anonymous-identity-ownership.spec.ts`
  - Shared anonymous identity assertion tests.
- `src/reaction/reaction.service.spec.ts`
  - Owner linked identity allowed.
  - Another user's linked identity rejected with `404`.
  - Public unlinked anonymous identity still works.
- `src/report/reports.service.spec.ts`
  - Anonymous report with forged linked identity rejected before report creation.

## Review Evidence Commands

```bash
npm run test --workspace=xconfess-backend -- src/common/security/anonymous-identity-ownership.spec.ts src/reaction/reaction.service.spec.ts src/report/reports.service.spec.ts
npm run build --workspace=xconfess-backend
```
