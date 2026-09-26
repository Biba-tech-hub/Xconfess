# ADR-007: Redis as Required Infrastructure — Queue and Cache Dependency

## Status

Accepted

## Context

Several backend features (notifications, data export jobs, scheduled purges) require a persistent job queue. Redis was selected as the backing store for BullMQ (see ADR-003). Over time, Redis has also become the backing store for rate-limiting and caching hot feed queries.

This ADR documents the deliberate decision to make Redis a **required** runtime dependency rather than an optional one, and captures the boundaries of what runs behind Redis vs. what runs inline.

## Options Considered

- **Option A — Redis optional, fall back to in-process queues**: Allow the backend to start without Redis by falling back to an in-memory queue (e.g. `bull` with no Redis). Reduces operational requirements but loses persistence and retries across restarts.
- **Option B — Redis required, ENABLE_BACKGROUND_JOBS flag**: Redis is always required, but a feature flag (`ENABLE_BACKGROUND_JOBS=false`) disables job processing for CI and offline development. Startup health checks verify Redis is reachable before booting.
- **Option C — SQS or another managed queue**: Replace Redis with a managed cloud queue. Removes local infrastructure but introduces a cloud dependency for local dev and complicates the open-source contributor experience.

## Decision

We chose **Option B** — Redis required with `ENABLE_BACKGROUND_JOBS=false` for CI/dev.

Redis is battle-tested, runs in Docker with a single line of `compose.yaml`, and BullMQ's retry semantics (exponential backoff, dead-letter queues) are production-grade. In-memory fallback (Option A) silently loses jobs on restart. Managed queues (Option C) create a hard cloud dependency that breaks offline contributor environments.

`ENABLE_BACKGROUND_JOBS=false` lets CI and local dev skip workers without removing the Redis connection; the health readiness probe still passes as long as Redis is reachable.

## Consequences

### Positive

- All job processing is persistent and survives backend restarts
- BullMQ retries failed jobs automatically with configurable backoff
- `ENABLE_BACKGROUND_JOBS=false` keeps CI fast without mocking Redis
- Dead-letter queues (DLQ) give maintainers visibility into failed jobs

### Negative

- Contributors must run Docker to get Redis locally (`npm run dev:services`)
- Redis failure causes notification delivery and export jobs to stop — must be monitored in production
- Rate-limiting state is lost on Redis restart, temporarily allowing burst traffic

## Boundary definition

The following features require Redis at runtime:

| Feature | Queue/Cache |
|---------|------------|
| Email notifications | BullMQ queue |
| Data export jobs | BullMQ queue |
| Scheduled soft-delete purge | BullMQ queue |
| Feed query caching | Redis cache |
| Rate limiting | Redis cache |

The following features are **not** Redis-backed and work without it:

- Core confession CRUD
- Auth (JWT / cookie)
- Stellar anchoring and tipping
- WebSocket real-time push (Socket.IO manages its own adapter)

## Revisit triggers

- Redis proves operationally costly at scale → evaluate managed alternatives (Upstash, AWS ElastiCache)
- BullMQ is replaced by a cloud-native queue → update this ADR and `docs/notification-delivery-reliability.md`

## References

- `xconfess-backend/src/app.module.ts` (BullModule.forRootAsync)
- `xconfess-backend/src/notifications/`
- `compose.yaml` (Redis service)
- `docs/notification-delivery-reliability.md`
- ADR-003 (`003-notification-architecture.md`)
