/**
 * Seedable Property-Based Testing Utility (Issue #111)
 *
 * Uses Mulberry32 PRNG to generate deterministic, reproducible pseudo-random
 * data and property test cases across configurable seeds.
 */

export class Mulberry32PRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  nextBoolean(): boolean {
    return this.next() >= 0.5;
  }

  pick<T>(array: T[]): T {
    const idx = this.nextInt(0, array.length - 1);
    return array[idx];
  }

  nextString(length: number = 8): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789_';
    let res = '';
    for (let i = 0; i < length; i++) {
      res += this.pick(chars.split(''));
    }
    return res;
  }
}

export interface GeneratedConfession {
  id: string;
  message: string;
  gender: string | null;
  tag: string;
  status: 'approved' | 'pending' | 'flagged';
  view_count: number;
  created_at: Date;
  isDeleted: boolean;
}

export interface GeneratedQuery {
  limit?: any;
  cursor?: string | null;
  sort?: 'newest' | 'oldest' | 'popular';
  tag?: string;
  status?: string;
  role?: 'guest' | 'user' | 'admin';
}

export function createGenerators(prng: Mulberry32PRNG) {
  const TAG_POOL = ['general', 'crypto', 'tech', 'humor', 'gaming', 'life'];
  const GENDER_POOL = ['male', 'female', 'non-binary', null];
  const STATUS_POOL: Array<'approved' | 'pending' | 'flagged'> = ['approved', 'pending', 'flagged'];
  const ADVERSARIAL_INPUTS = [
    "' OR 1=1 --",
    "'; DROP TABLE confessions; --",
    '<script>alert(1)</script>',
    '__proto__',
    'constructor',
    '',
    ' '.repeat(50),
    'A'.repeat(500),
  ];

  return {
    generateConfession(index: number): GeneratedConfession {
      // Base date in 2026 with jitter
      const baseMs = new Date('2026-01-01T00:00:00.000Z').getTime();
      const offsetMs = prng.nextInt(0, 180 * 24 * 60 * 60 * 1000); // 0-180 days

      return {
        id: `confession-${index + 1}`,
        message: `Confession message ${index + 1}: ${prng.nextString(12)}`,
        gender: prng.pick(GENDER_POOL),
        tag: prng.pick(TAG_POOL),
        status: prng.pick(STATUS_POOL),
        view_count: prng.nextInt(0, 10000),
        created_at: new Date(baseMs + offsetMs),
        isDeleted: prng.next() < 0.05, // 5% deleted
      };
    },

    generateDataset(size: number = 30): GeneratedConfession[] {
      const records: GeneratedConfession[] = [];
      for (let i = 0; i < size; i++) {
        records.push(this.generateConfession(i));
      }
      return records;
    },

    generateQuery(records: GeneratedConfession[]): GeneratedQuery {
      const isAdversarial = prng.next() < 0.2; // 20% adversarial
      const sort = prng.pick<'newest' | 'oldest' | 'popular'>(['newest', 'oldest', 'popular']);
      const role = prng.pick<'guest' | 'user' | 'admin'>(['guest', 'user', 'admin']);

      // 30% boundary limits (negative, zero, oversized, non-numeric)
      let limit: any = prng.nextInt(1, 50);
      if (prng.next() < 0.3) {
        limit = prng.pick([-10, 0, 1, 100, 500, 'invalid', null, undefined]);
      }

      // Cursor: either null, valid from a record, or corrupted
      let cursor: string | null = null;
      if (records.length > 0 && prng.next() < 0.5) {
        const randRecord = prng.pick(records);
        const cursorPayload = { id: randRecord.id, created_at: randRecord.created_at.toISOString() };
        cursor = Buffer.from(JSON.stringify(cursorPayload)).toString('base64');
      } else if (prng.next() < 0.1) {
        cursor = 'invalid_non_base64_cursor!@#$';
      }

      let tag: string | undefined = prng.next() < 0.5 ? prng.pick(TAG_POOL) : undefined;
      if (isAdversarial && prng.next() < 0.5) {
        tag = prng.pick(ADVERSARIAL_INPUTS);
      }

      const status = prng.next() < 0.4 ? prng.pick(['approved', 'pending', 'flagged', 'all']) : undefined;

      return {
        limit,
        cursor,
        sort,
        tag,
        status,
        role,
      };
    },
  };
}

export function forAll<T>(
  generator: (prng: Mulberry32PRNG) => T,
  propertyFn: (sample: T, iteration: number, seed: number) => void | Promise<void>,
  options: { iterations?: number; seed?: number } = {},
): void {
  const seed = options.seed ?? parseInt(process.env.SEED || process.env.PBT_SEED || '42', 10);
  const iterations = options.iterations ?? 30;
  const prng = new Mulberry32PRNG(seed);

  for (let i = 0; i < iterations; i++) {
    const sample = generator(prng);
    try {
      propertyFn(sample, i, seed);
    } catch (err: any) {
      throw new Error(
        `[PBT Property Violation]\n` +
          `Failed on iteration ${i + 1}/${iterations} with SEED=${seed}\n` +
          `Input: ${JSON.stringify(sample, null, 2)}\n` +
          `Error: ${err.message}`,
      );
    }
  }
}
