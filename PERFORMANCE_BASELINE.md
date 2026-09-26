# Performance Baseline

This document defines the frontend bundle and hydration budgets for representative
routes, how they are measured, and how CI enforces them. Budgets exist so that
large dependencies and client components cannot silently regress initial load or
hydration time.

## Representative routes

Budgets are checked on the routes that exercise the heaviest client surfaces:

| Route | Description |
| --- | --- |
| `/` | Landing / marketing shell |
| `/dashboard` | Authenticated dashboard |
| `/composer` | Composer / editor surface |
| `/settings` | Settings and account management |

## Budgets

Budgets are expressed as gzipped transfer sizes for the JavaScript that a route
loads on first paint, plus a hydration time ceiling measured on a throttled
profile.

| Route | Initial JS (gzip) | Route chunk (gzip) | Hydration (ms) |
| --- | --- | --- | --- |
| `/` | 170 KB | 60 KB | 1200 |
| `/dashboard` | 220 KB | 90 KB | 1800 |
| `/composer` | 260 KB | 120 KB | 2200 |
| `/settings` | 200 KB | 80 KB | 1600 |

Shared framework/runtime code counts toward the initial JS budget. Route chunks
are the code that is only needed once the route is entered and should be loaded
via dynamic `import()` so it does not inflate the initial payload.

## Measuring

1. Build the production bundle (`npm run frontend:build`).
2. Run the bundle budget check against the emitted route manifests.
3. Run the hydration budget check against the representative routes.

Both checks read the same budget table above so the numbers stay in one place.

## Enforcing in CI

The frontend pipeline runs the budget checks after the production build. A
violation fails the job and prints the offending route, the measured value, the
budget, and the delta so the regression is actionable:

```
FAIL /composer
  initial JS: 281.4 KB (budget 260 KB, +21.4 KB)
  hydration:  2410 ms (budget 2200 ms, +210 ms)
  largest contributors:
    +18.2 KB  some-heavy-dependency
    +6.1 KB   ./components/ComposerEditor
```

When a budget is exceeded, either reduce the payload or raise the budget with a
justification in the pull request. Raising a budget without justification is not
accepted.

## Oversized imports

The budget check reports the largest contributors to each route's payload. Any
single dependency or module that adds more than 10 KB (gzip) to a route's initial
payload is flagged for review. Prefer:

- dynamic `import()` for code that is only needed after interaction or on a
  specific route,
- route-level code splitting so heavy surfaces do not load on first paint,
- lighter alternatives when a dependency is only used for a small feature.

## Hydration

Hydration budgets cover the time from first paint to the route becoming
interactive on a throttled profile. Regressions usually come from large client
component trees or work done during hydration. Keep client components scoped to
the smallest subtree that needs interactivity and defer non-critical work until
after hydration.

## Validation

Run the full frontend validation before opening a pull request:

```
npm run frontend:lint && npm run frontend:typecheck && npm run frontend:test && npm run frontend:build
```
