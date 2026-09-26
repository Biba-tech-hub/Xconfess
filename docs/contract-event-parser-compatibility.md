# Stellar Contract Event Indexer Compatibility Layer

> Backend module: `xconfess-backend/src/stellar/event-parser/`
> Source of truth for topics/field order: [`docs/contract-abi-reference.md`](./contract-abi-reference.md#public-event-schema-fixtures)

## Why this exists

The backend indexer parses events emitted by four Soroban contracts
(`confession-anchor`, `confession-registry`, `anonymous-tipping`,
`reputation-badges`). Contract upgrades can add fields or bump
`event_version` independently of backend deploys. Without a durable,
versioned parser, an upgrade or an unexpected event shape can silently break
anchoring, tips, reputation, or moderation workflows. This module gives the
backend a single, pure, dependency-free place to decode events and to fail
closed — loudly and with a typed, retry-aware error — instead of guessing.

## Module layout

| File | Purpose |
| --- | --- |
| `contract-event-parser.types.ts` | `RawContractEvent`, `ParsedContractEvent`, `ContractEventParseError`, `EventParseErrorCode`. |
| `contract-event-parser.ts` | The versioned registry (`EVENT_SCHEMAS`) and `parseContractEvent()` / `parseGovernanceStreamEvent()` / `getCompatibilityMatrix()`. |
| `contract-event-fixtures.ts` | One deterministic fixture per registered (topic, version) schema — reused by the fixture-coverage and parity tests. |
| `contract-event-parser.spec.ts` | Fixture coverage, fixture/registry parity, and error-classification tests. No live Stellar RPC involved — parsing is a pure, synchronous function over already-fetched event data. |
| `contract-event-parser.doc-parity.spec.ts` | Parses the ABI reference's fixture table and asserts the registry matches it row-for-row — the contract/backend parity test (see below). |

## Compatibility matrix

Generated from `getCompatibilityMatrix()` (also asserted 1:1 against fixtures
in `contract-event-parser.spec.ts`):

| Event | Category | Topic | Version | Field order |
| --- | --- | --- | --- | --- |
| `ConfessionAnchoredEvent` | anchor | `confession_anchor` | 1 | event_version, timestamp, anchor_height |
| `VersionCompatibilityCheckedEvent` | anchor | `version_compatibility_checked` | 1 | event_version, nonce, timestamp, from_major, from_minor, from_patch, to_major, to_minor, to_patch, compatible |
| `SettlementEvent` | tip | `tip_settl` | 1 | recipient, event_version, settlement_id, amount, proof_metadata, proof_present, timestamp |
| `ConfessionEvent` | confession | `confess` | 1 | event_version, confession_id, author, content_hash, nonce, timestamp, correlation_id |
| `ReactionEvent` | reaction | `react` | 1 | event_version, confession_id, reactor, reaction_type, nonce, timestamp, correlation_id |
| `PauseChangedEvent` | pause | `tip_pause` | 1 | actor, paused, reason, timestamp |
| `ReportEvent` | report | `report` | 1 | event_version, confession_id, reporter, reason, nonce, timestamp, correlation_id |
| `ReportSubmittedLedgerEvent` | report | `report` | 1 | confession_id, actor, reason, event_version, nonce, timestamp |
| `RoleEvent` | role | `role` | 1 | event_version, user, role, granted, nonce, timestamp, correlation_id |
| `GovernanceProposedEvent` | governance | `gov_prop` | 1 | proposal_id, proposer |
| `GovernanceApprovedEvent` | governance | `gov_app` | 1 | proposal_id, approver |
| `GovernanceApprovalRevokedEvent` | governance | `gov_rev` | 1 | proposal_id, actor |
| `GovernanceExecutedEvent` | governance | `gov_exec` | 1 | proposal_id, executor |
| `GovInvariantViolationEvent` | governance | `gov_inv` | 1 | nonce, timestamp, operation, reason, attempted_by |
| `GovernanceEvent` | governance | *(dynamic per-proposal stream — see below)* | 1 | event_version, metadata, nonce, timestamp |
| `BadgeEvent` | reputation | `badge` | 1 | event_version, badge_id, badge_type, owner, action, nonce, timestamp |
| `BadgeEvent` | reputation | `badge_awarded` | 1 | event_version, badge_id, badge_type, owner, action, timestamp |
| `BadgeEvent` | reputation | `badge_granted` | 1 | event_version, badge_id, badge_type, owner, action, timestamp |
| `BadgeEvent` | reputation | `badge_revoked` | 1 | event_version, badge_id, badge_type, owner, action, timestamp |
| `ReputationAdjustedData` | reputation | `reputation_adjusted` | 1 | user, amount, reason, timestamp |
| `ReputationDecayedData` | reputation | `reputation_decayed` | 1 | user, old_reputation, new_reputation, epochs_applied, timestamp |

**Note on `report`**: two distinct event shapes share the literal topic
`report`. The parser disambiguates by field count (7 fields → `ReportEvent`,
6 fields → `ReportSubmittedLedgerEvent`). If a future version introduces a
third shape with a colliding field count on this topic, it cannot be safely
disambiguated by count alone — give it a distinct topic instead.

**Note on `GovernanceEvent`**: its topic is a per-proposal stream name
decided at emission time, not a fixed string, so it isn't in the topic
registry. Call `parseGovernanceStreamEvent(eventVersion, values)` directly
for these events rather than routing by topic string.

**Note on events without an `event_version` field** (`PauseChangedEvent`,
`GovernanceProposedEvent`/`GovernanceApprovedEvent`/`GovernanceApprovalRevokedEvent`/`GovernanceExecutedEvent`,
`ReputationAdjustedData`, `ReputationDecayedData`): the contract payload
doesn't carry a version, so callers pass `eventVersion: 1` by convention.
If any of these payloads changes shape, it must gain a real `event_version`
field so this convention doesn't become ambiguous.

## Error classification (fail closed)

`parseContractEvent` never guesses. Every failure is a typed
`ContractEventParseError` with a `code` and a `retryable` flag:

| Code | Meaning | `retryable` |
| --- | --- | --- |
| `UNKNOWN_TOPIC` | No registry entry for this topic at all. | `false` — needs a registry entry, not a retry. |
| `UNSUPPORTED_VERSION` (newer) | `event_version` is higher than any version this backend knows for the topic. | `true` — the contract was upgraded ahead of the backend; reprocessing after deploying the matching parser version can succeed. |
| `UNSUPPORTED_VERSION` (older/gap) | `event_version` is below the known range for the topic. | `false` — that version was deprecated, not merely unimplemented. |
| `MALFORMED_PAYLOAD` | Topic and version are known, but the field count doesn't match any registered shape. | `false` — the payload itself is invalid. |

An indexer should park `retryable: true` failures in a dead-letter/replay
queue to reprocess after the next backend deploy, and alert immediately on
`retryable: false` failures since those require a code or data fix.

## Checkpointed ingestion & bounded replay

Parsing is pure, but ingestion is stateful: the indexer must survive RPC
gaps, backend deploys, and parser-version bumps without losing or
double-applying events. The ingestion layer wraps the parser with a durable
cursor, bounded replay, idempotent dedupe, and parser-version tracking.

### Cursor / checkpoint persistence

The indexer persists a single checkpoint record after each successfully
applied batch. The checkpoint is the resume point for the next run:

```ts
interface IngestionCheckpoint {
  /** Last ledger sequence fully applied (inclusive). */
  lastLedger: number;
  /** Last event position within `lastLedger` (paging cursor). */
  lastEventIndex: number;
  /** Parser version that produced the applied events. */
  parserVersion: string;
  /** Monotonic run counter, for metrics and runbook correlation. */
  runId: number;
  /** ISO-8601 timestamp of the last successful commit. */
  committedAt: string;
}
```

Rules:

- **Commit after apply, never before.** The checkpoint advances only once
  the batch's side effects are durable. A crash mid-batch replays that batch
  from the previous checkpoint — safe because apply is idempotent (below).
- **Single writer.** Only one indexer process may advance the checkpoint at a
  time (advisory lock / leader election). Concurrent writers would interleave
  cursors and skip ledgers.
- **Restart is lossless.** On boot the indexer reads the checkpoint and
  resumes at `(lastLedger, lastEventIndex + 1)`. If no checkpoint exists it
  starts from the configured `startLedger`.

### Bounded replay

Replay is always bounded by an explicit range so a bad checkpoint can't
re-scan the whole chain:

```ts
interface ReplayRequest {
  fromLedger: number;      // inclusive
  toLedger: number;        // inclusive
  maxLedgers: number;      // hard cap; reject ranges wider than this
  reason: 'gap' | 'parser-upgrade' | 'manual' | 'rollback';
}
```

- The indexer rejects any `ReplayRequest` whose width exceeds `maxLedgers`
  (default 10_000) with a typed error — operators must chunk larger replays.
- Replay reuses the same apply path as live ingestion, so dedupe and
  checkpointing behave identically.
- **Gap detection**: if the RPC returns a ledger sequence greater than
  `lastLedger + 1`, the indexer records a `GAP_DETECTED` metric and emits a
  bounded replay request for the missing range before continuing. Gaps are
  never silently skipped.

### Duplicate suppression (idempotent apply)

Every event has a stable identity derived from its on-chain coordinates:

```ts
function eventIdentity(e: RawContractEvent): string {
  return `${e.ledger}:${e.txHash}:${e.eventIndex}`;
}
```

- The apply step is keyed on `eventIdentity`. A unique index on that key
  makes re-applying a replayed event a no-op (`ON CONFLICT DO NOTHING`).
- Dedupe is enforced at the storage layer, not in memory, so it holds across
  process restarts and concurrent replays.
- The indexer counts `events_applied` vs `events_deduped` per batch; a
  non-zero dedupe count during live (non-replay) ingestion is a warning sign
  of overlapping cursors and should alert.

### Parser version handling

The checkpoint records the `parserVersion` that produced the applied events.
On boot the indexer compares it to the running parser version:

| Situation | Action |
| --- | --- |
| `checkpoint.parserVersion === running` | Resume normally from the checkpoint. |
| `checkpoint.parserVersion < running` (parser upgraded) | Do **not** silently continue. Emit a bounded `parser-upgrade` replay over the affected range so events parsed under the old schema are re-derived under the new one. Dedupe makes this safe. |
| `checkpoint.parserVersion > running` (backend rolled back) | Halt ingestion and alert. A newer parser wrote the checkpoint; an older parser must not overwrite it. Requires an explicit operator decision. |

Parser-version bumps therefore trigger **controlled reprocessing**, never
silent corruption: the old events are re-parsed and re-applied idempotently,
and the checkpoint's `parserVersion` is advanced only after the replay
commits.

### Replay metrics

The indexer exports these counters/gauges (Prometheus naming):

| Metric | Type | Meaning |
| --- | --- | --- |
| `indexer_checkpoint_ledger` | gauge | Current `lastLedger`. |
| `indexer_events_applied_total` | counter | Events applied (post-dedupe). |
| `indexer_events_deduped_total` | counter | Events suppressed as duplicates. |
| `indexer_gaps_detected_total` | counter | Ledger gaps detected. |
| `indexer_replay_ledgers_total` | counter | Ledgers re-scanned via replay. |
| `indexer_parser_version_mismatch_total` | counter | Boots where checkpoint/running parser versions differed. |
| `indexer_parse_errors_total{code,retryable}` | counter | Parser failures by classification. |

### Runbook

**Resume after a crash / deploy**
1. Confirm the checkpoint: `indexer_checkpoint_ledger` and the persisted
   `IngestionCheckpoint` agree.
2. Start the indexer. It resumes at `(lastLedger, lastEventIndex + 1)`.
3. Watch `indexer_events_deduped_total` — a small bump is expected for the
   in-flight batch; a sustained climb means overlapping writers.

**Recover from a detected gap**
1. Alert fires on `indexer_gaps_detected_total`.
2. Issue a bounded `ReplayRequest { reason: 'gap' }` covering the missing
   range (chunked to `maxLedgers`).
3. Verify `indexer_checkpoint_ledger` advances past the gap and
   `indexer_events_deduped_total` stays flat.

**After a parser upgrade**
1. Deploy the new parser. On boot the indexer detects
   `checkpoint.parserVersion < running` and emits a `parser-upgrade` replay.
2. Confirm `indexer_parser_version_mismatch_total` incremented once and
   `indexer_replay_ledgers_total` covers the affected range.
3. Confirm the checkpoint's `parserVersion` advanced only after the replay
   committed.

**Rollback (backend older than checkpoint)**
1. Ingestion halts with a `parserVersion > running` alert.
2. Do **not** force-advance the checkpoint. Either redeploy the newer parser
   or, if the rollback is intentional, take a manual checkpoint snapshot and
   record the decision in the incident log before resetting.

## How to add a new event version safely

1. Update `docs/contract-abi-reference.md` § "Public Event Schema Fixtures"
   first — add the new row with its topic, version, and field order. This
   doc is the contract between contract authors and backend consumers, and
   both sides' tests are pinned to it (see "Contract ⇄ backend parity" below).
2. Add the matching entry to `PUBLIC_EVENT_SCHEMA_FIXTURES` in
   `xconfess-contracts/contracts/events.rs`.
3. Append a **new** entry to `EVENT_SCHEMAS` in `contract-event-parser.ts`
   with the bumped `eventVersion`. **Never mutate or delete an existing
   entry** — historical on-chain events emitted under the old schema must
   keep parsing after the upgrade.
4. Add a fixture for the new version to `contract-event-fixtures.ts`.
5. Run the test commands below. The backend fixture-coverage test iterates
   every fixture, the fixture/registry parity test asserts the registry and
   fixture set stay 1:1, and the doc-parity test asserts the registry matches
   the doc table row-for-row — all three fail if anything diverges.

## Contract ⇄ backend parity

There's no cross-language fixture loader (Rust `cargo test` and TypeScript
`jest` don't share a runtime), so parity is enforced transitively through
`docs/contract-abi-reference.md` as the single shared source of truth:

- **Contract side**: `xconfess-contracts/contracts/events.rs` exports
  `PUBLIC_EVENT_SCHEMA_FIXTURES`, and a Rust test asserts it matches the doc
  table.
- **Backend side**: `contract-event-parser.doc-parity.spec.ts` parses the
  same doc table and asserts `EVENT_SCHEMAS` matches it row-for-row.

Because both sides are pinned to the same doc, a contract change that isn't
mirrored in the backend (or vice-versa) fails CI on one side or the other.

## Test commands

```bash
npm run contract:fmt:check
npm run contract:lint
npm run contract:test
npm run contract:build:release
```
