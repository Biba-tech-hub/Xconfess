import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException } from '@nestjs/throttler';
import {
  CostThrottlerGuard,
  COST,
  REQUEST_COST_KEY,
  RequestCost,
} from './cost-throttler.guard';
import { SetMetadata } from '@nestjs/common';

/**
 * Unit tests for CostThrottlerGuard (Issue #104).
 *
 * These tests verify:
 * - The @RequestCost() decorator sets the correct metadata value.
 * - COST tier constants have expected numeric values.
 * - handleRequest deducts proportional budget (cost × tokens).
 * - Requests that exceed the effective limit throw ThrottlerException.
 * - Retry-After and X-RateLimit-* headers are set on throttled responses.
 * - Routes without @RequestCost default to COST.LOW (1 token).
 */
describe('RequestCost decorator', () => {
  it('sets metadata with the correct key and value', () => {
    const cost = 5;
    const decorator = RequestCost(cost);

    // Apply to a dummy method
    class Dummy {
      target() {}
    }
    decorator(Dummy.prototype, 'target', Object.getOwnPropertyDescriptor(Dummy.prototype, 'target')!);

    const meta = Reflect.getMetadata(REQUEST_COST_KEY, Dummy.prototype.target);
    expect(meta).toBe(cost);
  });
});

describe('COST tier constants', () => {
  it('defines LOW as 1', () => expect(COST.LOW).toBe(1));
  it('defines MEDIUM as 3', () => expect(COST.MEDIUM).toBe(3));
  it('defines HIGH as 5', () => expect(COST.HIGH).toBe(5));
  it('defines CHAIN as 10', () => expect(COST.CHAIN).toBe(10));
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeHeaders() {
  const store: Record<string, string | number> = {};
  return {
    setHeader: jest.fn((k: string, v: string | number) => {
      store[k] = v;
    }),
    get: (k: string) => store[k],
  };
}

function makeContext(costMetadata?: number): ExecutionContext {
  const handler = jest.fn();
  if (costMetadata !== undefined) {
    Reflect.defineMetadata(REQUEST_COST_KEY, costMetadata, handler);
  }

  const req = { method: 'GET', url: '/test', ip: '127.0.0.1', headers: {} };
  const res = makeHeaders();

  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

function makeStorageService(initialHits = 0) {
  let hits = initialHits;
  return {
    increment: jest.fn(async (_key, _ttl, _limit, _block, _name) => {
      hits += 1;
      return { totalHits: hits, timeToExpire: 60_000 };
    }),
    getHits: () => hits,
  };
}

function makeGuard(storageService: ReturnType<typeof makeStorageService>, reflector?: Reflector) {
  const r = reflector ?? new Reflector();

  const throttlers = [{ name: 'default', ttl: 60_000, limit: 10 }];

  // Build the guard with mocked internals
  const guard = new CostThrottlerGuard(
    { throttlers } as any,
    storageService as any,
    r,
  );

  // Stub inherited helpers that require a real Redis backend
  (guard as any)['storageService'] = storageService;
  (guard as any)['reflector'] = r;
  (guard as any).getTracker = jest.fn(async () => '127.0.0.1');
  (guard as any).generateKey = jest.fn(() => 'test-key');

  return guard;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CostThrottlerGuard.handleRequest', () => {
  it('allows request and sets headers when under limit (cost=1)', async () => {
    const storage = makeStorageService(0);
    const guard = makeGuard(storage);
    const ctx = makeContext(COST.LOW); // cost=1

    const res = ctx.switchToHttp().getResponse() as ReturnType<typeof makeHeaders>;
    // ThrottlerRequest has limit/ttl at top-level (already resolved)
    const requestProps = {
      context: ctx,
      limit: 10,
      ttl: 60_000,
      blockDuration: 0,
      getTracker: jest.fn(),
      generateKey: jest.fn(),
      throttler: { name: 'default', ttl: 60_000, limit: 10 },
    };

    const result = await (guard as any).handleRequest(requestProps);

    expect(result).toBe(true);
    expect(res.get('X-RateLimit-Cost')).toBe(COST.LOW);
    expect(res.get('X-RateLimit-Limit')).toBe(10);
    expect(res.get('X-RateLimit-Remaining')).toBeGreaterThanOrEqual(0);
  });

  it('deducts COST.HIGH (5) tokens for expensive routes', async () => {
    const storage = makeStorageService(0);
    const guard = makeGuard(storage);
    const ctx = makeContext(COST.HIGH); // cost=5

    const requestProps = {
      context: ctx,
      limit: 20,
      ttl: 60_000,
      blockDuration: 0,
      getTracker: jest.fn(),
      generateKey: jest.fn(),
      throttler: { name: 'default', ttl: 60_000, limit: 20 },
    };
    await (guard as any).handleRequest(requestProps);

    // storageService.increment should have been called `cost` times (1 + 4 extra)
    expect(storage.increment).toHaveBeenCalledTimes(COST.HIGH);
  });

  it('throws ThrottlerException when effective hits exceed limit', async () => {
    // Start at 9 hits; cost=5 pushes effective total to 14 > limit=10
    const storage = makeStorageService(9);
    const guard = makeGuard(storage);
    const ctx = makeContext(COST.HIGH); // cost=5

    const requestProps = {
      context: ctx,
      limit: 10,
      ttl: 60_000,
      blockDuration: 0,
      getTracker: jest.fn(),
      generateKey: jest.fn(),
      throttler: { name: 'default', ttl: 60_000, limit: 10 },
    };

    await expect(
      (guard as any).handleRequest(requestProps),
    ).rejects.toThrow(ThrottlerException);
  });

  it('sets Retry-After header when throttled', async () => {
    const storage = makeStorageService(9);
    const guard = makeGuard(storage);
    const ctx = makeContext(COST.HIGH); // cost=5, limit=10 → exceeded

    const res = ctx.switchToHttp().getResponse() as ReturnType<typeof makeHeaders>;
    const requestProps = {
      context: ctx,
      limit: 10,
      ttl: 60_000,
      blockDuration: 0,
      getTracker: jest.fn(),
      generateKey: jest.fn(),
      throttler: { name: 'default', ttl: 60_000, limit: 10 },
    };

    try {
      await (guard as any).handleRequest(requestProps);
    } catch {
      // expected
    }

    expect(res.get('Retry-After')).toBeDefined();
    expect(Number(res.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('defaults to cost=1 when @RequestCost is not applied', async () => {
    const storage = makeStorageService(0);
    const guard = makeGuard(storage);
    const ctx = makeContext(undefined); // no decorator

    const requestProps = {
      context: ctx,
      limit: 10,
      ttl: 60_000,
      blockDuration: 0,
      getTracker: jest.fn(),
      generateKey: jest.fn(),
      throttler: { name: 'default', ttl: 60_000, limit: 10 },
    };
    await (guard as any).handleRequest(requestProps);

    // Only 1 increment call when cost defaults to 1
    expect(storage.increment).toHaveBeenCalledTimes(1);
  });

  it('sets X-RateLimit-Throttler header', async () => {
    const storage = makeStorageService(0);
    const guard = makeGuard(storage);
    const ctx = makeContext(COST.LOW);

    const res = ctx.switchToHttp().getResponse() as ReturnType<typeof makeHeaders>;
    const requestProps = {
      context: ctx,
      limit: 5,
      ttl: 60_000,
      blockDuration: 0,
      getTracker: jest.fn(),
      generateKey: jest.fn(),
      throttler: { name: 'strict', ttl: 60_000, limit: 5 },
    };

    await (guard as any).handleRequest(requestProps);

    expect(res.get('X-RateLimit-Throttler')).toBe('strict');
  });
});
