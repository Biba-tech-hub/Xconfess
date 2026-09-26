import {
  DatasetGenerator,
  SyntheticUser,
  SyntheticConfession,
} from '../dataset-generator';

describe('DatasetGenerator', () => {
  describe('reproducibility', () => {
    it('produces identical users for the same seed', () => {
      const a = new DatasetGenerator(42).users(20);
      const b = new DatasetGenerator(42).users(20);
      expect(a).toEqual(b);
    });

    it('produces different users for different seeds', () => {
      const a = new DatasetGenerator(1).users(20);
      const b = new DatasetGenerator(2).users(20);
      expect(a).not.toEqual(b);
    });

    it('produces identical confessions for the same seed', () => {
      const gen1 = new DatasetGenerator(7);
      const gen2 = new DatasetGenerator(7);
      const users1 = gen1.users(50);
      const users2 = gen2.users(50);
      expect(gen1.confessions(200, users1)).toEqual(
        gen2.confessions(200, users2),
      );
    });
  });

  describe('users()', () => {
    let users: SyntheticUser[];

    beforeAll(() => {
      users = new DatasetGenerator(1).users(100);
    });

    it('generates the requested count', () => {
      expect(users).toHaveLength(100);
    });

    it('assigns unique IDs', () => {
      const ids = new Set(users.map((u) => u.id));
      expect(ids.size).toBe(100);
    });

    it('assigns only valid roles', () => {
      users.forEach((u) => expect(['user', 'admin']).toContain(u.role));
    });

    it('produces at least one admin with default 5 % ratio over 200 users', () => {
      const large = new DatasetGenerator(99).users(200);
      const admins = large.filter((u) => u.role === 'admin');
      expect(admins.length).toBeGreaterThan(0);
    });

    it('all createdAt values are valid dates', () => {
      users.forEach((u) => expect(u.createdAt).toBeInstanceOf(Date));
    });
  });

  describe('confessions()', () => {
    let gen: DatasetGenerator;
    let users: SyntheticUser[];
    let confessions: SyntheticConfession[];

    beforeAll(() => {
      gen = new DatasetGenerator(2);
      users = gen.users(50);
      confessions = gen.confessions(200, users);
    });

    it('generates the requested count', () => {
      expect(confessions).toHaveLength(200);
    });

    it('assigns unique IDs', () => {
      const ids = new Set(confessions.map((c) => c.id));
      expect(ids.size).toBe(200);
    });

    it('includes anonymous confessions (null authorId)', () => {
      const anon = confessions.filter((c) => c.authorId === null);
      expect(anon.length).toBeGreaterThan(0);
    });

    it('includes non-anonymous confessions (authorId from user pool)', () => {
      const userIds = new Set(users.map((u) => u.id));
      const attributed = confessions.filter(
        (c) => c.authorId !== null && userIds.has(c.authorId!),
      );
      expect(attributed.length).toBeGreaterThan(0);
    });

    it('does not contain PII or production-like data', () => {
      confessions.forEach((c) => {
        // Content should not look like an email address.
        expect(c.content).not.toMatch(/@[a-z0-9]+\.[a-z]{2,}/i);
        // Content should not start with a real-looking proper name (Title Case word not in the fragment list).
        expect(c.content).not.toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+/);
      });
    });

    it('returns empty array when no users are supplied', () => {
      // anonymous-only scenario still works
      const result = new DatasetGenerator(3).confessions(10);
      expect(result).toHaveLength(10);
    });
  });

  describe('reactions()', () => {
    it('generates the requested count', () => {
      const gen = new DatasetGenerator(5);
      const users = gen.users(20);
      const confessions = gen.confessions(100, users);
      const reactions = gen.reactions(500, confessions, users);
      expect(reactions).toHaveLength(500);
    });

    it('returns empty array when confessions pool is empty', () => {
      const gen = new DatasetGenerator(5);
      const users = gen.users(20);
      expect(gen.reactions(50, [], users)).toHaveLength(0);
    });

    it('returns empty array when users pool is empty', () => {
      const gen = new DatasetGenerator(5);
      const confessions = gen.confessions(10);
      expect(gen.reactions(50, confessions, [])).toHaveLength(0);
    });
  });

  describe('comments()', () => {
    it('generates the requested count', () => {
      const gen = new DatasetGenerator(6);
      const users = gen.users(20);
      const confessions = gen.confessions(50, users);
      const comments = gen.comments(100, confessions, users);
      expect(comments).toHaveLength(100);
    });
  });

  describe('notificationJobs()', () => {
    it('generates the requested count', () => {
      const gen = new DatasetGenerator(8);
      const users = gen.users(30);
      const jobs = gen.notificationJobs(200, users);
      expect(jobs).toHaveLength(200);
    });

    it('respects payload byte range', () => {
      const gen = new DatasetGenerator(9);
      const users = gen.users(10);
      const jobs = gen.notificationJobs(100, users, [64, 128]);
      jobs.forEach((j) => {
        expect(j.payloadBytes).toBeGreaterThanOrEqual(64);
        expect(j.payloadBytes).toBeLessThanOrEqual(128);
      });
    });

    it('returns empty array when user pool is empty', () => {
      const gen = new DatasetGenerator(10);
      expect(gen.notificationJobs(50, [])).toHaveLength(0);
    });
  });
});
