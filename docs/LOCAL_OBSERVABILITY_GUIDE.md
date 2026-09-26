# Local Observability and Log-Collecting Workflow

This guide shows contributors how to capture useful diagnostics for bug reports,
reproduce issues reliably, and attach logs to issues and PRs without leaking secrets.

For redaction rules alone, see [LOG_ATTACHING_GUIDE.md](./LOG_ATTACHING_GUIDE.md).
For structured-log field reference and PII handling, see [CONTRIBUTOR_LOGS_GUIDE.md](./CONTRIBUTOR_LOGS_GUIDE.md).

---

## 1. Correlation IDs — your primary trace handle

Every HTTP request generates a `requestId` (also called a `correlationId`). This ID
links a browser error, a frontend proxy log entry, and a backend log line into one
traceable event.

**How to find your correlation ID:**

```bash
# Backend: search logs by request ID
grep 'a1b2c3d4-e5f6' logs/backend.log

# Frontend: look in the JSON error body returned to the browser
# {"correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","statusCode":500}
```

Include the `correlationId` in every bug report. It lets maintainers jump directly
to the relevant log lines without sifting through unrelated traffic.

---

## 2. Capturing backend logs

### Stream to terminal (development)

```bash
npm run dev:backend 2>&1 | tee /tmp/xconfess-backend.log
```

This starts the backend and writes all output to both the terminal and a file.

### Capturing a specific window of events

```bash
# 1. Start a log capture in one terminal
npm run dev:backend 2>&1 | tee /tmp/xconfess-backend.log

# 2. Reproduce the issue in another terminal or browser

# 3. Stop after reproducing, then extract only the relevant lines
grep -A 20 'your-correlation-id' /tmp/xconfess-backend.log
```

### Filtering by subsystem

The structured logger tags each entry with a `subsystem` field. Filter by module:

```bash
# Only confession errors
grep '"subsystem":"confession"' /tmp/xconfess-backend.log | grep '"level":"error"'

# Only auth events
grep '"subsystem":"auth"' /tmp/xconfess-backend.log
```

### TypeORM query logging

To capture the SQL queries behind a failing request, enable query logging temporarily:

```bash
# In xconfess-backend/.env (never commit this change)
TYPEORM_LOGGING=true
```

Restart the backend and reproduce. The SQL queries appear inline in the log stream.
**Remember to revert `TYPEORM_LOGGING=false` before opening a PR.**

---

## 3. Capturing frontend logs

### Browser DevTools

1. Open DevTools → **Console** tab.
2. Right-click anywhere in the console → **Save as…** → `frontend-console.log`.
3. Redact any tokens or emails before attaching.

### Next.js server output

Frontend proxy routes and Server Components log to stdout:

```bash
npm run dev:frontend 2>&1 | tee /tmp/xconfess-frontend.log
```

### Network tab — capturing a failing request

1. DevTools → **Network** tab → check **Preserve log**.
2. Reproduce the failing action.
3. Right-click the failed request → **Copy as cURL**.
4. Redact `Cookie:` and `Authorization:` headers before pasting.

---

## 4. Capturing infrastructure state

Run these before attaching logs to a bug report to give maintainers full context:

```bash
# Check running containers and health status
docker compose -f compose.yaml ps

# Postgres connectivity
docker compose -f compose.yaml exec postgres pg_isready -U postgres -d xconfess

# Redis connectivity
docker compose -f compose.yaml exec redis redis-cli ping

# Backend health endpoints
curl -s http://localhost:5000/api/health/live | python3 -m json.tool
curl -s http://localhost:5000/api/health/ready | python3 -m json.tool
```

The readiness probe (`/api/health/ready`) returns detailed dependency status including
`missingColumns`, `missingIndexes`, and a `hint` when the database schema is out of sync.

---

## 5. Minimal reproduction bundle

When filing a bug that requires the maintainer to reproduce locally, provide:

1. **Node and npm versions:**
   ```bash
   node --version && npm --version
   ```

2. **Environment summary** (no secrets):
   ```bash
   node -e "const e=process.env; console.log({NODE_ENV:e.NODE_ENV, PORT:e.PORT, DB_HOST:e.DB_HOST, REDIS_HOST:e.REDIS_HOST, STELLAR_FEATURES_ENABLED:e.STELLAR_FEATURES_ENABLED})"
   ```

3. **Exact reproduction steps** — list each HTTP request or UI action.

4. **Request correlation ID** — from the error response body.

5. **Redacted log snippet** — from the window immediately around the error.

6. **Docker service state** — output of `docker compose -f compose.yaml ps`.

---

## 6. Queue and job diagnostics (BullMQ / Redis)

When a notification or export job seems stuck:

```bash
# Connect to Redis and inspect queues
docker compose -f compose.yaml exec redis redis-cli

# Inside redis-cli:
# List all BullMQ queue keys
KEYS bull:*

# Count jobs in the notifications queue
LLEN bull:notifications:wait
LLEN bull:notifications:failed

# Inspect a specific failed job (replace <id> with the job ID)
HGETALL bull:notifications:<id>
```

To re-enable job processing in a local dev session:

```bash
# In xconfess-backend/.env
ENABLE_BACKGROUND_JOBS=true
```

---

## 7. Redacting logs before sharing

**Always** redact these before pasting logs anywhere:

| Pattern | Replace with |
|---------|--------------|
| `Bearer eyJ...` | `Bearer [REDACTED_JWT]` |
| Stellar secret keys (`S...`) | `[REDACTED_STELLAR_SECRET]` |
| 64-character hex strings | `[REDACTED_HEX_KEY]` |
| `postgres://user:pass@...` | `postgres://[REDACTED]@...` |
| User email addresses | `[REDACTED_EMAIL]` |
| IP addresses | `[REDACTED_IP]` |

### Quick bash redaction pipeline

```bash
cat /tmp/xconfess-backend.log \
  | sed 's/Bearer [A-Za-z0-9._-]*/Bearer [REDACTED_JWT]/g' \
  | sed 's/S[A-Z2-7]\{55\}/[REDACTED_STELLAR_SECRET]/g' \
  | sed 's/[a-f0-9]\{64\}/[REDACTED_HEX_KEY]/g' \
  | sed 's/[a-zA-Z0-9._%+\-]*@[a-zA-Z0-9.\-]*\.[a-zA-Z]\{2,\}/[REDACTED_EMAIL]/g' \
  > /tmp/xconfess-backend-redacted.log
```

Run the secret-scanning preflight on your redacted file to verify:

```bash
./scripts/secret-scanning-preflight.sh
```

---

## 8. Environment version report

Include this block in every bug report:

```bash
echo "=== xConfess environment ===" && \
  node --version && \
  npm --version && \
  docker --version && \
  docker compose version && \
  git log --oneline -3
```

Paste the output (it contains no secrets).

---

## See also

- [LOG_ATTACHING_GUIDE.md](./LOG_ATTACHING_GUIDE.md) — redaction rules and how to attach log files
- [CONTRIBUTOR_LOGS_GUIDE.md](./CONTRIBUTOR_LOGS_GUIDE.md) — structured log format and field reference
- [HEALTH_ENDPOINT_QUICK_REFERENCE.md](./HEALTH_ENDPOINT_QUICK_REFERENCE.md) — liveness/readiness probe details
- [SOROBAN_SETUP.md](./SOROBAN_SETUP.md) — Rust/contract environment setup
