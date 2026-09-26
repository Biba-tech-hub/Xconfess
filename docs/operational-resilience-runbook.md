# Operational Resilience Runbook

Covers issues #96, #97, #98, and #99.

---

## Table of Contents

1. [Dependency Outage Behavior (#96)](#dependency-outage-behavior)
2. [Alert Deduplication and Ownership (#97)](#alert-deduplication-and-ownership)
3. [Backup Restore Verification (#98)](#backup-restore-verification)
4. [Chaos Experiments (#99)](#chaos-experiments)

---

## 1. Dependency Outage Behavior (#96)

**Source files:**
- `xconfess-backend/src/health/circuit-breaker.service.ts`
- `xconfess-backend/src/health/outage-policy.ts`

### How it works

Each external dependency (postgres, redis, email, stellar-rpc) is classified into a **tier**:

| Tier     | Examples              | Behaviour when down                              |
|----------|-----------------------|--------------------------------------------------|
| critical | postgres, schema      | Returns 503; readiness probe shows "down"        |
| optional | redis, email, stellar | Fallback activated; readiness probe shows "degraded" |

The `CircuitBreakerService` implements the classic three-state machine:

```
CLOSED → (threshold failures) → OPEN → (reset timeout) → HALF_OPEN → (probe success) → CLOSED
                                                                    → (probe failure)  → OPEN
```

Thresholds and timeouts are set per dependency at module initialisation.

### Injecting CircuitBreakerService

```typescript
import { CircuitBreakerService } from '../health/circuit-breaker.service';

constructor(private readonly cb: CircuitBreakerService) {
  // Register once at startup
  this.cb.register('email', { failureThreshold: 5, resetTimeoutMs: 30_000, tier: 'optional' });
}

async sendEmail(payload: EmailPayload) {
  if (this.cb.isOpen('email')) {
    this.logger.warn('email circuit open — skipping send, will retry later');
    return; // graceful degraded mode
  }
  try {
    await this.mailer.send(payload);
    this.cb.recordSuccess('email');
  } catch (err) {
    this.cb.recordFailure('email');
    throw err;
  }
}
```

### Fallback levels

| Level    | Behaviour                                                                         |
|----------|-----------------------------------------------------------------------------------|
| none     | Request fails immediately with 503 (critical deps only)                           |
| cached   | Serve stale data from in-process or Redis cache                                   |
| skip     | Fire-and-forget: log the failure and move on (email, webhooks)                    |
| disabled | Feature is disabled until circuit closes (Redis queues when ENABLE_BACKGROUND_JOBS=false) |

### Checking circuit status

```bash
# Via the /health/status endpoint:
curl http://localhost:5000/api/health/status
# Returns { state: "ready" | "degraded" | "down", checks: {...} }
```

### Manual reset (maintenance window)

```typescript
// Inject CircuitBreakerService and call:
circuitBreaker.reset('email');
```

---

## 2. Alert Deduplication and Ownership (#97)

**Source file:** `xconfess-backend/src/health/alert-manager.ts`

### Problem

Without deduplication, a single Postgres outage fires a new alert every health-check cycle (every 30 s), flooding the on-call channel and hiding the incident in noise.

### How AlertManager works

1. **Identity key** — built from `alertName + service + labels`. Two alerts with the same key are considered duplicates.
2. **Dedup window** — critical alerts are deduplicated for 5 minutes; warnings for 15 minutes; info for 1 hour.
3. **Maintenance mode** — call `alertManager.setMaintenanceMode(true)` during planned maintenance to suppress all alerts.

### Ownership map

Every service area has a registered owner in `ALERT_OWNERSHIP_MAP`:

| Service     | Owner handle          | Channel                | Runbook                              |
|-------------|----------------------|------------------------|--------------------------------------|
| database    | @xconfess/backend    | #incidents             | disaster-recovery-runbook.md         |
| redis       | @xconfess/backend    | #incidents             | incident-runbook.md                  |
| queues      | @xconfess/backend    | #incidents             | notification-delivery-reliability.md |
| auth        | @xconfess/backend    | #security              | incident-runbook.md                  |
| stellar-rpc | @xconfess/backend    | #stellar-incidents     | stellar-anchor-and-tipping-runbook.md|
| email       | @xconfess/backend    | #incidents             | notification-delivery-reliability.md |
| frontend    | @xconfess/frontend   | #incidents             | production-critical-path.md          |

To add a new service area, add an entry to `ALERT_OWNERSHIP_MAP` in `alert-manager.ts`.

### Using AlertManager

```typescript
import { AlertManager } from '../health/alert-manager';

const alerts = new AlertManager();

// Fire an alert (deduplicated automatically)
const alert = alerts.fire({
  alertName: 'postgres.down',
  severity: 'critical',
  service: 'database',
  message: 'Postgres is unreachable',
});

if (alert.state === 'firing') {
  // Page the owner
  console.log(`Page ${alert.owner.handle} at ${alert.owner.channel}`);
  console.log(`Runbook: ${alert.owner.runbookUrl}`);
}

// Resolve when dependency recovers
alerts.resolve(alert.identityKey);
```

---

## 3. Backup Restore Verification (#98)

**Source file:** `scripts/verify-backup-restore.js`

### Purpose

Backups are only useful if they can be restored. This drill verifies:
1. **RPO check** — the backup is recent enough (default: ≤ 1 hour old).
2. **Restore check** — `pg_restore` completes within the RTO (default: ≤ 4 hours).
3. **Integrity check** — the restored database contains at least one `confessions` row.

### Running a drill

```bash
# Dry run (no actual restore):
node scripts/verify-backup-restore.js --dry-run --backup-file=/tmp/xconfess-backup.dump

# Full drill against a sandbox database:
node scripts/verify-backup-restore.js \
  --backup-file=/tmp/xconfess-backup.dump \
  --target-db=postgres://user:pass@localhost:5432/drill_test \
  --rto-minutes=30 \
  --rpo-hours=1
```

### Safety guarantees

- **Never runs against production.** The script refuses connections matching `*.render.com`, `*.rds.amazonaws.com`, or hostnames containing `prod`.
- All encryption keys come from the secrets manager — the dump file is never co-located with key material.
- Results are written to `readiness-results/backup-drill-<timestamp>.json` for audit trail.

### Scheduling drills

Add to your CI/CD pipeline or cron:

```yaml
# .github/workflows/backup-drill.yml (example — adapt to your scheduler)
- name: Backup restore drill
  run: |
    node scripts/verify-backup-restore.js \
      --backup-file=${{ env.STAGING_BACKUP_PATH }} \
      --target-db=${{ secrets.STAGING_DRILL_DB }} \
      --dry-run   # remove for full drill
```

### RPO / RTO targets

| Metric | Target  |
|--------|---------|
| RPO    | ≤ 1 hour |
| RTO    | ≤ 4 hours |

See [`docs/disaster-recovery-runbook.md`](disaster-recovery-runbook.md) for the full restore procedure.

---

## 4. Chaos Experiments (#99)

**Source files:**
- `xconfess-backend/src/health/chaos-experiments.ts` — catalogue
- `scripts/run-chaos-experiment.js` — dry-run runner / documentation tool

### Available experiments

| ID                            | Target       | Duration |
|-------------------------------|--------------|----------|
| exp-01-postgres-loss          | postgres     | 60 s     |
| exp-02-redis-loss             | redis        | 60 s     |
| exp-03-duplicate-jobs         | queue-worker | 30 s     |
| exp-04-process-kill           | process      | 15 s     |
| exp-05-stellar-rpc-timeout    | stellar-rpc  | 120 s    |

### Running experiments

```bash
# List all experiments:
node scripts/run-chaos-experiment.js --list

# Print the plan for a specific experiment (dry run):
node scripts/run-chaos-experiment.js --experiment=exp-01-postgres-loss

# All experiments (dry run):
node scripts/run-chaos-experiment.js --experiment=all --dry-run
```

Actual fault injection is done **manually** by following the `injectionSteps` documented in each experiment. This is intentional — automated injection requires dedicated tooling (e.g. Chaos Monkey, Chaos Mesh) that exceeds the current infrastructure scope.

### Safety guarantees

- All experiments declare `NODE_ENV !== "production"` as a precondition.
- `assertStagingEnvironment()` throws before any experiment runs if `NODE_ENV=production` or `DATABASE_URL` matches a production hostname.
- Each experiment has an `abortCondition` that must be checked every 30 s during the run.

### When an experiment fails its hypothesis

1. Note the observed vs. expected metrics.
2. Open a follow-up issue using the `remediationOnFailure` text as the title.
3. Link the experiment ID and the failing metric in the issue body.
4. Do not re-run the experiment until the remediation issue is resolved.

### Adding a new experiment

Add a new `ChaosExperiment` object to the `CHAOS_EXPERIMENTS` array in
`xconfess-backend/src/health/chaos-experiments.ts`.  All fields are required.
The corresponding unit test (`chaos-experiments.spec.ts`) will automatically
validate the new entry's structure.
