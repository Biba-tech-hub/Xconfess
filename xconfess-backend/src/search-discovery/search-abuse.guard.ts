/**
 * Search Query Abuse Controls and Cost Budgets (#84)
 *
 * Provides query complexity scoring and enforcement before expensive
 * PostgreSQL full-text operations are dispatched. Rules:
 *
 * - Maximum token count: excessive token counts exhaust lexer memory
 * - Maximum distinct tokens: high-cardinality queries fan out the index scan
 * - Repeated-token ratio: spamming a single token is a cheap amplification
 * - Wildcard-like patterns: tokens that look like glob/regex are banned
 *   because plainto_tsquery normalises them but attackers may combine many
 *
 * Abuse events are emitted as structured log lines (not raw query terms)
 * so dashboards can observe rates without re-logging sensitive content.
 */

import { Injectable, Logger } from '@nestjs/common';

/** Limits that define an "expensive" query. */
export const SEARCH_ABUSE_LIMITS = {
  /**
   * Maximum number of whitespace-delimited tokens in the query string.
   * plainto_tsquery splits on punctuation too, but token count is a safe proxy.
   */
  MAX_TOKENS: 12,

  /**
   * Maximum number of distinct normalised tokens.
   * Distinct > total is impossible; distinct < total reveals repetition spam.
   */
  MAX_DISTINCT_TOKENS: 10,

  /**
   * Ratio of distinct / total tokens below which the query is flagged as
   * repetition-spam (e.g. "love love love love love" → 0.2).
   */
  MIN_DISTINCT_RATIO: 0.5,

  /**
   * Hard character ceiling after DTO-level MaxLength has already enforced 120.
   * Defence-in-depth: catches queries assembled by bypassing the DTO layer.
   */
  MAX_QUERY_LENGTH: 120,

  /**
   * Maximum depth of pagination (page × limit). Prevents deep-offset scans
   * which force Postgres to materialise and discard thousands of ranked rows.
   */
  MAX_RESULT_OFFSET: 500,
} as const;

/**
 * Patterns that look like regex metacharacters or glob wildcards.
 * plainto_tsquery does not support these, but a future query-string parser
 * might; block them pre-emptively.
 */
const REGEX_LIKE_PATTERNS = /[*+?^${}()|[\]\\]/;

export interface SearchAbuseViolation {
  /** Machine-readable code for dashboards / alerting. */
  code: string;
  /** Human-readable guidance returned to the caller. */
  message: string;
}

export interface SearchCostAssessment {
  /** True when the query passes all limits. */
  allowed: boolean;
  /** Numeric complexity score (0 = trivial, higher = more expensive). */
  complexityScore: number;
  /** Non-empty when the query is rejected. */
  violations: SearchAbuseViolation[];
}

@Injectable()
export class SearchAbuseGuard {
  private readonly logger = new Logger(SearchAbuseGuard.name);

  /**
   * Assess a candidate query string and pagination parameters.
   *
   * @param query - The raw search string (post-trim).
   * @param page  - Requested page number (1-based).
   * @param limit - Requested page size.
   * @returns An assessment with allowed=true when the query is within budget.
   */
  assess(
    query: string,
    page: number = 1,
    limit: number = 10,
  ): SearchCostAssessment {
    const violations: SearchAbuseViolation[] = [];

    // ── 1. Hard length guard (defence-in-depth) ─────────────────────────────
    if (query.length > SEARCH_ABUSE_LIMITS.MAX_QUERY_LENGTH) {
      violations.push({
        code: 'QUERY_TOO_LONG',
        message: `Search query must not exceed ${SEARCH_ABUSE_LIMITS.MAX_QUERY_LENGTH} characters.`,
      });
    }

    // ── 2. Wildcard / regex-like characters ─────────────────────────────────
    if (REGEX_LIKE_PATTERNS.test(query)) {
      violations.push({
        code: 'QUERY_CONTAINS_WILDCARDS',
        message:
          'Wildcard and regex-like characters (* + ? ^ $ { } ( ) | [ ] \\) are not supported in search queries.',
      });
    }

    // ── 3. Token-count analysis ──────────────────────────────────────────────
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    if (tokens.length > SEARCH_ABUSE_LIMITS.MAX_TOKENS) {
      violations.push({
        code: 'QUERY_TOO_MANY_TOKENS',
        message: `Search query must contain at most ${SEARCH_ABUSE_LIMITS.MAX_TOKENS} words.`,
      });
    }

    // ── 4. Distinct-token analysis (repetition spam) ─────────────────────────
    const distinctTokens = new Set(tokens);
    if (distinctTokens.size > SEARCH_ABUSE_LIMITS.MAX_DISTINCT_TOKENS) {
      violations.push({
        code: 'QUERY_TOO_MANY_DISTINCT_TOKENS',
        message: `Search query must use at most ${SEARCH_ABUSE_LIMITS.MAX_DISTINCT_TOKENS} distinct words.`,
      });
    }

    if (
      tokens.length > 1 &&
      distinctTokens.size / tokens.length < SEARCH_ABUSE_LIMITS.MIN_DISTINCT_RATIO
    ) {
      violations.push({
        code: 'QUERY_REPETITION_SPAM',
        message:
          'Search query appears to repeat the same words excessively; please use a more varied query.',
      });
    }

    // ── 5. Pagination depth guard ────────────────────────────────────────────
    const offset = Math.max(0, page - 1) * limit;
    if (offset > SEARCH_ABUSE_LIMITS.MAX_RESULT_OFFSET) {
      violations.push({
        code: 'PAGINATION_DEPTH_EXCEEDED',
        message: `Pagination depth (page × limit) must not exceed ${SEARCH_ABUSE_LIMITS.MAX_RESULT_OFFSET} results. Please use a more targeted query or reduce the page number.`,
      });
    }

    // ── Complexity scoring ───────────────────────────────────────────────────
    // Weighted sum of cost signals; used for observability / future rate-limiting.
    const complexityScore =
      tokens.length * 2 +
      distinctTokens.size * 3 +
      Math.floor(offset / 50) +
      (query.length > 60 ? 5 : 0);

    const allowed = violations.length === 0;

    if (!allowed) {
      // Log the abuse event with only structural metadata — never the raw query.
      this.logger.warn({
        event: 'search_abuse_blocked',
        violations: violations.map((v) => v.code),
        tokenCount: tokens.length,
        distinctTokenCount: distinctTokens.size,
        queryLength: query.length,
        paginationOffset: offset,
        complexityScore,
      });
    }

    return { allowed, complexityScore, violations };
  }
}
