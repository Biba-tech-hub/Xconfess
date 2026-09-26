# ADR-008: Data Ownership Boundaries Between Backend, Frontend, and Contracts

## Status

Accepted

## Context

xConfess is a monorepo with three distinct packages (ADR-005): a NestJS backend, a Next.js frontend, and Soroban smart contracts. Each layer handles some form of data, but the boundaries of what each layer owns — reads, writes, validates — are not always obvious to new contributors.

Without a clear ownership model, contributors may introduce:
- Direct database calls from the frontend (not possible in this architecture, but the intention should be documented)
- Contract state used as a source of truth for off-chain features
- Confession text or PII stored on-chain

This ADR defines which layer owns which data and where the authoritative source of truth lives.

## Options Considered

- **Option A — Shared data layer**: Frontend and backend share a type package and the frontend can call the database directly via server components. Tighter coupling, blurs ownership.
- **Option B — Backend is the single source of truth for all mutable state**: All writes go through the NestJS API. The frontend is read-only from the user's perspective (it posts to the API; it never talks to the database). Smart contracts store only hashes and on-chain state; they never receive raw confession content or PII.
- **Option C — Smart contracts as source of truth for confessions**: Confession content and metadata are stored on-chain. Backend is a cache/indexer. High latency, cost-prohibitive for text storage.

## Decision

We chose **Option B** — the NestJS backend is the single source of truth for all mutable application state.

The three layers own the following:

| Layer | Owns | Does not own |
|-------|------|--------------|
| **NestJS backend** | All PostgreSQL tables, all confession/user/message/audit data, all business logic, auth sessions | UI state, wallet connections, raw contract ABI |
| **Next.js frontend** | UI state, local session cookie (read-only mirror of backend JWT), Stellar wallet connection | Database records, backend secrets, confession content before posting |
| **Soroban contracts** | On-chain confession hash anchors, XLM tip balances, reputation badge state | Confession plaintext, user PII, session tokens |

## Key boundaries

1. **Confession content never goes on-chain.** Only a hash (`SHA-256` of the encrypted content) is anchored on Stellar. Raw text stays in PostgreSQL, encrypted at rest (ADR-004).

2. **The frontend never reads the database directly.** All data flows through `BACKEND_API_URL`. Next.js App Router proxy routes (`/api/[...path]`) forward requests to the NestJS backend.

3. **The backend validates all contract state it relies on.** When on-chain results (tip confirmations, anchor proofs) are needed, the backend fetches and verifies them via `@stellar/stellar-sdk`. Contracts are not trusted to self-report state to the backend.

4. **Contracts are append-only anchors.** The confession anchor contract stores a hash and a timestamp. It does not expose query endpoints that the backend polls for feed state — the backend is the feed source of truth.

## Consequences

### Positive

- Clear escalation path: all data bugs are investigated at the backend API layer first
- Frontend can be rebuilt or replaced without affecting data integrity
- Contract storage is small and auditable — no risk of PII on-chain

### Negative

- Contract state and backend state can diverge if the backend fails after the contract write but before committing to the database (handled by reconciliation job in `xconfess-backend/src/stellar/`)
- New contributors may not immediately understand why the frontend cannot call the database

## Revisit triggers

- A future feature requires the frontend to query Stellar directly for real-time on-chain state → add a read-only Stellar SDK client in the frontend and document the boundary update here
- Contract storage model changes to include mutable state → update the ownership table above

## References

- `xconfess-backend/src/stellar/` (reconciliation, contract invocation)
- `xconfess-frontend/app/api/` (proxy routes)
- `docs/frontend-proxy-routes.md`
- `docs/stellar-reconciliation-evidence.md`
- ADR-002 (`002-stellar-soroban.md`)
- ADR-004 (`004-confession-encryption.md`)
- ADR-005 (`005-monorepo-structure.md`)
