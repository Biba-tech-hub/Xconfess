# ADR-006: Privacy Data Lifecycle and Retention

## Status

Accepted

## Context

xConfess is a privacy-first anonymous confession platform. Users can post confessions, react, comment, and send private messages. Each action produces data tied to a user account, but the product guarantee is anonymity — confessions must not be traceable back to real identities, and users must be able to delete their data.

The project must answer: how long is data retained, how is it deleted, and what is exported on a data-access request?

See also:
- `docs/data-export-privacy-runbook.md` — operational runbook for export requests
- `docs/data-export-retention.md` — retention policy summary

## Options Considered

- **Option A — Hard delete on request**: Remove all user rows and cascade immediately when a user requests deletion. Simple, irreversible.
- **Option B — Soft delete with scheduled purge**: Mark records as deleted (`deleted_at` timestamp) and exclude them from queries. A background job hard-deletes rows after a retention window. Allows recovery from accidental deletion and preserves audit integrity.
- **Option C — Anonymise instead of delete**: Replace PII fields (email, display name) with placeholders; keep the row for aggregate analytics. User data is effectively gone but activity records remain.

## Decision

We chose **Option B** — soft delete with a scheduled purge (30-day retention window for deleted accounts).

Soft deletes preserve referential integrity during the retention window (audit logs, moderation records referencing the user row remain valid). Hard deletion is irreversible; a brief recovery window reduces accidental data loss. After 30 days, a background job permanently removes the user, associated confessions, messages, and all PII fields.

Exported data (GDPR/CCPA data-access requests) includes all non-deleted records owned by the requesting user. The export omits fields that would de-anonymise other users.

## Consequences

### Positive

- Soft deletes maintain foreign-key integrity during the retention window
- Accidental account deletion can be reversed within 30 days by the maintainer
- Export logic is well-defined: one-to-one with owned, non-deleted records
- Audit log entries referencing a soft-deleted user remain valid for moderation records

### Negative

- Queries must consistently apply a `WHERE deleted_at IS NULL` filter; missing this leaks soft-deleted data
- The 30-day window means user data is not immediately removed — this must be disclosed in the privacy policy
- Background purge job is a required infrastructure component (BullMQ/Redis dependency, see ADR-003)

## Migration strategy

The `deleted_at` column is added by migration `20260223-add-soft-delete-columns.ts`. Any query that lists or returns user-owned resources must include the soft-delete filter. New modules must follow the same pattern.

## Revisit triggers

- A regulatory requirement (GDPR enforcement action) mandates immediate hard delete → switch to Option A or reduce retention window to zero
- The purge job proves operationally complex → consider Option C (anonymise) as an alternative

## References

- `xconfess-backend/migrations/20260223-add-soft-delete-columns.ts`
- `xconfess-backend/src/data-export/`
- `docs/data-export-privacy-runbook.md`
- `docs/data-export-retention.md`
- `docs/anonymous-identity-ownership-audit.md`
