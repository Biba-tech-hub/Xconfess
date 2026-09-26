# Security Audit Suppressions

This document records the security-audit findings that are intentionally
suppressed, along with the rationale, the compensating control, and the
expiration date. Every suppression must be reviewed before it expires.

## How to add a suppression

1. Add an entry to the table below with a stable `ID`.
2. Reference the exact rule/tool and the affected path or dependency.
3. Describe the compensating control that keeps the risk acceptable.
4. Set an `Expires` date (max 180 days out) and an owner.

## Active suppressions

| ID | Tool / Rule | Location | Rationale | Compensating control | Owner | Expires |
| --- | --- | --- | --- | --- | --- | --- |
| SUP-001 | `npm audit` — transitive dev-only advisory | `devDependencies` | Advisory only affects a build-time tool, never shipped to production. | Build runs in an isolated CI runner with no production secrets. | security | 2025-12-31 |

## Login anomaly detection (issue #26)

The login anomaly detection and step-up challenge work introduces new
signals (credential stuffing, impossible travel, velocity, device/IP
novelty). The following suppressions apply to that surface and must be
revisited whenever the risk-scoring thresholds change.

| ID | Tool / Rule | Location | Rationale | Compensating control | Owner | Expires |
| --- | --- | --- | --- | --- | --- | --- |
| SUP-026-1 | Static analysis — "user-controlled data in log" | `src/auth/anomaly/*` | Anomaly events intentionally log a hashed subject and request ID, never raw credentials or full IPs. | Logs are scrubbed by the privacy filter; raw IPs are truncated to /24 (IPv4) or /48 (IPv6) before storage. | security | 2025-12-31 |
| SUP-026-2 | Dependency scan — timing side channel in risk scoring | `src/auth/anomaly/risk.ts` | Risk scoring is not a secret-dependent comparison; scores are advisory and never used as an auth secret. | Step-up decisions are enforced server-side and re-validated on every request. | security | 2025-12-31 |

## Privacy limits for anomaly signals

To keep the anomaly detection within the issue's privacy boundary:

- **Data minimization:** only derived signals (counts, booleans, bucketed
  timestamps) are persisted; raw credentials, full IP addresses, and raw
  user agents are never stored.
- **Retention:** anomaly and step-up events are retained for 30 days, then
  aggregated into counters and the raw rows are deleted.
- **Correlation:** every anomaly and step-up event carries the originating
  `requestId` so operators can trace a single login attempt end to end
  without exposing the subject's identity.
- **No raw leakage:** logs and audit records use a hashed subject identifier
  and truncated network identifiers only.

## Rollback

If anomaly detection causes unacceptable false positives, disable the
step-up enforcement flag (blocking remains off) while keeping event
collection on. This preserves observability and lets operators measure the
false-positive rate before re-enabling enforcement.
