import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CorrelationContext } from '../common/correlation/correlation.context';

/**
 * Maximum length allowed for a caller-supplied request ID.
 * Prevents header-size abuse and log-line bloat.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Allowlist pattern for caller-supplied correlation IDs.
 *
 * Accepts:
 *  - UUID v4 (standard form, e.g. "550e8400-e29b-41d4-a716-446655440000")
 *  - Alphanumeric slugs with optional hyphens or underscores (e.g. trace-abc123)
 *
 * Rejects anything containing characters that could escape into logs or
 * structured metadata (whitespace, newlines, SQL metacharacters, etc.).
 */
const SAFE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,126}[a-zA-Z0-9])?$/;

/**
 * Validate and sanitize a caller-supplied request ID.
 *
 * Returns the trimmed ID if it passes all checks, or `null` if the caller
 * value must be discarded (a fresh UUID will be generated instead).
 *
 * Validation steps:
 *  1. Must be a non-empty string after trimming.
 *  2. Must not exceed MAX_REQUEST_ID_LENGTH characters.
 *  3. Must match SAFE_ID_PATTERN (no injection-prone characters).
 */
export function sanitizeIncomingRequestId(
  raw: string | string[] | undefined,
): string | null {
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  if (trimmed.length > MAX_REQUEST_ID_LENGTH) return null;
  if (!SAFE_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/**
 * Middleware that attaches a validated correlation ID to every request.
 *
 * Behaviour:
 *  - Accepts `x-request-id` or `x-correlation-id` from the caller.
 *  - Caller-supplied IDs are sanitized (length-bounded, pattern-checked).
 *    An ID that fails validation is silently discarded and replaced with a
 *    fresh UUID v4 — the failure is logged at debug level, never exposed.
 *  - The final ID is stored on `req['requestId']` for downstream consumers.
 *  - The ID is also bound into {@link CorrelationContext} (AsyncLocalStorage)
 *    so it is accessible in BullMQ jobs, Stellar calls, and any async code
 *    that does not have direct access to the request object.
 *  - The ID is echoed back in the `x-request-id` response header.
 *
 * Security notes:
 *  - Caller IDs are never used for auth decisions.
 *  - Secrets, tokens, and PII are never included in the correlation ID.
 *  - Overly-long or pattern-failing IDs are replaced, not rejected (to avoid
 *    client-visible 4xx on every request due to a missing header).
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestIdMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    // Accept x-request-id or x-correlation-id (legacy alias)
    const rawId =
      req.headers['x-request-id'] ?? req.headers['x-correlation-id'];

    const sanitized = sanitizeIncomingRequestId(rawId);

    if (rawId && !sanitized) {
      // Caller provided an ID that failed validation — replace it silently
      this.logger.debug(
        'Discarding invalid caller-supplied request ID; generating a new one.',
      );
    }

    const requestId: string = sanitized ?? uuidv4();

    // 1. Attach to request object for NestJS interceptors and service code
    (req as any).requestId = requestId;

    // 2. Bind into AsyncLocalStorage so jobs and async code outside the
    //    request pipeline can read the same ID without req injection
    CorrelationContext.run(requestId, () => {
      // 3. Echo back in response header
      res.setHeader('x-request-id', requestId);
      next();
    });
  }
}
