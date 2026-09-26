import {
  DeterministicClock,
  MockRedisFixture,
  MockQueueFixture,
  MockMailFixture,
  MockStellarFixture,
  FrontendApiBoundaryFixture,
  StateLeakDetector,
} from './deterministic-fixtures';

describe('Deterministic Full-Stack Test Environment (Issue #109)', () => {
  let clock: DeterministicClock;
  let redis: MockRedisFixture;
  let queue: MockQueueFixture;
  let mail: MockMailFixture;
  let stellar: MockStellarFixture;
  let apiBoundary: FrontendApiBoundaryFixture;
  let leakDetector: StateLeakDetector;

  beforeEach(() => {
    clock = new DeterministicClock('2026-09-24T12:00:00.000Z');
    redis = new MockRedisFixture();
    queue = new MockQueueFixture();
    mail = new MockMailFixture();
    stellar = new MockStellarFixture();
    apiBoundary = new FrontendApiBoundaryFixture();

    leakDetector = new StateLeakDetector({
      redis,
      queue,
      mail,
      clock,
    });
  });

  afterEach(() => {
    leakDetector.resetAll();
  });

  describe('Deterministic Clock', () => {
    it('should freeze time to an exact point and advance deterministically', () => {
      clock.freeze('2026-09-24T10:00:00.000Z');
      expect(Date.now()).toBe(new Date('2026-09-24T10:00:00.000Z').getTime());

      // Advance by 5 minutes
      clock.advance(5 * 60 * 1000);
      expect(Date.now()).toBe(new Date('2026-09-24T10:05:00.000Z').getTime());

      clock.restore();
    });
  });

  describe('Mock Redis Fixture', () => {
    it('should support key setting, retrieval, expiration, and flush', async () => {
      clock.freeze('2026-09-24T12:00:00.000Z');
      await redis.set('session:user_1', 'token_abc', 'EX', 60);

      const val = await redis.get('session:user_1');
      expect(val).toBe('token_abc');

      // Fast forward past expiration
      clock.advance(61 * 1000);
      const expiredVal = await redis.get('session:user_1');
      expect(expiredVal).toBeNull();

      clock.restore();
    });

    it('should detect leaked keys across test boundaries', async () => {
      await redis.set('leaked_key', 'leaked_value');
      expect(() => redis.assertNoLeakedKeys()).toThrow(
        /State leak detected in Redis: 1 keys remained uncleaned/,
      );
      await redis.del('leaked_key');
      expect(() => redis.assertNoLeakedKeys()).not.toThrow();
    });
  });

  describe('Mock Queue Fixture & DLQ', () => {
    it('should process jobs synchronously and push failed jobs exceeding max attempts to DLQ', async () => {
      await queue.add('send_notification', { userId: 1, type: 'TIP_RECEIVED' }, { attempts: 2 });

      let attemptsCount = 0;
      await queue.processSync(async () => {
        attemptsCount++;
        throw new Error('Downstream push provider failed');
      });

      expect(attemptsCount).toBe(1);
      expect(queue.getJobsByStatus('failed').length).toBe(1);

      // Process second attempt
      await queue.processSync(async () => {
        attemptsCount++;
        throw new Error('Downstream push provider failed again');
      });

      expect(attemptsCount).toBe(2);
      expect(queue.getDlq().length).toBe(1);
      expect(queue.getDlq()[0].status).toBe('dlq');
      expect(queue.getDlq()[0].error).toBe('Downstream push provider failed again');

      queue.clear();
      expect(() => queue.assertNoLeakedJobs()).not.toThrow();
    });

    it('should detect uncompleted / leaked jobs', async () => {
      await queue.add('unprocessed_job', { data: 123 });
      expect(() => queue.assertNoLeakedJobs()).toThrow(
        /State leak detected in Queue: 1 jobs remained unprocessed/,
      );
      queue.clear();
    });
  });

  describe('Mock Mail Fixture', () => {
    it('should capture outgoing emails deterministically', async () => {
      const email = await mail.sendMail({
        to: 'user@example.com',
        subject: 'Welcome to xConfess',
        template: 'welcome',
        variables: { username: 'anon' },
      });

      expect(email.id).toBe('mail-1');
      expect(email.to).toBe('user@example.com');
      expect(mail.getSentMails().length).toBe(1);

      mail.clear();
      expect(() => mail.assertNoLeakedMails()).not.toThrow();
    });
  });

  describe('Mock Stellar Fixture', () => {
    it('should simulate transactions with deterministic hashes and balance updates', async () => {
      stellar.setBalance('GA_SENDER', 100);
      stellar.setBalance('GB_RECIPIENT', 20);

      const result = await stellar.submitTransaction('GA_SENDER', 'GB_RECIPIENT', 15, 'tip-123');

      expect(result.status).toBe('SUCCESS');
      expect(result.txHash).toBeDefined();
      expect(stellar.getBalance('GA_SENDER')).toBe(85);
      expect(stellar.getBalance('GB_RECIPIENT')).toBe(35);
    });

    it('should simulate network failure paths and rollback gracefully', async () => {
      stellar.setBalance('GA_SENDER', 100);
      stellar.setSimulateFailure(true, 'Horizon server 504 Gateway Timeout');

      await expect(
        stellar.submitTransaction('GA_SENDER', 'GB_RECIPIENT', 10),
      ).rejects.toThrow('Horizon server 504 Gateway Timeout');

      // Balances must remain unchanged on failure
      expect(stellar.getBalance('GA_SENDER')).toBe(100);
    });
  });

  describe('Frontend API Boundary Fixture', () => {
    it('should dispatch mocked routes and enforce status code contracts', async () => {
      apiBoundary.mockEndpoint('GET', '/api/confessions', () => ({
        status: 200,
        data: { items: [], total: 0 },
      }));

      const res = await apiBoundary.dispatch('GET', '/api/confessions');
      expect(res.status).toBe(200);
      expect(res.data.items).toEqual([]);

      const missing = await apiBoundary.dispatch('GET', '/api/unknown');
      expect(missing.status).toBe(404);
    });
  });

  describe('Unified State Leak Detector', () => {
    it('should aggregate leak reports across all components', async () => {
      await redis.set('dirty_key', 'val');
      await queue.add('dirty_job', {});
      await mail.sendMail({ to: 'dirty@example.com', subject: 'dirty', template: 'test' });

      expect(() => leakDetector.assertNoLeaks()).toThrow(/State leak detected in Redis/);
      expect(() => leakDetector.assertNoLeaks()).toThrow(/State leak detected in Queue/);
      expect(() => leakDetector.assertNoLeaks()).toThrow(/State leak detected in Mailer/);

      leakDetector.resetAll();
      expect(() => leakDetector.assertNoLeaks()).not.toThrow();
    });
  });
});
