# Validation Command Matrix

This matrix maps each change area to the exact commands you must run locally before opening a pull request.
Copy-paste each command directly into your terminal from the repository root.

> **Tip:** When in doubt, run `npm run ci` — it covers backend, frontend, and contract checks in one shot.

---

## Quick Reference

| Change Area | Lint / Format | Tests | Build | Full CI shortcut |
|---|---|---|---|---|
| [Docs](#docs) | _(none required)_ | _(none required)_ | _(none required)_ | _(none required)_ |
| [Frontend — Component](#frontend--component) | `npm run frontend:lint` | `npm run frontend:test` | `npm run frontend:build` | `npm run ci:frontend` |
| [Frontend — Route / Page](#frontend--route--page) | `npm run frontend:lint` | `npm run frontend:test` | `npm run frontend:build` | `npm run ci:frontend` |
| [Frontend — Accessibility (WCAG 2.2 AA)](#frontend--accessibility-wcag-22-aa) | `npm run frontend:lint` | `npm run frontend:test` | `npm run frontend:build` | `npm run ci:frontend` |
| [Backend — Service / Controller](#backend--service--controller) | `npm run backend:lint` | `npm run backend:test` | `npm run backend:build` | `npm run ci:backend` |
| [Database Migration](#database-migration) | `npm run backend:lint` | `npm run backend:test` | `npm run backend:migration:run` | `npm run ci:backend` |
| [Stellar / Soroban Contract](#stellar--soroban-contract) | `npm run contract:lint` | `npm run contract:test` | `npm run contract:build` | `npm run ci:contract` |
| [Ops / Scripts](#ops--scripts) | _(none required)_ | _(manual smoke)_ | _(none required)_ | `npm run deploy:preflight` |

---

## Docs

Changes to `.md` files, diagrams, screenshots, or any file under `docs/`.

```bash
# No automated commands required.
# Verify rendering by previewing the markdown in your editor or GitHub preview.
```

**Acceptance gate:** Markdown renders correctly with no broken links or malformed tables.

---

## Frontend — Component

Changes to reusable UI components (files under `xconfess-frontend/src/components/`).

```bash
# 1. Lint
npm run frontend:lint

# 2. Type-check
npm run frontend:typecheck

# 3. Unit tests
npm run frontend:test

# 4. Build (catches type errors missed by the dev server)
npm run frontend:build

# — or run all four with one command —
npm run ci:frontend
```

**Acceptance gate:** All four steps exit with code `0`.

---

## Frontend — Route / Page

Changes to page-level components or routing (files under `xconfess-frontend/src/pages/` or route config).

```bash
# 1. Lint
npm run frontend:lint

# 2. Type-check
npm run frontend:typecheck

# 3. Unit tests
npm run frontend:test

# 4. Build
npm run frontend:build

# — or run all four with one command —
npm run ci:frontend

# Optional — smoke tests for proxy routes
npm run frontend:test:smoke
```

**Acceptance gate:** `npm run ci:frontend` exits with code `0`. Smoke tests are optional but recommended for route changes.

---

## Frontend — Accessibility (WCAG 2.2 AA)

Changes that touch interactive UI, focus management, semantics, color, or motion. This section defines the
release-level conformance target and the acceptance gates that must pass before merge.

### Conformance target

Critical routes must meet **WCAG 2.2 Level AA**. "Critical routes" are the primary user journeys:

| Route | Purpose |
|---|---|
| `/` | Landing / entry |
| `/login` | Authentication |
| `/confessions` | Core content list |
| `/confessions/:id` | Core content detail |
| `/compose` | Content creation |
| `/settings` | Account & preferences |

Any route not listed is treated as non-critical but must not regress below the gates below.

### Route / component matrix

Each critical route/component must be verified against every dimension. Mark each cell pass/fail during review.

| Dimension | What to verify | Automated | Manual |
|---|---|---|---|
| **Keyboard** | All interactive elements reachable and operable via keyboard; no keyboard traps; logical tab order | `frontend:test` (a11y unit tests) | Tab through route end-to-end |
| **Focus** | Visible focus indicator on every focusable element; focus moves to dialogs/route changes and returns on close; no focus loss | `frontend:test` | Keyboard-only walkthrough |
| **Semantics** | Correct roles, landmarks, headings hierarchy, labels, and ARIA only where native semantics are insufficient | `frontend:test` (axe/jest-axe) | Screen-reader pass |
| **Contrast** | Text and UI components meet 4.5:1 (text) / 3:1 (large text & UI) | `frontend:test` (axe color-contrast) | Visual check + contrast tool |
| **Motion** | Respect `prefers-reduced-motion`; no non-essential animation; no content that flashes >3 times/sec | `frontend:test` | Toggle OS reduced-motion |
| **Assistive tech** | Names/roles/values announced correctly; live regions for async updates; forms announce errors | `frontend:test` | NVDA/VoiceOver pass |

### Automated checks

```bash
# 1. Lint (includes jsx-a11y rules)
npm run frontend:lint

# 2. Unit + accessibility tests (axe/jest-axe assertions)
npm run frontend:test

# 3. Build
npm run frontend:build

# — or run all three with one command —
npm run ci:frontend

# 4. End-to-end accessibility checks (keyboard + focus flows)
npm run frontend:test:e2e
```

**Acceptance gate:** `npm run frontend:lint && npm run frontend:test && npm run frontend:test:e2e` all exit `0`.
Deterministic a11y assertions (axe violations, focus order, reduced-motion) run in CI and **fail the build on regression**.

### Manual checks

Run these for any change touching a critical route and record results in the PR description:

1. **Keyboard-only** — complete the route's primary task using only Tab/Shift+Tab/Enter/Space/Escape.
2. **Focus visibility** — confirm a visible focus ring on every focusable element, including after route/dialog transitions.
3. **Screen reader** — verify landmarks, headings, labels, and error announcements with NVDA (Windows) or VoiceOver (macOS).
4. **Contrast** — spot-check text and UI controls against 4.5:1 / 3:1 using a contrast tool.
5. **Reduced motion** — enable OS reduced-motion and confirm non-essential animation is suppressed.

**Acceptance gate:** All manual checks pass for every critical route touched; results documented in the PR.

---

## Backend — Service / Controller

Changes to NestJS services, controllers, guards, DTOs, or interceptors (files under `xconfess-backend/src/`).

```bash
# 1. Lint
npm run backend:lint

# 2. Unit tests
npm run backend:test

# 3. Build
npm run backend:build

# — or run all three with one command —
npm run ci:backend

# Optional — end-to-end tests (recommended for new endpoints)
npm run backend:test:e2e
```

**Acceptance gate:** `npm run ci:backend` exits with code `0`.

---

## Database Migration

New TypeORM migration files or changes to existing migrations (files under `xconfess-backend/src/migrations/`).

```bash
# 1. Lint
npm run backend:lint

# 2. Unit tests (entities + migration logic)
npm run backend:test

# 3. Build (ensures the migration compiles)
npm run backend:build

# 4. Apply migration against local database
#    Requires Docker services to be running: npm run dev:services
npm run backend:migration:run

# Verify current migration state
npm run backend:migration:show

# — full backend CI check —
npm run ci:backend
```

> **Warning:** Always run `npm run dev:services` (`docker compose up -d`) before applying migrations locally so PostgreSQL is available.

**Acceptance gate:** `npm run ci:backend` exits `0` and `npm run backend:migration:run` completes without errors.

---

## Stellar / Soroban Contract

Changes to Rust smart contracts under `xconfess-contracts/`.

```bash
# 1. Format check (must pass — rustfmt enforced in CI)
npm run contract:fmt:check

# Auto-fix formatting issues locally
npm run contract:fmt

# 2. Clippy lint
npm run contract:lint

# 3. Unit tests
npm run contract:test

# 4. Release build (WASM output)
npm run contract:build:release

# — or run all four CI steps with one command —
npm run ci:contract

# Optional — integration tests against Soroban sandbox
npm run contract:test:integration

# Optional — deploy to testnet and verify
npm run contract:deploy:testnet
```

**Acceptance gate:** `npm run ci:contract` exits with code `0`. Rustfmt and Clippy must both pass — the CI gate is strict.

---

## Ops / Scripts

Changes to deployment scripts, CI config, Docker files, `render.yaml`, or files under `scripts/`.

```bash
# 1. Run deployment preflight checks
npm run deploy:preflight

# 2. Verify contract environment variables are set
npm run contracts:verify-env

# 3. If secrets-scanning config changed, run the self-test
npm run secret-scan:self-test

# 4. If the change affects a deployed environment, run smoke tests
npm run deploy:smoke
```

**Acceptance gate:** `npm run deploy:preflight` exits with code `0` and no secrets are flagged.

---

## Running Everything at Once

To replicate exactly what CI runs before merging any PR:

```bash
npm run ci
```

This is equivalent to:

```bash
npm run ci:backend && npm run ci:frontend && npm run ci:contract
```

Use this command as a final check before pushing your branch.

---

## See Also

- [CONTRIBUTING.md](../CONTRIBUTING.md) — full contributor guide
- [CI_CHECKS_SUMMARY.md](../CI_CHECKS_SUMMARY.md) — CI pipeline overview
- [docs/SMALL_PR_POLICY.md](SMALL_PR_POLICY.md) — PR size guidelines
