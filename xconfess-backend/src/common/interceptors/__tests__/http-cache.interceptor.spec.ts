import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import {
  HttpCacheInterceptor,
  computeETag,
  etagMatches,
  HTTP_CACHE_PUBLIC_KEY,
  HTTP_CACHE_TTL_KEY,
} from '../http-cache.interceptor';

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let ended = false;
  return {
    headers,
    headersSent: false,
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    end() {
      ended = true;
    },
    get statusCode() { return statusCode; },
    get ended() { return ended; },
  };
}

function makeCtx(
  method: string,
  path: string,
  ifNoneMatch?: string,
  metaPublic?: boolean,
  metaTtl?: number,
) {
  const res = makeRes();
  const reqHeaders: Record<string, string | undefined> = {};
  if (ifNoneMatch) reqHeaders['if-none-match'] = ifNoneMatch;

  const reflector = {
    getAllAndOverride: (_key: string) => {
      if (_key === HTTP_CACHE_PUBLIC_KEY) return metaPublic;
      if (_key === HTTP_CACHE_TTL_KEY) return metaTtl;
      return undefined;
    },
  } as unknown as Reflector;

  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ method, path, url: path, headers: reqHeaders }),
      getResponse: () => res,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  return { ctx, res, reflector };
}

describe('HttpCacheInterceptor', () => {
  describe('public routes', () => {
    it('sets Cache-Control: public for /api/confessions', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/confessions');
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({ data: [] }) }).toPromise();
      expect(res.headers['cache-control']).toMatch(/^public/);
    });

    it('sets an ETag header', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/confessions');
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({ data: 'test' }) }).toPromise();
      expect(res.headers['etag']).toMatch(/^W\//);
    });

    it('sets Vary: Accept-Encoding', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/confessions');
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({}) }).toPromise();
      expect(res.headers['vary']).toBe('Accept-Encoding');
    });

    it('returns 304 and suppresses body when ETag matches If-None-Match', async () => {
      const body = { data: [{ id: 1 }] };
      const etag = computeETag(body);
      const { ctx, res, reflector } = makeCtx('GET', '/api/confessions', etag);
      const interceptor = new HttpCacheInterceptor(reflector);
      const result = await interceptor.intercept(ctx, { handle: () => of(body) }).toPromise();
      expect(result).toBeUndefined();
      expect(res.ended).toBe(true);
    });

    it('does NOT return 304 when ETag does not match', async () => {
      const body = { data: 'hello' };
      const { ctx, res, reflector } = makeCtx('GET', '/api/confessions', 'W/"stale"');
      const interceptor = new HttpCacheInterceptor(reflector);
      const result = await interceptor.intercept(ctx, { handle: () => of(body) }).toPromise();
      expect(result).toEqual(body);
      expect(res.ended).toBe(false);
    });

    it('uses custom TTL from metadata', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/confessions', undefined, undefined, 600);
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({}) }).toPromise();
      expect(res.headers['cache-control']).toContain('max-age=600');
    });

    it('handles /api/confessions/trending as public', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/confessions/trending');
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({}) }).toPromise();
      expect(res.headers['cache-control']).toMatch(/^public/);
    });
  });

  describe('private routes', () => {
    it('sets Cache-Control: private, no-store for /api/notifications', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/notifications');
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({}) }).toPromise();
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('sets Cache-Control: private, no-store for /api/messages', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/messages');
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({}) }).toPromise();
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('sets Cache-Control: private, no-store for /api/auth routes', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/auth/me');
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({}) }).toPromise();
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('respects @SetMetadata false override to force private', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/confessions', undefined, false);
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({}) }).toPromise();
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('does not set Cache-Control for POST requests', async () => {
      const { ctx, res, reflector } = makeCtx('POST', '/api/confessions');
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({}) }).toPromise();
      expect(res.headers['cache-control']).toBeUndefined();
    });

    it('treats /api/confessions/drafts as private despite public prefix', async () => {
      const { ctx, res, reflector } = makeCtx('GET', '/api/confessions/drafts');
      const interceptor = new HttpCacheInterceptor(reflector);
      await interceptor.intercept(ctx, { handle: () => of({}) }).toPromise();
      expect(res.headers['cache-control']).toBe('private, no-store');
    });
  });
});

describe('computeETag()', () => {
  it('returns a weak ETag string', () => {
    expect(computeETag({ data: 'hello' })).toMatch(/^W\/"[a-f0-9]+"$/);
  });

  it('produces the same ETag for identical bodies', () => {
    const body = { id: 1, items: [1, 2, 3] };
    expect(computeETag(body)).toBe(computeETag(body));
  });

  it('produces different ETags for different bodies', () => {
    expect(computeETag({ a: 1 })).not.toBe(computeETag({ a: 2 }));
  });

  it('returns empty string for null / undefined', () => {
    expect(computeETag(null)).toBe('');
    expect(computeETag(undefined)).toBe('');
  });
});

describe('etagMatches()', () => {
  const tag = 'W/"abc123"';

  it('returns true for exact match', () => {
    expect(etagMatches(tag, tag)).toBe(true);
  });

  it('returns true for wildcard *', () => {
    expect(etagMatches('*', tag)).toBe(true);
  });

  it('returns true when ETag is in a comma-separated list', () => {
    expect(etagMatches(`W/"other", ${tag}, W/"more"`, tag)).toBe(true);
  });

  it('returns false for non-matching ETags', () => {
    expect(etagMatches('W/"different"', tag)).toBe(false);
  });

  it('returns false for empty strings', () => {
    expect(etagMatches('', tag)).toBe(false);
    expect(etagMatches(tag, '')).toBe(false);
  });
});
