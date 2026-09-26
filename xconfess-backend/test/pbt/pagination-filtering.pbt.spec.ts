import {
  Mulberry32PRNG,
  createGenerators,
  forAll,
  GeneratedConfession,
  GeneratedQuery,
} from './pbt-runner';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

/**
 * Reference implementation of safe pagination, filtering, and authorization
 * matching backend confession & admin queue query contracts.
 */
function executeFeedQuery(
  records: GeneratedConfession[],
  query: GeneratedQuery,
): {
  data: GeneratedConfession[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
} {
  // 1. Sanitize Limit (DB safety & boundary clamping)
  let limit = parseInt(String(query.limit), 10);
  if (isNaN(limit) || limit <= 0) {
    limit = DEFAULT_LIMIT;
  } else if (limit > MAX_LIMIT) {
    limit = MAX_LIMIT;
  }

  // 2. Authorization and Visibility Checks
  const isAdmin = query.role === 'admin';
  let filtered = records.filter((r) => {
    // Non-admins can only see non-deleted, approved confessions
    if (!isAdmin) {
      if (r.isDeleted) return false;
      if (r.status !== 'approved') return false;
    }
    return true;
  });

  // 3. Filter by Tag
  if (query.tag && typeof query.tag === 'string') {
    const cleanTag = query.tag.trim().toLowerCase();
    // Safety check: sanitize potential SQL fragments
    if (cleanTag.includes("'") || cleanTag.includes(';')) {
      filtered = []; // Safe no-match on hostile input
    } else {
      filtered = filtered.filter((r) => r.tag.toLowerCase() === cleanTag);
    }
  }

  // 4. Filter by Status (Admin queue only)
  if (isAdmin && query.status && query.status !== 'all') {
    filtered = filtered.filter((r) => r.status === query.status);
  }

  // 5. Ordering
  const sort = query.sort || 'newest';
  filtered.sort((a, b) => {
    if (sort === 'newest') {
      const diff = b.created_at.getTime() - a.created_at.getTime();
      return diff !== 0 ? diff : b.id.localeCompare(a.id);
    } else if (sort === 'oldest') {
      const diff = a.created_at.getTime() - b.created_at.getTime();
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    } else {
      // popular
      const diff = b.view_count - a.view_count;
      return diff !== 0 ? diff : b.id.localeCompare(a.id);
    }
  });

  // 6. Cursor Evaluation
  if (query.cursor) {
    try {
      const decoded = Buffer.from(query.cursor, 'base64').toString('utf-8');
      const cursorPayload = JSON.parse(decoded);
      if (cursorPayload && cursorPayload.id) {
        const cursorIdx = filtered.findIndex((r) => r.id === cursorPayload.id);
        if (cursorIdx >= 0) {
          filtered = filtered.slice(cursorIdx + 1);
        } else {
          // Cursor past data or invalid id
          filtered = [];
        }
      }
    } catch {
      // Malformed cursor: safely treat as empty or start from scratch without unhandled crash
      filtered = [];
    }
  }

  // 7. Pagination Slicing
  const pageItems = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;

  let nextCursor: string | null = null;
  if (hasMore && pageItems.length > 0) {
    const lastItem = pageItems[pageItems.length - 1];
    nextCursor = Buffer.from(
      JSON.stringify({ id: lastItem.id, created_at: lastItem.created_at.toISOString() }),
    ).toString('base64');
  }

  return {
    data: pageItems,
    nextCursor,
    hasMore,
    limit,
  };
}

describe('Property-Based Tests: Pagination & Filtering (Issue #111)', () => {
  it('Property 1 (Ordering Invariant): Results maintain monotonic ordering across all seeds', () => {
    forAll(
      (prng) => {
        const gen = createGenerators(prng);
        const dataset = gen.generateDataset(40);
        const query = gen.generateQuery(dataset);
        return { dataset, query };
      },
      ({ dataset, query }) => {
        const res = executeFeedQuery(dataset, query);
        const items = res.data;

        if (items.length > 1) {
          for (let i = 0; i < items.length - 1; i++) {
            const current = items[i];
            const next = items[i + 1];

            if (query.sort === 'newest') {
              expect(current.created_at.getTime()).toBeGreaterThanOrEqual(next.created_at.getTime());
            } else if (query.sort === 'oldest') {
              expect(current.created_at.getTime()).toBeLessThanOrEqual(next.created_at.getTime());
            } else if (query.sort === 'popular') {
              expect(current.view_count).toBeGreaterThanOrEqual(next.view_count);
            }
          }
        }
      },
      { iterations: 40 },
    );
  });

  it('Property 2 (Cursor Validity & Non-Overlap): Traversing pages produces disjoint union', () => {
    forAll(
      (prng) => {
        const gen = createGenerators(prng);
        const dataset = gen.generateDataset(50);
        return dataset;
      },
      (dataset) => {
        // Iterate page by page through the entire dataset
        let cursor: string | null = null;
        const retrievedIds = new Set<string>();
        let hasMore = true;
        let pagesCount = 0;

        while (hasMore && pagesCount < 20) {
          pagesCount++;
          const res = executeFeedQuery(dataset, {
            role: 'admin', // See all to verify exhaustive pagination
            limit: 10,
            cursor,
            sort: 'newest',
          });

          for (const item of res.data) {
            // Disjointness check: no item should appear twice across pages
            expect(retrievedIds.has(item.id)).toBe(false);
            retrievedIds.add(item.id);
          }

          hasMore = res.hasMore;
          cursor = res.nextCursor;
        }

        // Must retrieve all records without duplicates
        expect(retrievedIds.size).toBe(dataset.length);
      },
      { iterations: 20 },
    );
  });

  it('Property 3 (Limit Invariant & Boundary Clamping): Limit is always bounded between 1 and MAX_LIMIT', () => {
    forAll(
      (prng) => {
        const gen = createGenerators(prng);
        const dataset = gen.generateDataset(30);
        const query = gen.generateQuery(dataset);
        return { dataset, query };
      },
      ({ dataset, query }) => {
        const res = executeFeedQuery(dataset, query);

        expect(res.limit).toBeGreaterThanOrEqual(1);
        expect(res.limit).toBeLessThanOrEqual(MAX_LIMIT);
        expect(res.data.length).toBeLessThanOrEqual(res.limit);
      },
      { iterations: 30 },
    );
  });

  it('Property 4 (Filter Correctness Invariant): All returned records strictly satisfy active filter', () => {
    forAll(
      (prng) => {
        const gen = createGenerators(prng);
        const dataset = gen.generateDataset(40);
        const query = gen.generateQuery(dataset);
        return { dataset, query };
      },
      ({ dataset, query }) => {
        const res = executeFeedQuery(dataset, query);

        for (const item of res.data) {
          if (query.tag && !query.tag.includes("'") && !query.tag.includes(';')) {
            expect(item.tag.toLowerCase()).toBe(query.tag.trim().toLowerCase());
          }
          if (query.role !== 'admin') {
            expect(item.status).toBe('approved');
            expect(item.isDeleted).toBe(false);
          } else if (query.status && query.status !== 'all') {
            expect(item.status).toBe(query.status);
          }
        }
      },
      { iterations: 30 },
    );
  });

  it('Property 5 (Empty Page Invariant): Beyond end of collection returns clean empty page without errors', () => {
    forAll(
      (prng) => {
        const gen = createGenerators(prng);
        const dataset = gen.generateDataset(20);
        // Construct cursor guaranteed to be past end
        const nonExistentCursor = Buffer.from(
          JSON.stringify({ id: 'confession-999999', created_at: new Date(0).toISOString() }),
        ).toString('base64');
        return { dataset, cursor: nonExistentCursor };
      },
      ({ dataset, cursor }) => {
        const res = executeFeedQuery(dataset, { cursor, limit: 10 });
        expect(res.data).toEqual([]);
        expect(res.nextCursor).toBeNull();
        expect(res.hasMore).toBe(false);
      },
      { iterations: 20 },
    );
  });

  it('Property 6 (Query Safety & Authorization Invariant): SQL syntax probes and non-admin queries are safely contained', () => {
    forAll(
      (prng) => {
        const gen = createGenerators(prng);
        const dataset = gen.generateDataset(30);
        return dataset;
      },
      (dataset) => {
        // 1. Hostile SQL injection attempts in tag parameter
        const sqlAttackQuery: GeneratedQuery = {
          tag: "' OR '1'='1' --",
          limit: 10,
        };
        const sqlRes = executeFeedQuery(dataset, sqlAttackQuery);
        // Must return safe empty set, never throw unhandled SQL error
        expect(sqlRes.data).toEqual([]);

        // 2. Authorization probe: guest requesting flagged queue
        const authProbeQuery: GeneratedQuery = {
          role: 'guest',
          status: 'flagged',
        };
        const authRes = executeFeedQuery(dataset, authProbeQuery);
        // Never exposes flagged moderation records to unauthenticated guest
        for (const item of authRes.data) {
          expect(item.status).toBe('approved');
        }
      },
      { iterations: 20 },
    );
  });

  it('Property 7 (Seed Reproducibility): Identical seed generates identical records and test outcomes', () => {
    const fixedSeed = 987654;

    const prng1 = new Mulberry32PRNG(fixedSeed);
    const gen1 = createGenerators(prng1);
    const dataset1 = gen1.generateDataset(15);
    const query1 = gen1.generateQuery(dataset1);
    const res1 = executeFeedQuery(dataset1, query1);

    const prng2 = new Mulberry32PRNG(fixedSeed);
    const gen2 = createGenerators(prng2);
    const dataset2 = gen2.generateDataset(15);
    const query2 = gen2.generateQuery(dataset2);
    const res2 = executeFeedQuery(dataset2, query2);

    expect(dataset1).toEqual(dataset2);
    expect(query1).toEqual(query2);
    expect(res1).toEqual(res2);
  });
});
