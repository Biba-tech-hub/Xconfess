# Accessibility Checklist

Use this checklist when reviewing UI changes. It complements the automated
color and typography regression checks (issue #43) that run in CI.

## Automated regression checks

Run the full frontend validation suite before merging UI changes:

```
npm run frontend:lint && npm run frontend:test && npm run frontend:test:e2e
```

The suite includes:

- **axe checks** across the core routes (home, dashboard, admin, auth) in both
  light and dark theme variants.
- **Computed-style assertions** for color and typography tokens, so silent
  token drift is caught before it ships.
- **Screenshot checks at 200% text zoom** for the core routes, verifying that
  layout stays usable and no horizontal traps appear.

When a contrast failure is reported, the check output identifies the offending
selector so the fix can be applied at the source rather than patched globally.

## Manual review

- [ ] Color contrast meets WCAG AA in light and dark themes.
- [ ] Text remains readable and reflows at 200% zoom without horizontal scroll.
- [ ] Focus indicators are visible against all backgrounds.
- [ ] Motion respects `prefers-reduced-motion`.
- [ ] Interactive controls expose accessible names and roles.
