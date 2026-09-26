/**
 * Frontend performance profiling — Issue #105.
 *
 * Instruments:
 * - Web Vitals (LCP, CLS, INP, FCP, TTFB) via the web-vitals-style PerformanceObserver API.
 * - Hydration duration per route: measures time from navigationStart to the
 *   first React hydration commit.
 * - Long Tasks (> 50 ms) via the PerformanceLongTaskTiming API.
 * - Key interaction latency (click, keydown, pointerdown).
 *
 * Privacy: no user-identifying information is attached to any metric. Route
 * names are path-only (no query params, no fragments).
 *
 * CI budget checks: thresholds are exported as `PERF_BUDGETS` constants so
 * test runners and CI scripts can import them directly.
 */

// ---------------------------------------------------------------------------
// Budget thresholds (ms / score) — import these in CI or Playwright checks
// ---------------------------------------------------------------------------
export const PERF_BUDGETS = {
  /** Largest Contentful Paint — good < 2500 ms, poor > 4000 ms */
  LCP_GOOD_MS: 2500,
  LCP_POOR_MS: 4000,

  /** Cumulative Layout Shift — good < 0.1, poor > 0.25 */
  CLS_GOOD: 0.1,
  CLS_POOR: 0.25,

  /** Interaction to Next Paint — good < 200 ms, poor > 500 ms */
  INP_GOOD_MS: 200,
  INP_POOR_MS: 500,

  /** First Contentful Paint — good < 1800 ms */
  FCP_GOOD_MS: 1800,

  /** Time to First Byte — good < 800 ms */
  TTFB_GOOD_MS: 800,

  /** Hydration duration — warn when a route takes longer to hydrate */
  HYDRATION_WARN_MS: 300,

  /** Long task threshold (browser-spec: 50 ms) */
  LONG_TASK_MS: 50,

  /** Interaction latency warn threshold */
  INTERACTION_WARN_MS: 100,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricName =
  | 'LCP'
  | 'CLS'
  | 'INP'
  | 'FCP'
  | 'TTFB'
  | 'hydration'
  | 'long-task'
  | 'interaction';

export interface PerformanceMetric {
  name: MetricName;
  /** Numeric value — milliseconds for timing metrics, unitless for CLS */
  value: number;
  /** 'good' | 'needs-improvement' | 'poor' — undefined for non-vitals */
  rating?: 'good' | 'needs-improvement' | 'poor';
  /** Privacy-safe route path, no query or fragment */
  route: string;
  /** ISO timestamp of measurement */
  timestamp: string;
  /** Additional structured fields */
  meta?: Record<string, string | number | boolean>;
}

export type MetricReporter = (metric: PerformanceMetric) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the current route path without query params or fragment. */
function currentRoute(): string {
  if (typeof window === 'undefined') return '/unknown';
  return window.location.pathname;
}

/** Classify a timing value against good/poor thresholds. */
function rateMs(
  value: number,
  good: number,
  poor: number,
): 'good' | 'needs-improvement' | 'poor' {
  if (value <= good) return 'good';
  if (value <= poor) return 'needs-improvement';
  return 'poor';
}

/** Default reporter: structured console output for local dev, silent in prod. */
const defaultReporter: MetricReporter = (metric) => {
  if (typeof window === 'undefined') return;
  if (process.env.NODE_ENV === 'production') return;

  const rating = metric.rating ?? '';
  const icon =
    rating === 'good' ? '✅' : rating === 'poor' ? '🔴' : rating === 'needs-improvement' ? '🟡' : '📊';
  // eslint-disable-next-line no-console
  console.debug(
    `[xconfess:perf] ${icon} ${metric.name} ${metric.value.toFixed(1)}${metric.name === 'CLS' ? '' : 'ms'} (${rating || 'info'}) route=${metric.route}`,
    metric.meta ?? '',
  );
};

// ---------------------------------------------------------------------------
// Core Web Vitals
// ---------------------------------------------------------------------------

/**
 * Observe LCP, CLS, INP, FCP via PerformanceObserver.
 * Falls back gracefully if the browser doesn't support the entry type.
 */
export function observeWebVitals(reporter: MetricReporter = defaultReporter): void {
  if (typeof window === 'undefined' || !('PerformanceObserver' in window)) return;

  // LCP
  try {
    const lcp = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1] as PerformanceEntry & {
        renderTime?: number;
        loadTime?: number;
      };
      const value = last.renderTime || last.loadTime || 0;
      reporter({
        name: 'LCP',
        value,
        rating: rateMs(value, PERF_BUDGETS.LCP_GOOD_MS, PERF_BUDGETS.LCP_POOR_MS),
        route: currentRoute(),
        timestamp: new Date().toISOString(),
      });
    });
    lcp.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    /* entryType not supported */
  }

  // CLS
  try {
    let clsValue = 0;
    const cls = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const layoutShift = entry as PerformanceEntry & {
          hadRecentInput?: boolean;
          value?: number;
        };
        if (!layoutShift.hadRecentInput) {
          clsValue += layoutShift.value ?? 0;
        }
      }
      reporter({
        name: 'CLS',
        value: clsValue,
        rating:
          clsValue <= PERF_BUDGETS.CLS_GOOD
            ? 'good'
            : clsValue <= PERF_BUDGETS.CLS_POOR
              ? 'needs-improvement'
              : 'poor',
        route: currentRoute(),
        timestamp: new Date().toISOString(),
      });
    });
    cls.observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* entryType not supported */
  }

  // INP (Interaction to Next Paint — Chrome 96+)
  try {
    const inp = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const interaction = entry as PerformanceEntry & {
          processingEnd?: number;
          startTime: number;
          duration: number;
        };
        const value = interaction.duration;
        reporter({
          name: 'INP',
          value,
          rating: rateMs(value, PERF_BUDGETS.INP_GOOD_MS, PERF_BUDGETS.INP_POOR_MS),
          route: currentRoute(),
          timestamp: new Date().toISOString(),
          meta: { interactionStart: interaction.startTime },
        });
      }
    });
    // durationThreshold is a Chrome extension to PerformanceObserverInit; cast to any
    // so the type-checker doesn't reject it while still using it at runtime.
    inp.observe({ type: 'event', buffered: true } as any);
  } catch {
    /* entryType not supported */
  }

  // FCP via paint entries
  try {
    const fcp = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') {
          reporter({
            name: 'FCP',
            value: entry.startTime,
            rating: entry.startTime <= PERF_BUDGETS.FCP_GOOD_MS ? 'good' : 'needs-improvement',
            route: currentRoute(),
            timestamp: new Date().toISOString(),
          });
        }
      }
    });
    fcp.observe({ type: 'paint', buffered: true });
  } catch {
    /* entryType not supported */
  }

  // TTFB via navigation timing
  try {
    const nav = performance.getEntriesByType(
      'navigation',
    )[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      const ttfb = nav.responseStart - nav.requestStart;
      reporter({
        name: 'TTFB',
        value: ttfb,
        rating: ttfb <= PERF_BUDGETS.TTFB_GOOD_MS ? 'good' : 'needs-improvement',
        route: currentRoute(),
        timestamp: new Date().toISOString(),
      });
    }
  } catch {
    /* not supported */
  }
}

// ---------------------------------------------------------------------------
// Long Task monitoring
// ---------------------------------------------------------------------------

/**
 * Observe Long Tasks (tasks > 50 ms on the main thread).
 * Long tasks block user interaction and hydration; each one is reported
 * individually so the caller can aggregate or sample as needed.
 */
export function observeLongTasks(reporter: MetricReporter = defaultReporter): void {
  if (typeof window === 'undefined' || !('PerformanceObserver' in window)) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        reporter({
          name: 'long-task',
          value: entry.duration,
          route: currentRoute(),
          timestamp: new Date().toISOString(),
          meta: {
            taskStart: entry.startTime,
            taskDuration: entry.duration,
          },
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {
    /* longtask entryType not supported (Firefox, Safari) */
  }
}

// ---------------------------------------------------------------------------
// Hydration timing
// ---------------------------------------------------------------------------

const HYDRATION_START_MARK = 'xconfess-hydration-start';
const HYDRATION_END_MARK = 'xconfess-hydration-end';
const HYDRATION_MEASURE = 'xconfess-hydration';

/** Call this at the very start of the root layout (before React renders). */
export function markHydrationStart(): void {
  if (typeof performance === 'undefined') return;
  try {
    performance.mark(HYDRATION_START_MARK);
  } catch {
    /* ignore */
  }
}

/** Call this inside a useEffect at the root layout (first effect = post-hydration). */
export function markHydrationEnd(
  reporter: MetricReporter = defaultReporter,
): void {
  if (typeof performance === 'undefined') return;
  try {
    performance.mark(HYDRATION_END_MARK);
    performance.measure(HYDRATION_MEASURE, HYDRATION_START_MARK, HYDRATION_END_MARK);

    const entries = performance.getEntriesByName(HYDRATION_MEASURE);
    if (entries.length > 0) {
      const duration = entries[entries.length - 1].duration;
      reporter({
        name: 'hydration',
        value: duration,
        rating: duration <= PERF_BUDGETS.HYDRATION_WARN_MS ? 'good' : 'needs-improvement',
        route: currentRoute(),
        timestamp: new Date().toISOString(),
        meta: { route: currentRoute() },
      });
    }

    // Clean up marks so re-navigations get fresh measurements.
    performance.clearMarks(HYDRATION_START_MARK);
    performance.clearMarks(HYDRATION_END_MARK);
    performance.clearMeasures(HYDRATION_MEASURE);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Interaction latency
// ---------------------------------------------------------------------------

/**
 * Instrument click, keydown, and pointerdown events to measure the gap
 * between user input and the next animation frame (a proxy for handler cost).
 */
export function observeInteractionLatency(
  reporter: MetricReporter = defaultReporter,
): () => void {
  if (typeof window === 'undefined') return () => {};

  const eventTypes: Array<keyof WindowEventMap> = ['click', 'keydown', 'pointerdown'];

  const handler = (event: Event) => {
    const start = performance.now();
    requestAnimationFrame(() => {
      const duration = performance.now() - start;
      if (duration >= PERF_BUDGETS.INTERACTION_WARN_MS) {
        reporter({
          name: 'interaction',
          value: duration,
          route: currentRoute(),
          timestamp: new Date().toISOString(),
          meta: {
            eventType: event.type,
            target: (event.target as HTMLElement)?.tagName ?? 'unknown',
          },
        });
      }
    });
  };

  for (const type of eventTypes) {
    window.addEventListener(type, handler, { passive: true, capture: true });
  }

  // Return cleanup function for use in React effects
  return () => {
    for (const type of eventTypes) {
      window.removeEventListener(type, handler, { capture: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Convenience: start all instrumentation at once
// ---------------------------------------------------------------------------

/**
 * Bootstrap all performance instrumentation. Call once from the root layout's
 * client component or `instrumentation.ts`.
 *
 * @returns cleanup function — call on unmount if used inside a React effect
 */
export function startPerformanceProfiling(
  reporter: MetricReporter = defaultReporter,
): () => void {
  markHydrationStart();
  observeWebVitals(reporter);
  observeLongTasks(reporter);
  const cleanupInteractions = observeInteractionLatency(reporter);

  return () => {
    cleanupInteractions();
  };
}
