import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';

/**
 * AsyncLocalStorage store shape.
 * Kept intentionally minimal — only the correlation/request ID is stored here.
 * Do NOT store secrets, tokens, or user PII in this context.
 */
interface CorrelationStore {
  requestId: string;
}

/**
 * CorrelationContext
 *
 * A thin wrapper around Node.js `AsyncLocalStorage` that propagates the
 * request ID across the entire async call tree of a single HTTP request,
 * BullMQ job, or Stellar operation — without needing to pass `requestId`
 * through every function argument.
 *
 * Usage in application code:
 * ```ts
 * // Read the current request ID from anywhere in the call chain:
 * const requestId = CorrelationContext.getRequestId();
 *
 * // Run a block of code with a specific request ID (done by middleware):
 * CorrelationContext.run(requestId, async () => { ... });
 * ```
 *
 * Usage in BullMQ job processors:
 * ```ts
 * // At the top of the processor's `process()` method, bind the job's
 * // stored requestId so all downstream service calls are correlated:
 * const requestId = job.data.requestId ?? uuidv4();
 * return CorrelationContext.run(requestId, () => this.doWork(job));
 * ```
 */
export class CorrelationContext {
  private static readonly storage =
    new AsyncLocalStorage<CorrelationStore>();

  /**
   * Run `fn` with `requestId` bound in the async context.
   * Any code called synchronously or asynchronously from within `fn` can
   * read the same ID via {@link getRequestId}.
   */
  static run<T>(requestId: string, fn: () => T): T {
    return CorrelationContext.storage.run({ requestId }, fn);
  }

  /**
   * Return the request ID for the current async execution context.
   * Returns `undefined` when called outside a correlation context
   * (e.g. during module initialisation or in tests that do not set up a context).
   */
  static getRequestId(): string | undefined {
    return CorrelationContext.storage.getStore()?.requestId;
  }

  /**
   * Return the request ID for the current context, or generate a new
   * UUID v4 when there is no active context.  Useful in job processors
   * and fire-and-forget code that may run outside an HTTP request boundary.
   */
  static getOrGenerateRequestId(): string {
    return CorrelationContext.getRequestId() ?? uuidv4();
  }
}
