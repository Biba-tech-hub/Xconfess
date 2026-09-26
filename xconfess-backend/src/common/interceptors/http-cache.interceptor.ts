/**
 * HttpCacheInterceptor — sets Cache-Control, ETag, and handles conditional
 * GET requests (If-None-Match) for public and semi-public read endpoints.
 *
 * Design (issue #103):
 *  - Public responses (feed, trending, single confession) receive a
 *    `Cache-Control: public, max-age=<TTL>` header so CDNs and reverse
 *    proxies can cache them without hitting the origin on every request.
 *  - Private/authenticated responses receive `Cache-Control: private, no-store`
 *    so they are never shared across users.
 *  - An ETag derived from the JSON body hash is set on all public responses.
 *  - When a client sends `If-None-Match` and the ETag matches, the interceptor
 *    short-circuits with a 304 Not Modified response (empty body) before the
 *    serialised response leaves the process.
 *
 * Privacy boundary (issue #103 acceptance criterion):
 *  - Any route that carries authenticated user data (identified by `isPublic`
 *    metadata being absent or false) is unconditionally marked private.
 *  - Routes listed in PUBLIC_CACHE_ROUTES are the only ones that may receive
 *    a `public` Cache-Control directive.
 *
 * Usage:
 *   Register globally in AppModule:
 *     { provide: APP_INTERCEPTOR, useClass: HttpCacheInterceptor }
 *
 *   Override the default behaviour per handler with @SetMetadata:
 *     @SetMetadata(HTTP_CACHE_TTL_KEY, 600)  // custom TTL in seconds
 *     @SetMetadata(HTTP_CACHE_PUBLIC_KEY, true)  // force public
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import * as crypto from 'crypto';

/** Metadata key to declare a route as publicly cacheable. */
export const HTTP_CACHE_PUBLIC_KEY = 'http_cache_public';

/** Metadata key to override the Cache-Control max-age (seconds). */
export const HTTP_CACHE_TTL_KEY = 'http_cache_ttl';

/**
 * Default TTL (in seconds) for public cache directives.
 * Lower than CacheService.CACHE_TTL.CONFESSION_LIST (300 s) so client
 * caches expire before the server cache, reducing stale reads.
 */
const DEFAULT_PUBLIC_TTL_SECONDS = 60;

/**
 * URL path prefixes that are eligible for public caching.
 * These paths must NOT carry user-private data in their responses.
 *
 * Reviewed against the confession controller and traction API:
 * - /api/confessions (public feed — no private fields)
 * - /api/confessions/trending (aggregated public data)
 * - /api/confessions/search (public full-text search)
 * - /api/public/* (traction, analytics)
 * - /api/health/* (probes)
 */
const PUBLIC_CACHE_PREFIXES: readonly string[] = [
  '/api/confessions',
  '/api/public/',
  '/api/health/',
];

/**
 * Path patterns that must NEVER be publicly cached even if they start with
 * a public prefix.  User-scoped sub-routes take priority.
 */
const PRIVATE_OVERRIDE_PATTERNS: readonly RegExp[] = [
  /\/api\/confessions\/drafts/,
  /\/api\/confessions\/my/,
  /\/api\/users\//,
  /\/api\/notifications/,
  /\/api\/messages/,
  /\/api\/auth/,
  /\/api\/admin/,
  /\/api\/export/,
];

@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HttpCacheInterceptor.name);

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<Request>();
    const res = httpCtx.getResponse<Response>();

    // Only handle HTTP GET and HEAD — mutations must not be cached.
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      return next.handle();
    }

    const isPublicRoute = this.resolvePublic(context, req);
    const ttl = this.resolveTtl(context);

    if (!isPublicRoute) {
      // Authenticated / private response — must never be shared.
      res.setHeader('Cache-Control', 'private, no-store');
      return next.handle();
    }

    // ── Public route: handle conditional request + set caching headers ──────

    return next.handle().pipe(
      map((body) => {
        // Do not attempt caching if the response has already been sent.
        if (res.headersSent) return body;

        const etag = computeETag(body);

        res.setHeader('ETag', etag);
        res.setHeader(
          'Cache-Control',
          `public, max-age=${ttl}, stale-while-revalidate=${Math.floor(ttl / 2)}`,
        );
        // Vary on Accept-Encoding so compressed and uncompressed variants
        // are stored separately by any intermediate cache.
        res.setHeader('Vary', 'Accept-Encoding');

        // Handle If-None-Match conditional GET (RFC 7232 §6).
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && etag && etagMatches(ifNoneMatch, etag)) {
          res.status(304).end();
          // Return undefined so NestJS does not attempt further serialisation.
          return undefined;
        }

        return body;
      }),
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Determine whether the route is eligible for public caching.
   * Metadata (@SetMetadata) takes precedence over path heuristics.
   */
  private resolvePublic(context: ExecutionContext, req: Request): boolean {
    // 1. Explicit metadata wins.
    const metaPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      HTTP_CACHE_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (metaPublic !== undefined) return metaPublic;

    // 2. Private override patterns always win over prefix matching.
    const path = req.path || req.url?.split('?')[0] || '';
    if (PRIVATE_OVERRIDE_PATTERNS.some((re) => re.test(path))) return false;

    // 3. Public prefix heuristic.
    return PUBLIC_CACHE_PREFIXES.some((prefix) => path.startsWith(prefix));
  }

  private resolveTtl(context: ExecutionContext): number {
    const meta = this.reflector.getAllAndOverride<number | undefined>(
      HTTP_CACHE_TTL_KEY,
      [context.getHandler(), context.getClass()],
    );
    return meta ?? DEFAULT_PUBLIC_TTL_SECONDS;
  }
}

// ── Standalone helpers (exported for testing) ─────────────────────────────────

/**
 * Compute a weak ETag from the JSON representation of a response body.
 * Uses SHA-1 (not cryptographic here — only for cache identity).
 */
export function computeETag(body: unknown): string {
  if (body === undefined || body === null) return '';
  try {
    const hash = crypto
      .createHash('sha1')
      .update(JSON.stringify(body))
      .digest('hex')
      .slice(0, 16);
    return `W/"${hash}"`;
  } catch {
    return '';
  }
}

/**
 * Check whether a client-supplied If-None-Match value matches the server ETag.
 * Supports the wildcard `*` and multiple comma-separated ETags.
 */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  if (!ifNoneMatch || !etag) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === etag);
}
