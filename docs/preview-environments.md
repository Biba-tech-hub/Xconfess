# Preview Environment Lifecycle

This document describes the ephemeral preview environment system for xConfess,
implemented as part of issue #128.

## Overview

Every pull request targeting `main` gets an isolated preview environment that
is automatically provisioned on open, updated on push, and destroyed on close.
A daily TTL reaper removes any previews that outlive their configured lifetime.

## Required secrets

Configure these in **Settings → Environments → preview** (not in staging or
production environments):

| Secret | Purpose |
|--------|---------|
| `PREVIEW_DEPLOY_HOST` | Hostname of the preview server (e.g. `preview.xconfess.app`) |
| `PREVIEW_DEPLOY_USER` | SSH user for the preview server |
| `PREVIEW_DEPLOY_SSH_KEY` | SSH private key (PEM) for the preview server |
| `PREVIEW_DB_URL` | Base connection URL for preview databases (a per-PR suffix is appended) |
| `PREVIEW_JWT_SECRET` | JWT signing secret for preview environments |
| `PREVIEW_APP_SECRET` | App HMAC secret for preview environments |

> **Security:** preview secrets are never shared with staging or production.
> The `preview` GitHub environment has no deployment protection rules by default
> so any PR can trigger it; add branch or reviewer protection if your threat
> model requires it.

## Lifecycle

```
PR opened/pushed
       ↓
preview.yml: validate secrets → migration gate → build → deploy → comment PR
       ↓
Preview URL: https://preview-<pr-number>.<PREVIEW_DEPLOY_HOST>

PR closed
       ↓
preview.yml: stop pm2 processes → rm -rf ~/preview-<pr-number>

Daily 03:00 UTC
       ↓
preview.yml (reaper): find expired .preview-meta.json → destroy stale previews
```

## Isolation guarantees

- Each preview runs in its own directory (`~/preview-<pr-number>/`) on the
  preview host.
- A per-PR database is used (`PREVIEW_DB_URL_pr<number>`).  Previews cannot
  read each other's data or production data.
- `STELLAR_FEATURES_ENABLED=false` — previews never interact with on-chain
  signing keys.
- `NEXT_PUBLIC_DEV_BYPASS_AUTH=false` — the auth bypass is never enabled in
  preview containers.

## TTL / expiry

Previews default to a 72-hour TTL, configurable via the `PREVIEW_TTL_HOURS`
env-var in `preview.yml`.  The expiry timestamp is written to
`~/preview-<pr-number>/.preview-meta.json` at deploy time and read by the
daily reaper job.

To extend a preview's lifetime, re-push to the PR (the workflow updates the
metadata with a fresh expiry).

## Retry and cleanup

- The **destroy** job uses `set -euo pipefail` and will fail visibly if
  cleanup does not complete.  Failed cleanups can be retried by re-running
  the "Destroy preview" job from the Actions tab.
- The **reaper** is idempotent — running it multiple times for the same
  expired preview is safe.

## Local simulation

To test the provisioning logic locally without a real server:

```bash
# Verify the migration gate passes before any deploy attempt
node scripts/migration-gate.js

# Verify the secret-scan passes
./scripts/secret-scanning-preflight.sh
```

## Assumptions & follow-up work

- The preview server must have `pm2` and Node.js 22 installed.
- Database creation (`PREVIEW_DB_URL_pr<number>`) must be handled by a
  provisioning script or a managed database service that accepts per-DB
  connection strings.  A follow-up issue should automate this with
  `createdb` or a managed Neon/Supabase branch.
- This workflow does not build Docker images.  If the project adopts
  container-based deployment, replace the rsync/pm2 pattern with
  `docker compose up --detach`.
