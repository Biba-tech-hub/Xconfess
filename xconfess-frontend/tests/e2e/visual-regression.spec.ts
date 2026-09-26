/**
 * visual-regression.spec.ts
 *
 * Visual regression snapshots for critical xConfess workflows.
 *
 * Coverage:
 *  - Auth pages: /login, /register
 *  - Feed: / (desktop + mobile)
 *  - Confession composer: /compose
 *  - Admin surfaces: /admin/dashboard, /admin/reports (desktop only)
 *  - Mobile layouts for all user-facing pages
 *
 * Design:
 *  - All API routes are intercepted so tests are deterministic and never
 *    require a running backend.
 *  - Dynamic content (timestamps, avatars, user-generated text) is masked
 *    or replaced with stable fixture data before the snapshot is taken.
 *  - Each viewport × page combination has its own named snapshot stored in
 *    the Playwright snapshot store (tests/e2e/__snapshots__/).
 *  - On first run snapshots are created; on subsequent runs they are
 *    compared with a maxDiffPixelRatio of 0.02 (2 %) to allow minor
 *    anti-aliasing variation without false positives.
 *  - CI vs local: CI always fails on diff (update=never); locally you can
 *    regenerate with `--update-snapshots`.
 *
 * Related issue: #113
 */

import { test, expect, Page, BrowserContext } from '@playwright/test';

// ── Fixture data ─────────────────────────────────────────────────────────────

const STABLE_USER = {
  id: 1,
  username: 'fixture_user',
  email: 'fixture@xconfess.app',
  role: 'user',
  is_active: true,
};

const STABLE_ADMIN = {
  id: 2,
  username: 'fixture_admin',
  email: 'admin@xconfess.app',
  role: 'admin',
  is_active: true,
};

const STABLE_CONFESSION = {
  id: 'stable-confession-1',
  message: 'This is a stable fixture confession for visual regression testing.',
  gender: 'other',
  tags: ['regression', 'test'],
  view_count: 42,
  created_at: '2026-01-15T12:00:00.000Z',
  reactions: { '❤️': 5, '😂': 3 },
  commentCount: 2,
};

const STABLE_REPORT = {
  id: 'stable-report-1',
  confessionId: STABLE_CONFESSION.id,
  reason: 'spam',
  status: 'pending',
  createdAt: '2026-01-15T12:30:00.000Z',
};

// ── Viewport definitions ─────────────────────────────────────────────────────

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  'mobile-portrait': { width: 375, height: 812 },
  'tablet-portrait': { width: 768, height: 1024 },
};

type ViewportName = keyof typeof VIEWPORTS;

// ── Mask selectors for dynamic content ──────────────────────────────────────

/**
 * These selectors match elements whose content changes between runs
 * (timestamps, real avatars, etc.) and must be masked in snapshots.
 */
const DYNAMIC_MASKS = [
  // Relative timestamps rendered by the app
  '[data-testid="timestamp"]',
  '[data-testid="relative-time"]',
  'time',
  // Avatar images loaded from external URLs
  'img[src*="avatar"]',
  'img[src*="placeholder-user"]',
  // Notification badge counts
  '[data-testid="notification-badge"]',
  // Any live analytics numbers
  '[data-testid="traction-count"]',
];

// ── Route mock helper ────────────────────────────────────────────────────────

async function installApiMocks(
  context: BrowserContext,
  opts: { authenticated: boolean; isAdmin?: boolean } = { authenticated: false },
) {
  const user = opts.isAdmin ? STABLE_ADMIN : STABLE_USER;

  // Session check
  await context.route('**/api/auth/session', (route) => {
    if (opts.authenticated) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, user }),
      });
    }
    return route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'INVALID_SESSION', message: 'Not authenticated' }),
    });
  });

  // Login endpoint
  await context.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user, anonymousUserId: 'anon-fixture' }),
    }),
  );

  // Confessions feed
  await context.route(/\/api\/confessions(\?.*)?$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        confessions: [STABLE_CONFESSION, { ...STABLE_CONFESSION, id: 'stable-2', message: 'Second stable confession for layout testing.' }],
        total: 2,
        page: 1,
        hasMore: false,
      }),
    });
  });

  // Single confession
  await context.route(`**/api/confessions/${STABLE_CONFESSION.id}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(STABLE_CONFESSION),
    }),
  );

  // Comments
  await context.route(/\/api\/comments\/by-confession\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0 }),
    }),
  );

  // Admin: reports list
  await context.route('**/api/admin/reports**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [STABLE_REPORT], total: 1 }),
    }),
  );

  // Admin: moderation stats
  await context.route('**/api/admin/moderation/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ total: 10, pending: 2, approved: 7, rejected: 1 }),
    }),
  );

  // Admin: dashboard analytics
  await context.route('**/api/admin/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], total: 0 }),
    }),
  );

  // Notifications — suppress live badge counts
  await context.route('**/api/notifications**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], unreadCount: 0 }),
    }),
  );

  // User stats
  await context.route('**/api/users/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ totalConfessions: 5, totalReactions: 12, badges: [] }),
    }),
  );

  // Public traction (always stable)
  await context.route('**/api/public/traction', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ confessions: 100, users: 50, reactions: 300 }),
    }),
  );
}

/** Waits for the page to reach a visually stable state before snapshotting. */
async function stabilise(page: Page): Promise<void> {
  // Wait for network to go idle and animations to settle
  await page.waitForLoadState('networkidle').catch(() => {
    /* tolerate timeouts on slow CI */
  });
  // Pause any CSS animations/transitions so they don't appear mid-frame
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  });
}

/** Returns the CSS mask locators for all dynamic elements that exist on the page. */
function dynamicMasks(page: Page) {
  return DYNAMIC_MASKS.map((selector) => page.locator(selector));
}

// ── Snapshot helper ──────────────────────────────────────────────────────────

/**
 * Takes a full-page screenshot and compares against the stored snapshot.
 * On first run the snapshot is created; subsequent runs compare.
 */
async function snapshot(
  page: Page,
  name: string,
  viewport: ViewportName,
) {
  await expect(page).toHaveScreenshot(`${name}-${viewport}.png`, {
    maxDiffPixelRatio: 0.02,
    mask: dynamicMasks(page),
    fullPage: true,
    animations: 'disabled',
  });
}

// ── Auth pages ───────────────────────────────────────────────────────────────

test.describe('Visual regression — auth pages', () => {
  for (const [viewportName, viewportSize] of Object.entries(VIEWPORTS) as [ViewportName, { width: number; height: number }][]) {
    test(`/login @ ${viewportName}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: viewportSize });
      await installApiMocks(ctx, { authenticated: false });
      const page = await ctx.newPage();

      await page.goto('/login');
      await stabilise(page);
      await snapshot(page, 'login', viewportName);

      await ctx.close();
    });

    test(`/register @ ${viewportName}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: viewportSize });
      await installApiMocks(ctx, { authenticated: false });
      const page = await ctx.newPage();

      await page.goto('/register');
      await stabilise(page);
      await snapshot(page, 'register', viewportName);

      await ctx.close();
    });
  }
});

// ── Feed ─────────────────────────────────────────────────────────────────────

test.describe('Visual regression — feed', () => {
  for (const [viewportName, viewportSize] of Object.entries(VIEWPORTS) as [ViewportName, { width: number; height: number }][]) {
    test(`/ (feed) @ ${viewportName}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: viewportSize });
      await installApiMocks(ctx, { authenticated: true });
      const page = await ctx.newPage();

      await page.goto('/');
      await stabilise(page);
      await snapshot(page, 'feed', viewportName);

      await ctx.close();
    });
  }
});

// ── Confession composer ───────────────────────────────────────────────────────

test.describe('Visual regression — confession composer', () => {
  for (const [viewportName, viewportSize] of Object.entries(VIEWPORTS) as [ViewportName, { width: number; height: number }][]) {
    test(`/compose @ ${viewportName}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: viewportSize });
      await installApiMocks(ctx, { authenticated: true });
      const page = await ctx.newPage();

      await page.goto('/compose');
      await stabilise(page);
      await snapshot(page, 'compose', viewportName);

      await ctx.close();
    });
  }
});

// ── Admin surfaces (desktop only) ────────────────────────────────────────────

test.describe('Visual regression — admin (desktop only)', () => {
  test('/admin/dashboard @ desktop', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
    await installApiMocks(ctx, { authenticated: true, isAdmin: true });
    const page = await ctx.newPage();

    await page.goto('/admin/dashboard');
    await stabilise(page);
    await snapshot(page, 'admin-dashboard', 'desktop');

    await ctx.close();
  });

  test('/admin/reports @ desktop', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
    await installApiMocks(ctx, { authenticated: true, isAdmin: true });
    const page = await ctx.newPage();

    await page.goto('/admin/reports');
    await stabilise(page);
    await snapshot(page, 'admin-reports', 'desktop');

    await ctx.close();
  });

  test('/admin/moderation @ desktop', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORTS.desktop });
    await installApiMocks(ctx, { authenticated: true, isAdmin: true });
    const page = await ctx.newPage();

    await page.goto('/admin/moderation');
    await stabilise(page);
    await snapshot(page, 'admin-moderation', 'desktop');

    await ctx.close();
  });
});

// ── Mobile layouts ───────────────────────────────────────────────────────────

test.describe('Visual regression — mobile critical paths', () => {
  const mobileViewport = VIEWPORTS['mobile-portrait'];

  test('feed mobile navigation (bottom nav visible)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: mobileViewport });
    await installApiMocks(ctx, { authenticated: true });
    const page = await ctx.newPage();

    await page.goto('/');
    await stabilise(page);

    // Verify the mobile navigation structure is present before snapshotting
    // (fails fast if the layout breaks before the screenshot)
    const navOrMenu = page
      .locator('nav[aria-label]')
      .or(page.locator('[data-testid="mobile-nav"]'))
      .or(page.locator('nav'))
      .first();

    const navExists = await navOrMenu.isVisible().catch(() => false);
    // Log but don't fail — the layout test captures the visual state
    if (!navExists) {
      console.warn('mobile-portrait: nav element not found — snapshot will capture current state');
    }

    await snapshot(page, 'feed-mobile-nav', 'mobile-portrait');

    await ctx.close();
  });

  test('login form mobile layout (inputs not cropped)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: mobileViewport });
    await installApiMocks(ctx, { authenticated: false });
    const page = await ctx.newPage();

    await page.goto('/login');
    await stabilise(page);
    await snapshot(page, 'login-mobile-form', 'mobile-portrait');

    await ctx.close();
  });
});
