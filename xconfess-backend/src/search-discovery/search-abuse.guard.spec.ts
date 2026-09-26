import { SearchAbuseGuard, SEARCH_ABUSE_LIMITS } from './search-abuse.guard';

describe('SearchAbuseGuard', () => {
  let guard: SearchAbuseGuard;

  beforeEach(() => {
    guard = new SearchAbuseGuard();
  });

  // ─── Normal queries ────────────────────────────────────────────────────────

  it('allows a normal short query', () => {
    const result = guard.assess('work stress anxiety');
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.complexityScore).toBeGreaterThan(0);
  });

  it('allows a single-word query', () => {
    const result = guard.assess('loneliness');
    expect(result.allowed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('allows query at the token limit', () => {
    const query = new Array(SEARCH_ABUSE_LIMITS.MAX_TOKENS)
      .fill('word')
      .map((w, i) => `${w}${i}`)
      .join(' ');
    const result = guard.assess(query);
    // All distinct, at exact limit → should be allowed
    expect(result.violations.some((v) => v.code === 'QUERY_TOO_MANY_TOKENS')).toBe(false);
  });

  // ─── Token count violations ────────────────────────────────────────────────

  it('blocks queries exceeding MAX_TOKENS', () => {
    const tooManyWords = new Array(SEARCH_ABUSE_LIMITS.MAX_TOKENS + 1)
      .fill('x')
      .map((_, i) => `word${i}`)
      .join(' ');
    const result = guard.assess(tooManyWords);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.code === 'QUERY_TOO_MANY_TOKENS')).toBe(true);
  });

  // ─── Repetition spam ──────────────────────────────────────────────────────

  it('blocks repetition spam queries', () => {
    // 4 tokens, only 1 distinct → ratio 0.25 < 0.5
    const result = guard.assess('love love love love');
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.code === 'QUERY_REPETITION_SPAM')).toBe(true);
  });

  it('allows a two-word query even when repeated once (single word is trivial)', () => {
    // "word word" → 2 tokens, 1 distinct, ratio 0.5 which is NOT < 0.5
    const result = guard.assess('word word');
    // ratio is exactly 0.5, which does NOT trigger (< 0.5 is the check)
    expect(result.violations.some((v) => v.code === 'QUERY_REPETITION_SPAM')).toBe(false);
  });

  // ─── Wildcard / regex patterns ─────────────────────────────────────────────

  it('blocks queries containing wildcard asterisk', () => {
    const result = guard.assess('work*stress');
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.code === 'QUERY_CONTAINS_WILDCARDS')).toBe(true);
  });

  it('blocks queries containing regex characters', () => {
    const result = guard.assess('work(stress|anxiety)');
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.code === 'QUERY_CONTAINS_WILDCARDS')).toBe(true);
  });

  it('blocks square bracket patterns', () => {
    const result = guard.assess('conf[e]ssion');
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.code === 'QUERY_CONTAINS_WILDCARDS')).toBe(true);
  });

  // ─── Length guard ──────────────────────────────────────────────────────────

  it('blocks queries exceeding MAX_QUERY_LENGTH', () => {
    const longQuery = 'a '.repeat(SEARCH_ABUSE_LIMITS.MAX_QUERY_LENGTH / 2 + 1);
    const result = guard.assess(longQuery);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.code === 'QUERY_TOO_LONG')).toBe(true);
  });

  // ─── Pagination depth ──────────────────────────────────────────────────────

  it('blocks deep pagination offset exceeding MAX_RESULT_OFFSET', () => {
    // page=51, limit=10 → offset=500 which equals the limit, but 50*10=500 NOT > 500
    // Use page=52 to exceed
    const result = guard.assess('anxiety', 52, 10);
    expect(result.allowed).toBe(false);
    expect(result.violations.some((v) => v.code === 'PAGINATION_DEPTH_EXCEEDED')).toBe(true);
  });

  it('allows pagination at exactly the limit', () => {
    // page=50, limit=10 → offset=490 which is < 500
    const result = guard.assess('anxiety', 50, 10);
    expect(result.violations.some((v) => v.code === 'PAGINATION_DEPTH_EXCEEDED')).toBe(false);
  });

  it('allows page=1 with any normal limit', () => {
    const result = guard.assess('anxiety', 1, 100);
    expect(result.violations.some((v) => v.code === 'PAGINATION_DEPTH_EXCEEDED')).toBe(false);
  });

  // ─── Multiple violations ───────────────────────────────────────────────────

  it('accumulates multiple violations', () => {
    // Long query + wildcards
    const wildcardLong = '*'.repeat(5) + ' test'.repeat(20);
    const result = guard.assess(wildcardLong, 100, 50);
    expect(result.violations.length).toBeGreaterThan(1);
    expect(result.allowed).toBe(false);
  });

  // ─── Complexity score ──────────────────────────────────────────────────────

  it('returns a higher complexity score for longer queries', () => {
    const simple = guard.assess('hello');
    const complex = guard.assess('hello world foo bar baz');
    // complex should score higher (more tokens)
    expect(complex.complexityScore).toBeGreaterThan(simple.complexityScore);
  });

  // ─── Abuse events are not logged with raw query ────────────────────────────
  // (Structural test: we can only verify the log call signature via a spy,
  //  not the absence of the raw string at the OS level — but we document intent.)
  it('does not expose the raw query in the returned violation object', () => {
    const query = 'my super secret query text***';
    const result = guard.assess(query);
    for (const v of result.violations) {
      expect(v.message).not.toContain(query);
      expect(v.code).not.toContain(query);
    }
  });
});
