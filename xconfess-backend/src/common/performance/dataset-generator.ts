/**
 * Synthetic, privacy-safe performance dataset generator.
 *
 * Generates reproducible fixture data for benchmarks and load tests.
 * No production data is ever used or emitted — all values are fabricated
 * from a numeric seed so runs are deterministic and comparable.
 *
 * Usage:
 *   const gen = new DatasetGenerator(42);
 *   const users = gen.users(100);
 *   const confessions = gen.confessions(1000, users);
 *
 * See docs/performance-workload-profiles.md for documented scale/mix presets.
 */

export interface SyntheticUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
  createdAt: Date;
}

export interface SyntheticConfession {
  id: string;
  authorId: string | null; // null = anonymous
  content: string;
  category: string;
  tags: string[];
  createdAt: Date;
  viewCount: number;
}

export interface SyntheticReaction {
  id: string;
  confessionId: string;
  userId: string;
  emoji: string;
  createdAt: Date;
}

export interface SyntheticComment {
  id: string;
  confessionId: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

export interface SyntheticNotificationJob {
  userId: string;
  type: string;
  title: string;
  message: string;
  payloadBytes: number;
}

/** Lightweight seedable LCG PRNG — no external deps. */
class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Keep seed positive and non-zero.
    this.state = (Math.abs(seed) || 1) >>> 0;
  }

  /** Returns a float in [0, 1). */
  next(): number {
    // LCG parameters from Numerical Recipes.
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  /** Returns an integer in [min, max]. */
  intBetween(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Picks a random element from an array. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Returns a random subset of size n. */
  sample<T>(arr: readonly T[], n: number): T[] {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.min(n, copy.length));
  }

  /** Generates a hex string of given byte length (no real crypto). */
  hex(bytes: number): string {
    let h = '';
    for (let i = 0; i < bytes; i++) {
      h += Math.floor(this.next() * 256)
        .toString(16)
        .padStart(2, '0');
    }
    return h;
  }
}

const CATEGORIES = [
  'relationships',
  'work',
  'family',
  'school',
  'health',
  'finances',
  'personal-growth',
  'regrets',
] as const;

const TAGS = [
  'anonymous',
  'first-time',
  'serious',
  'funny',
  'advice-needed',
  'vent',
  'trigger-warning',
  'success',
] as const;

const EMOJIS = ['❤️', '😂', '😮', '😢', '😡', '👏', '🔥', '💯'] as const;

const CONTENT_FRAGMENTS = [
  'I never told anyone that',
  'Every day I think about',
  'I regret not saying',
  'Nobody knows I',
  'Sometimes I wonder if',
  'The truth is that',
  'I have been hiding',
  'People always assume',
] as const;

/**
 * DatasetGenerator produces synthetic, privacy-safe benchmark fixtures.
 * All data is deterministically generated from a numeric seed.
 */
export class DatasetGenerator {
  private readonly rng: SeededRandom;

  constructor(private readonly seed: number = 0) {
    this.rng = new SeededRandom(seed);
  }

  /**
   * Generate synthetic users.
   * @param count Number of users to generate (default 100).
   * @param adminRatio Fraction that are admins (default 0.05).
   */
  users(count = 100, adminRatio = 0.05): SyntheticUser[] {
    const result: SyntheticUser[] = [];
    const baseDate = new Date('2025-01-01T00:00:00Z');

    for (let i = 0; i < count; i++) {
      const offsetSeconds = this.rng.intBetween(0, 60 * 60 * 24 * 365);
      result.push({
        id: `user-${this.seed}-${i}`,
        username: `user_${this.rng.hex(4)}`,
        role: this.rng.next() < adminRatio ? 'admin' : 'user',
        createdAt: new Date(baseDate.getTime() + offsetSeconds * 1000),
      });
    }

    return result;
  }

  /**
   * Generate synthetic confessions.
   * @param count Number of confessions.
   * @param users Synthetic users to use as authors.
   * @param anonymousRatio Fraction posted anonymously (default 0.6).
   */
  confessions(
    count = 1000,
    users: SyntheticUser[] = [],
    anonymousRatio = 0.6,
  ): SyntheticConfession[] {
    const result: SyntheticConfession[] = [];
    const baseDate = new Date('2025-01-01T00:00:00Z');

    for (let i = 0; i < count; i++) {
      const offsetSeconds = this.rng.intBetween(0, 60 * 60 * 24 * 365);
      const anonymous = this.rng.next() < anonymousRatio;
      const author =
        !anonymous && users.length > 0 ? this.rng.pick(users) : null;
      const tagCount = this.rng.intBetween(0, 3);

      result.push({
        id: `confession-${this.seed}-${i}`,
        authorId: author ? author.id : null,
        content: `${this.rng.pick(CONTENT_FRAGMENTS)} something synthetic_${this.rng.hex(8)}.`,
        category: this.rng.pick(CATEGORIES),
        tags: this.rng.sample(TAGS, tagCount),
        createdAt: new Date(baseDate.getTime() + offsetSeconds * 1000),
        viewCount: this.rng.intBetween(0, 5000),
      });
    }

    return result;
  }

  /**
   * Generate synthetic reactions spread across a confession set.
   * @param count Total reactions to generate.
   * @param confessions Confession pool to target.
   * @param users User pool for reactor IDs.
   */
  reactions(
    count = 5000,
    confessions: SyntheticConfession[] = [],
    users: SyntheticUser[] = [],
  ): SyntheticReaction[] {
    if (confessions.length === 0 || users.length === 0) return [];

    const result: SyntheticReaction[] = [];
    const baseDate = new Date('2025-01-01T00:00:00Z');

    for (let i = 0; i < count; i++) {
      const offsetSeconds = this.rng.intBetween(0, 60 * 60 * 24 * 365);
      result.push({
        id: `reaction-${this.seed}-${i}`,
        confessionId: this.rng.pick(confessions).id,
        userId: this.rng.pick(users).id,
        emoji: this.rng.pick(EMOJIS),
        createdAt: new Date(baseDate.getTime() + offsetSeconds * 1000),
      });
    }

    return result;
  }

  /**
   * Generate synthetic comments spread across a confession set.
   */
  comments(
    count = 2000,
    confessions: SyntheticConfession[] = [],
    users: SyntheticUser[] = [],
  ): SyntheticComment[] {
    if (confessions.length === 0 || users.length === 0) return [];

    const result: SyntheticComment[] = [];
    const baseDate = new Date('2025-01-01T00:00:00Z');

    for (let i = 0; i < count; i++) {
      const offsetSeconds = this.rng.intBetween(0, 60 * 60 * 24 * 365);
      result.push({
        id: `comment-${this.seed}-${i}`,
        confessionId: this.rng.pick(confessions).id,
        authorId: this.rng.pick(users).id,
        body: `Synthetic comment body ${this.rng.hex(8)}.`,
        createdAt: new Date(baseDate.getTime() + offsetSeconds * 1000),
      });
    }

    return result;
  }

  /**
   * Generate synthetic BullMQ-style notification job payloads.
   * Sizes are bounded so workload profiles can test oversized-payload guards.
   *
   * @param count Number of jobs.
   * @param users User pool.
   * @param payloadBytesRange Inclusive [min, max] bytes for each job payload.
   */
  notificationJobs(
    count = 500,
    users: SyntheticUser[] = [],
    payloadBytesRange: [number, number] = [128, 512],
  ): SyntheticNotificationJob[] {
    if (users.length === 0) return [];

    const types = [
      'reaction',
      'comment',
      'follow',
      'moderation',
      'tip',
    ] as const;
    const result: SyntheticNotificationJob[] = [];

    for (let i = 0; i < count; i++) {
      const payloadBytes = this.rng.intBetween(
        payloadBytesRange[0],
        payloadBytesRange[1],
      );
      const type = this.rng.pick(types);
      result.push({
        userId: this.rng.pick(users).id,
        type,
        title: `Synthetic ${type} notification`,
        message: `Message body ${this.rng.hex(8)}`,
        payloadBytes,
      });
    }

    return result;
  }
}
