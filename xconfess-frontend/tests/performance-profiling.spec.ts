/**
 * Tests for lib/performance-profiling.ts — Issue #105
 *
 * We test:
 * - PERF_BUDGETS constants have the correct values.
 * - markHydrationStart/markHydrationEnd produces a hydration metric.
 * - observeInteractionLatency registers/removes listeners.
 * - Metrics include correct route, timestamp, and rating fields.
 * - All observers degrade gracefully when the API is unavailable.
 */

import {
  PERF_BUDGETS,
  markHydrationStart,
  markHydrationEnd,
  observeInteractionLatency,
  startPerformanceProfiling,
  type PerformanceMetric,
} from '../lib/performance-profiling';

// ── Minimal browser API stubs ────────────────────────────────────────────────

const marks: Record<string, number> = {};
const measures: Record<string, number> = {};

const mockPerformance = {
  now: jest.fn(() => 0),
  mark: jest.fn((name: string) => { marks[name] = 0; }),
  measure: jest.fn((name: string, _start: string) => { measures[name] = 150; }),
  getEntriesByName: jest.fn((_name: string) => [{ duration: 150 }]),
  getEntriesByType: jest.fn(() => []),
  clearMarks: jest.fn(),
  clearMeasures: jest.fn(),
};

const mockWindow = {
  location: { pathname: '/test-route' },
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
};

beforeAll(() => {
  Object.defineProperty(global, 'performance', { writable: true, value: mockPerformance });
  Object.defineProperty(global, 'window', { writable: true, value: mockWindow });
  Object.defineProperty(global, 'PerformanceObserver', {
    writable: true,
    value: class { observe = jest.fn(); constructor(_cb: () => void) {} },
  });
  Object.defineProperty(global, 'requestAnimationFrame', {
    writable: true,
    value: (cb: () => void) => { cb(); return 0; },
  });
  (global as any).process = { env: { NODE_ENV: 'test' } };
});

beforeEach(() => jest.clearAllMocks());

// ── Budget constants ─────────────────────────────────────────────────────────

describe('PERF_BUDGETS', () => {
  it('LCP_GOOD_MS is 2500', () => expect(PERF_BUDGETS.LCP_GOOD_MS).toBe(2500));
  it('LCP_POOR_MS is 4000', () => expect(PERF_BUDGETS.LCP_POOR_MS).toBe(4000));
  it('CLS_GOOD is 0.1', () => expect(PERF_BUDGETS.CLS_GOOD).toBe(0.1));
  it('CLS_POOR is 0.25', () => expect(PERF_BUDGETS.CLS_POOR).toBe(0.25));
  it('INP_GOOD_MS is 200', () => expect(PERF_BUDGETS.INP_GOOD_MS).toBe(200));
  it('HYDRATION_WARN_MS is 300', () => expect(PERF_BUDGETS.HYDRATION_WARN_MS).toBe(300));
  it('LONG_TASK_MS is 50', () => expect(PERF_BUDGETS.LONG_TASK_MS).toBe(50));
  it('INTERACTION_WARN_MS is 100', () => expect(PERF_BUDGETS.INTERACTION_WARN_MS).toBe(100));
});

// ── Hydration timing ─────────────────────────────────────────────────────────

describe('markHydrationStart', () => {
  it('calls performance.mark with the start key', () => {
    markHydrationStart();
    expect(mockPerformance.mark).toHaveBeenCalledWith('xconfess-hydration-start');
  });

  it('does not throw when performance is unavailable', () => {
    const saved = (global as any).performance;
    delete (global as any).performance;
    expect(() => markHydrationStart()).not.toThrow();
    (global as any).performance = saved;
  });
});

describe('markHydrationEnd', () => {
  it('reports a hydration metric via the reporter callback', () => {
    mockPerformance.getEntriesByName.mockReturnValueOnce([{ duration: 150 }]);
    const reported: PerformanceMetric[] = [];
    markHydrationStart();
    markHydrationEnd((m) => reported.push(m));

    expect(reported).toHaveLength(1);
    expect(reported[0].name).toBe('hydration');
    expect(reported[0].value).toBe(150);
    expect(reported[0].rating).toBe('good');      // 150 < HYDRATION_WARN_MS (300)
    expect(reported[0].route).toBe('/test-route');
    expect(typeof reported[0].timestamp).toBe('string');
  });

  it('rates slow hydration as needs-improvement', () => {
    mockPerformance.getEntriesByName.mockReturnValueOnce([{ duration: 500 }]);
    const reported: PerformanceMetric[] = [];
    markHydrationEnd((m) => reported.push(m));
    expect(reported[0]?.rating).toBe('needs-improvement');
  });

  it('clears marks and measures after reporting', () => {
    mockPerformance.getEntriesByName.mockReturnValueOnce([{ duration: 100 }]);
    markHydrationEnd();
    expect(mockPerformance.clearMarks).toHaveBeenCalled();
    expect(mockPerformance.clearMeasures).toHaveBeenCalled();
  });

  it('does not throw when performance is unavailable', () => {
    const saved = (global as any).performance;
    delete (global as any).performance;
    expect(() => markHydrationEnd()).not.toThrow();
    (global as any).performance = saved;
  });
});

// ── Interaction latency ──────────────────────────────────────────────────────

describe('observeInteractionLatency', () => {
  it('registers click, keydown, pointerdown listeners', () => {
    observeInteractionLatency();
    const registered = (mockWindow.addEventListener as jest.Mock).mock.calls.map((c) => c[0]);
    expect(registered).toContain('click');
    expect(registered).toContain('keydown');
    expect(registered).toContain('pointerdown');
  });

  it('cleanup removes all three listeners', () => {
    const cleanup = observeInteractionLatency();
    cleanup();
    const removed = (mockWindow.removeEventListener as jest.Mock).mock.calls.map((c) => c[0]);
    expect(removed).toContain('click');
    expect(removed).toContain('keydown');
    expect(removed).toContain('pointerdown');
  });

  it('returns no-op when window is undefined', () => {
    const saved = (global as any).window;
    delete (global as any).window;
    const cleanup = observeInteractionLatency();
    expect(() => cleanup()).not.toThrow();
    (global as any).window = saved;
  });
});

// ── startPerformanceProfiling ────────────────────────────────────────────────

describe('startPerformanceProfiling', () => {
  it('returns a cleanup function', () => {
    const cleanup = startPerformanceProfiling();
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });

  it('marks hydration start', () => {
    startPerformanceProfiling();
    expect(mockPerformance.mark).toHaveBeenCalledWith('xconfess-hydration-start');
  });
});
