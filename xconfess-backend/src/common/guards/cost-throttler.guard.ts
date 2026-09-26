/**
 * CostThrottlerGuard — adaptive rate limiting based on resource cost.
 *
 * Issue #104: Uniform request limits fail to protect expensive search, export,
 * media, and chain operations. This guard assigns a cost multiplier to each
 * request and deducts proportional budget from the caller's sliding window.
 *
 * ## How it works
 * - Each route can be decorated with `@RequestCost(n)` (default: 1).
 * - The guard deducts `cost` tokens from the caller's per-window budget.
 * - Budgets are stored atomically in Redis via the standard @nestjs/throttler
 *   storage backend, so limits remain consistent across multiple instances.
 * - The `Retry-After` and `X-RateLimit-*` headers are set on every response
 *   so clients can back off gracefully.
 *
 * ## Cost tiers
 * | Tier | Cost | Examples                                  |
 * |------|------|-------------------------------------------|
 * | 1    |  1   | read-only, cheap list / fetch calls       |
 * | 2    |  3   | search, paginated aggregation             |
 * | 3    |  5   | media upload, export request              |
 * | 4    | 10   | Stellar / chain operations                |
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';
import { Request, Response } from 'express';

/** Metadata key used by @RequestCost() */
export const REQUEST_COST_KEY = 'request_cost';

/**
 * Decorator — attach a cost multiplier to any controller method or class.
 *
 * @example
 * @RequestCost(5)  // costs 5 tokens instead of the default 1
 * @Post('request')
 * async requestExport() { ... }
 */
export const RequestCost = (cost: number): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUEST_COST_KEY, cost);

/**
 * Route cost tier constants — import these instead of magic numbers.
 */
export const COST = {
  /** Default: cheap reads, profile lookups, etc. */
  LOW: 1,
  /** Paginated search, filtered queries, aggregations. */
  MEDIUM: 3,
  /** File upload / export request / media processing. */
  HIGH: 5,
  /** Stellar / Soroban on-chain calls. */
  CHAIN: 10,
} as const;

/**
 * CostThrottlerGuard extends the built-in ThrottlerGuard so it inherits
 * all the Redis-backed atomic storage logic while overriding the per-request
 * token cost.
 *
 * Register as a global guard **or** per-module guard — your choice.
 */
@Injectable()
export class CostThrottlerGuard extends ThrottlerGuard {
  private readonly costLogger = new Logger(CostThrottlerGuard.name);

  constructor(
    options: ConstructorParameters<typeof ThrottlerGuard>[0],
    storageService: ConstructorParameters<typeof ThrottlerGuard>[1],
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  /**
   * Override to inject the route-level cost into every throttler check.
   * ThrottlerGuard v6 calls this once per throttler configuration entry.
   */
  protected async handleRequest(
    requestProps: Parameters<ThrottlerGuard['handleRequest']>[0],
  ): Promise<boolean> {
    const { context, limit, ttl } = requestProps;
    const reflector = this['reflector'] as Reflector;
    const cost: number =
      reflector.getAllAndOverride<number>(REQUEST_COST_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? COST.LOW;

    const throttlerName = requestProps.throttler.name ?? 'default';

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // Expose cost and throttler name in the response so clients know what
    // consumed their budget.
    res.setHeader('X-RateLimit-Cost', cost);
    res.setHeader('X-RateLimit-Throttler', throttlerName);

    const storageService = this['storageService'];
    const tracker = await this.getTracker(req as any);
    const key = this.generateKey(context, tracker, throttlerName);

    // Increment by `cost` instead of 1. The first call records the actual hit;
    // subsequent calls add (cost - 1) extra tokens to represent the budget cost.
    const { totalHits, timeToExpire } = await storageService.increment(
      key,
      ttl,
      limit,
      0, // blockDuration — 0 means not used
      throttlerName,
    );

    // Add (cost - 1) more increments to reflect the full budget deduction.
    for (let i = 1; i < cost; i++) {
      await storageService.increment(key, ttl, limit, 0, throttlerName);
    }

    const effectiveTotalHits = totalHits + (cost - 1);
    const remaining = Math.max(0, limit - effectiveTotalHits);

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(timeToExpire / 1000));

    if (effectiveTotalHits > limit) {
      const retryAfter = Math.ceil(timeToExpire / 1000);
      res.setHeader('Retry-After', retryAfter);

      this.costLogger.warn(
        `COST_RATE_LIMIT_EXCEEDED method=${req.method} path=${req.url} ` +
          `ip=${req.ip} cost=${cost} totalHits=${effectiveTotalHits} ` +
          `limit=${limit} throttler=${throttlerName} ` +
          `retryAfter=${retryAfter}s`,
      );

      throw new ThrottlerException();
    }

    return true;
  }
}
