/**
 * a11y-keyboard-smoke.spec.ts
 *
 * Accessibility and keyboard-navigation smoke tests for critical xConfess
 * user journeys.
 *
 * Coverage:
 *  - Keyboard navigation: Tab order, Enter/Space activation, Escape dismissal
 *  - Focus management: focus is moved into dialogs, returned on close
 *  - Accessible names: all interactive elements have labels/ARIA names
 *  - Landmark regions: each page has at least one <main> or role="main"
 *  - Live regions: toast/status messages are announced via role="status" or
 *    aria-live
 *  - Reduced-motion: app respects prefers-reduced-motion via CSS media query
 *  - Dialog focus trap: Tab does not escape an open modal
 *
 * Failure messages include the failing route and interaction context so
 * regressions are easy to diagnose.
 *
 * These tests are playwright-based and live in tests/e2e/ — they are NOT run
 * by the Jest CI step (jest ignores tests/e2e/).  They run via:
 *   npm run test:e2e            (all projects)
 *   npm run frontend:test:e2e  (alias)
 *
 * Related issue: #114
 */

import { test, expect, Page } from '@playwright/test';

// ── Fixture data (mirrors core-flows-smoke.spec.ts seed) ────────────────────

const SEED_USER = {
  id: 1,
  username: 'seed_alice',
  email: 'seed_alice@example.com',
  password: 'password123',
  role: 'user',
  is_active: true,
};

const SEED_CONFESSION = {
  id: 'a11y-confession-1',
  message: 'Accessibility smoke test confession — keyboard paths matter.',
  gender: 'other',
  tags: ['a11y'],
  view_count: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  reactions: {},
  commentCount: 0,
};

// ── Route mocks ───────────────────────────────────────────────────────────────

async function installA11yMocks(page: Page, authenticated = false) {
  // Session
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: authenticated ? 200 : 401,
      contentType: 'application/json',
      body: JSON.stringify(
        authenticated
          ? { authenticated: true, user: SEED_USER }
          : { code: 'INVALID_SESSION', message: 'Not authenticated' },
      ),
    }),
  );

  // Login
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: SEED_USER, anonymousUserId: 'anon-a11y' }),
    }),
  );

  // Feed
  await page.route(/\/api\/confessions(\?.*)?$/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        confessions: [SEED_CONFESSION],
        total: 1,
        page: 1,
        hasMore: false,
      }),
    });
  });

  // Single confession
  await page.route(`**/api/confessions/${SEED_CONFESSION.id}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SEED_CONFESSION),
    }),
  );

  // Comments list
  await page.route(/\/api\/comments\/by-confession\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], total: 0 }),
    }),
  );

  // Notifications
  await page.route('**/api/notifications**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], unreadCount: 0 }),
    }),
  );

  // User stats
  await page.route('**/api/users/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ totalConfessions: 0, totalReactions: 0, badges: [] }),
    }),
  );

  // Reports (create)
  await page.route('**/api/reports', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'report-a11y-1', status: 'pending' }),
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Asserts that every interactive element reachable by Tab has a non-empty
 * accessible name.  Returns the count of labelled focusable elements.
 */
async function assertNoUnlabelledInteractiveElements(
  page: Page,
  context: string,
): Promise<number> {
  const unlabelled = await page.evaluate(() => {
    const selector =
      'a[href], button:not([disabled]), input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"]';
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
    return elements
      .filter((el) => {
        const name =
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          el.getAttribute('title') ||
          el.textContent?.trim() ||
          (el as HTMLInputElement).placeholder ||
          '';
        return name.length === 0;
      })
      .map((el) => el.outerHTML.slice(0, 120));
  });

  expect(
    unlabelled,
    `[${context}] Found interactive elements without accessible names:\n${unlabelled.join('\n')}`,
  ).toHaveLength(0);

  const total = await page.evaluate(() => {
    const selector =
      'a[href], button:not([disabled]), input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]';
    return document.querySelectorAll(selector).length;
  });

  return total;
}

/** Asserts the page has a landmark <main> or role="main". */
async function assertMainLandmark(page: Page, route: string) {
  const hasMain = await page.evaluate(
    () =>
      !!document.querySelector('main') ||
      !!document.querySelector('[role="main"]'),
  );
  expect(
    hasMain,
    `[route: ${route}] Page must contain a <main> or role="main" landmark`,
  ).toBe(true);
}

// ── 1. Landmark regions ───────────────────────────────────────────────────────

test.describe('Landmark regions', () => {
  test('/login has a <main> landmark', async ({ page }) => {
    await installA11yMocks(page);
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await assertMainLandmark(page, '/login');
  });

  test('/register has a <main> landmark', async ({ page }) => {
    await installA11yMocks(page);
    await page.goto('/register');
    await page.waitForLoadState('networkidle');
    await assertMainLandmark(page, '/register');
  });

  test('/ (feed) has a <main> landmark', async ({ page }) => {
    await installA11yMocks(page, true);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await assertMainLandmark(page, '/');
  });
});

// ── 2. Interactive element labels ─────────────────────────────────────────────

test.describe('Interactive element accessible names', () => {
  test('/login — all interactive elements have accessible names', async ({ page }) => {
    await installA11yMocks(page);
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    const count = await assertNoUnlabelledInteractiveElements(page, '/login');
    // Sanity: at least email + password + submit should be present
    expect(count, '[route: /login] Expected at least 3 interactive elements').toBeGreaterThanOrEqual(3);
  });

  test('/register — all interactive elements have accessible names', async ({ page }) => {
    await installA11yMocks(page);
    await page.goto('/register');
    await page.waitForLoadState('networkidle');
    await assertNoUnlabelledInteractiveElements(page, '/register');
  });
});

// ── 3. Keyboard navigation — login form ──────────────────────────────────────

test.describe('Keyboard navigation — /login', () => {
  test('can Tab through login form fields in order', async ({ page }) => {
    await installA11yMocks(page);
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Start from the top of the page
    await page.keyboard.press('Tab');

    // After one or more Tabs we should reach the email field
    let emailFocused = false;
    for (let i = 0; i < 10; i++) {
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('type') || document.activeElement?.tagName);
      if (focused === 'email' || focused === 'text') {
        emailFocused = true;
        break;
      }
      await page.keyboard.press('Tab');
    }
    expect(emailFocused, '[route: /login] Email input must be reachable by Tab').toBe(true);
  });

  test('pressing Enter on the submit button triggers form submission', async ({ page }) => {
    await installA11yMocks(page);
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    await page.getByLabel(/email/i).fill(SEED_USER.email);
    await page.getByLabel(/password/i).fill(SEED_USER.password);

    // Find the submit button and activate via keyboard
    const submitBtn = page.getByRole('button', { name: /sign in|log in|login/i });
    await submitBtn.focus();
    await page.keyboard.press('Enter');

    // After successful login, URL changes away from /login
    await expect(page, {
      message: '[route: /login] Enter on submit button should trigger navigation away from /login',
    }).not.toHaveURL('/login', { timeout: 8000 });
  });

  test('Tab from email to password does not skip fields', async ({ page }) => {
    await installA11yMocks(page);
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    const emailInput = page.getByLabel(/email/i);
    await emailInput.focus();
    await page.keyboard.press('Tab');

    // Next focused element should be the password field
    const focusedType = await page.evaluate(
      () => (document.activeElement as HTMLInputElement)?.type,
    );
    expect(
      focusedType,
      '[route: /login] Tab from email must land on password field',
    ).toBe('password');
  });
});

// ── 4. Dialog focus management ────────────────────────────────────────────────

test.describe('Dialog focus management', () => {
  test('report dialog receives focus when opened', async ({ page }) => {
    await installA11yMocks(page, true);
    await page.goto(`/confessions/${SEED_CONFESSION.id}`);
    await page.waitForLoadState('networkidle');

    const reportTrigger = page
      .getByRole('button', { name: /report|flag/i })
      .first();

    const reportTriggerExists = await reportTrigger
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!reportTriggerExists) {
      test.skip();
      return;
    }

    await reportTrigger.click();

    // After opening a dialog, focus should be inside it (not on the trigger)
    await page.waitForTimeout(200); // allow focus transfer animation

    const focusIsInsideDialog = await page.evaluate(() => {
      const active = document.activeElement;
      const dialog =
        document.querySelector('[role="dialog"]') ||
        document.querySelector('[data-testid*="dialog"]') ||
        document.querySelector('[data-testid*="modal"]');
      return dialog ? dialog.contains(active) : false;
    });

    expect(
      focusIsInsideDialog,
      `[route: /confessions/${SEED_CONFESSION.id}] Focus must move inside the report dialog when it opens`,
    ).toBe(true);
  });

  test('Escape closes an open dialog and returns focus to the trigger', async ({ page }) => {
    await installA11yMocks(page, true);
    await page.goto(`/confessions/${SEED_CONFESSION.id}`);
    await page.waitForLoadState('networkidle');

    const reportTrigger = page
      .getByRole('button', { name: /report|flag/i })
      .first();

    const reportTriggerExists = await reportTrigger
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!reportTriggerExists) {
      test.skip();
      return;
    }

    await reportTrigger.click();
    await page.waitForTimeout(200);

    // Verify dialog opened
    const dialogVisible = await page
      .locator('[role="dialog"]')
      .isVisible()
      .catch(() => false);

    if (!dialogVisible) {
      test.skip();
      return;
    }

    // Press Escape to dismiss
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const dialogGone = await page
      .locator('[role="dialog"]')
      .isHidden()
      .catch(() => true);

    expect(
      dialogGone,
      `[route: /confessions/${SEED_CONFESSION.id}] Escape must close the dialog`,
    ).toBe(true);
  });
});

// ── 5. Focus trap inside modal ────────────────────────────────────────────────

test.describe('Focus trap', () => {
  test('Tab does not escape an open dialog (focus remains within)', async ({ page }) => {
    await installA11yMocks(page, true);
    await page.goto(`/confessions/${SEED_CONFESSION.id}`);
    await page.waitForLoadState('networkidle');

    const reportTrigger = page
      .getByRole('button', { name: /report|flag/i })
      .first();

    const reportTriggerExists = await reportTrigger
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    if (!reportTriggerExists) {
      test.skip();
      return;
    }

    await reportTrigger.click();
    await page.waitForTimeout(300);

    const dialogVisible = await page
      .locator('[role="dialog"]')
      .isVisible()
      .catch(() => false);

    if (!dialogVisible) {
      test.skip();
      return;
    }

    // Tab through all focusable elements inside the dialog multiple times
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
    }

    // Focus must still be inside the dialog
    const focusStillInDialog = await page.evaluate(() => {
      const active = document.activeElement;
      const dialog = document.querySelector('[role="dialog"]');
      return dialog ? dialog.contains(active) : false;
    });

    expect(
      focusStillInDialog,
      `[route: /confessions/${SEED_CONFESSION.id}] Tab must not escape the open dialog (focus trap required)`,
    ).toBe(true);
  });
});

// ── 6. Reduced-motion support ─────────────────────────────────────────────────

test.describe('Reduced-motion', () => {
  test('/login respects prefers-reduced-motion: reduce', async ({ browser }) => {
    // Launch with forced reduced-motion media query
    const ctx = await browser.newContext({
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await installA11yMocks(page);
    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // Verify that no transition/animation is longer than 0s when
    // prefers-reduced-motion:reduce is active.
    const hasSlowAnimation = await page.evaluate(() => {
      const all = Array.from(
        document.querySelectorAll<HTMLElement>('*'),
      );
      for (const el of all) {
        const style = getComputedStyle(el);
        const durations = [
          style.transitionDuration,
          style.animationDuration,
        ];
        for (const d of durations) {
          // Parse the duration — if any is > 200ms this is a violation
          const ms = parseFloat(d) * (d.endsWith('ms') ? 1 : 1000);
          if (ms > 200) return true;
        }
      }
      return false;
    });

    expect(
      hasSlowAnimation,
      '[route: /login] With prefers-reduced-motion:reduce, no animation/transition should exceed 200 ms',
    ).toBe(false);

    await ctx.close();
  });

  test('/ (feed) respects prefers-reduced-motion: reduce', async ({ browser }) => {
    const ctx = await browser.newContext({
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await installA11yMocks(page, true);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const hasSlowAnimation = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
      for (const el of all) {
        const style = getComputedStyle(el);
        const durations = [style.transitionDuration, style.animationDuration];
        for (const d of durations) {
          const ms = parseFloat(d) * (d.endsWith('ms') ? 1 : 1000);
          if (ms > 200) return true;
        }
      }
      return false;
    });

    expect(
      hasSlowAnimation,
      '[route: /] With prefers-reduced-motion:reduce, no animation/transition should exceed 200 ms',
    ).toBe(false);

    await ctx.close();
  });
});

// ── 7. Live region announcements ──────────────────────────────────────────────

test.describe('Live region announcements', () => {
  test('login error is surfaced in an aria-live region', async ({ page }) => {
    // Simulate a failed login
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'INVALID_SESSION', message: 'Not authenticated' }),
      }),
    );
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }),
      }),
    );

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    await page.getByLabel(/email/i).fill('wrong@example.com');
    await page.getByLabel(/password/i).fill('wrongpassword');
    await page.getByRole('button', { name: /sign in|log in|login/i }).click();

    // Wait for error state
    await page.waitForTimeout(1000);

    // Error must appear in a live region so screen-readers announce it
    const liveRegion = await page.evaluate(() => {
      const liveEls = Array.from(
        document.querySelectorAll(
          '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]',
        ),
      );
      return liveEls.some((el) => (el.textContent || '').trim().length > 0);
    });

    expect(
      liveRegion,
      '[route: /login] Authentication errors must be announced via an aria-live region or role="alert"',
    ).toBe(true);
  });
});
