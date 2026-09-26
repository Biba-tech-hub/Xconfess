# API Artifact Generation

This document explains how OpenAPI-generated client files are produced, when to
regenerate them, and how CI detects drift.

## What are API artifacts?

The backend exposes a Swagger/OpenAPI spec at `GET /api` when running locally. A
generation script (`xconfess-frontend/scripts/generate-openapi-client.ts`) reads
this spec and produces typed TypeScript wrappers in:

```
xconfess-frontend/app/lib/api/generated/
  types.ts       — TypeScript interfaces for all API request/response schemas
  api.ts         — Typed wrapper functions for every route
  index.ts       — Re-export barrel

scripts/.api-snapshot.json — Committed snapshot used by the drift check
```

The generated TypeScript files are intentionally gitignored (they require a live
backend to produce). The snapshot (`scripts/.api-snapshot.json`) is committed and
records the controller route count at last generation time so CI can detect drift
without running a backend.

## When to regenerate

Regenerate whenever you:

- Add, remove, or rename a backend API endpoint
- Change a request or response DTO that appears in the Swagger spec
- Add a new controller

## How to regenerate

1. Start the full stack:
   ```bash
   npm run dev:services
   npm run dev:check
   npm run dev:backend
   ```

2. In another terminal, run the generator:
   ```bash
   npx tsx xconfess-frontend/scripts/generate-openapi-client.ts
   ```

3. Update the drift snapshot:
   ```bash
   bash scripts/check-openapi-drift.sh --update-snapshot
   ```

4. Verify the drift check passes:
   ```bash
   bash scripts/check-openapi-drift.sh
   ```

5. Commit the updated snapshot:
   ```bash
   git add scripts/.api-snapshot.json
   git commit -m "chore: update OpenAPI snapshot after route changes"
   ```

## How drift detection works

`scripts/check-openapi-drift.sh` runs four checks:

1. **Snapshot exists** — the `.api-snapshot.json` file is present.
2. **Generated files exist** — `types.ts`, `api.ts`, and `index.ts` are present.
3. **Route count consistency** — counts `@Get()`, `@Post()`, etc. decorators in all
   `*.controller.ts` files and compares against the snapshot's `controllerRouteCount`.
   A mismatch means a route was added or removed without regenerating.
4. **Freshness check** — warns (but does not fail) if any controller file is newer
   than the generated `api.ts`.

The script is intentionally conservative in CI: it does not start the backend to
fetch a live spec (that would require a running server). Instead it validates that
the committed artifacts are internally consistent with the source.

## CI integration

The drift check runs as part of `npm run ci:contract` via the contracts job in
`.github/workflows/ci.yml`. A failed check blocks merging.

To add it to the apps job, append to `.github/workflows/ci.yml`:

```yaml
- name: Check OpenAPI artifact drift
  run: bash scripts/check-openapi-drift.sh
```

## Contract ABI drift (Soroban)

ABI drift for Soroban contracts is handled separately by
`xconfess-contracts/scripts/check-abi-drift.sh`. See
`docs/contract-abi-reference.md` for details.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Missing snapshot` error | Run generation script then `--update-snapshot` |
| `Route count mismatch` in CI | Regenerate client locally and commit updated files |
| `Missing generated files` | Run `npx tsx xconfess-frontend/scripts/generate-openapi-client.ts` |
| Generator fails with `Failed to fetch OpenAPI spec` | Make sure the backend is running on `http://localhost:5000` |
