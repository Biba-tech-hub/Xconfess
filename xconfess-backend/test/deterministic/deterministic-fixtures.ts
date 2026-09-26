/**
 * Deterministic Test Environment Fixtures
 *
 * Provides isolated, predictable fixtures for Postgres, Redis, Queues,
 * Mail, Stellar mocks, and frontend API boundaries, accompanied by a
 * State Leak Detector to catch leaked state and nondeterminism.
 *
 * Issue: #109
 */

import { DataSource } from 'typeorm';

// ==========================================
// 1. Deterministic Clock
// ==========================================
export class DeterministicClock {
  private currentTime: number;
  private originalDateNow: () => number;
  private originalDate: typeof Date;
  private isFrozen: boolean = false;

  constructor(initialIsoString: string = '2026-09-24T00:00:00.000Z') {
    this.currentTime = new Date(initialIsoString).getTime();
  }

  freeze(isoString?: string): void {
    if (isoString) {
      this.currentTime = new Date(isoString).getTime();
    }
    if (!this.isFrozen) {
      this.originalDateNow = Date.now;
      this.originalDate = global.Date;

      Date.now = () => this.currentTime;
      this.isFrozen = true;
    }
  }

  advance(ms: number): void {
    this.currentTime += ms;
  }

  now(): Date {
    return new Date(this.currentTime);
  }

  nowMs(): number {
    return this.currentTime;
  }

  restore(): void {
    if (this.isFrozen) {
      Date.now = this.originalDateNow;
      this.isFrozen = false;
    }
  }
}

// ==========================================
// 2. Mock Redis Fixture
// ==========================================
export class MockRedisFixture {
  private store: Map<string, { value: string; expiresAt: number | null }> = new Map();
  private subscribers: Map<string, Array<(message: string) => void>> = new Map();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, mode?: string, duration?: number): Promise<'OK'> {
    let expiresAt: number | null = null;
    if (mode === 'EX' && typeof duration === 'number') {
      expiresAt = Date.now() + duration * 1000;
    } else if (mode === 'PX' && typeof duration === 'number') {
      expiresAt = Date.now() + duration;
    }
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async flushall(): Promise<'OK'> {
    this.store.clear();
    this.subscribers.clear();
    return 'OK';
  }

  async keys(pattern: string = '*'): Promise<string[]> {
    if (pattern === '*') return Array.from(this.store.keys());
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    return Array.from(this.store.keys()).filter((k) => regex.test(k));
  }

  async publish(channel: string, message: string): Promise<number> {
    const subs = this.subscribers.get(channel) || [];
    for (const sub of subs) {
      sub(message);
    }
    return subs.length;
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    const subs = this.subscribers.get(channel) || [];
    subs.push(callback);
    this.subscribers.set(channel, subs);
  }

  getActiveKeyCount(): number {
    return this.store.size;
  }

  assertNoLeakedKeys(): void {
    if (this.store.size > 0) {
      const leaked = Array.from(this.store.keys());
      throw new Error(`State leak detected in Redis: ${leaked.length} keys remained uncleaned (${leaked.join(', ')})`);
    }
  }
}

// ==========================================
// 3. Mock Queue Fixture
// ==========================================
export interface QueueJob<T = any> {
  id: string;
  name: string;
  data: T;
  attempts: number;
  maxAttempts: number;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'dlq';
  error?: string;
}

export class MockQueueFixture {
  private jobs: Map<string, QueueJob> = new Map();
  private dlq: QueueJob[] = [];
  private jobCounter: number = 0;

  async add<T>(name: string, data: T, opts: { attempts?: number } = {}): Promise<QueueJob<T>> {
    this.jobCounter++;
    const job: QueueJob<T> = {
      id: `job-${this.jobCounter}`,
      name,
      data,
      attempts: 0,
      maxAttempts: opts.attempts ?? 3,
      status: 'waiting',
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async processSync(handler: (job: QueueJob) => Promise<void>): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.status === 'waiting' || job.status === 'failed') {
        job.status = 'active';
        job.attempts++;
        try {
          await handler(job);
          job.status = 'completed';
        } catch (err: any) {
          job.error = err.message;
          if (job.attempts >= job.maxAttempts) {
            job.status = 'dlq';
            this.dlq.push(job);
          } else {
            job.status = 'failed';
          }
        }
      }
    }
  }

  getDlq(): QueueJob[] {
    return [...this.dlq];
  }

  getJobsByStatus(status: QueueJob['status']): QueueJob[] {
    return Array.from(this.jobs.values()).filter((j) => j.status === status);
  }

  clear(): void {
    this.jobs.clear();
    this.dlq = [];
    this.jobCounter = 0;
  }

  assertNoLeakedJobs(): void {
    const pending = Array.from(this.jobs.values()).filter((j) => j.status === 'waiting' || j.status === 'active');
    if (pending.length > 0) {
      throw new Error(`State leak detected in Queue: ${pending.length} jobs remained unprocessed (${pending.map((j) => j.id).join(', ')})`);
    }
  }
}

// ==========================================
// 4. Mock Mail Fixture
// ==========================================
export interface SentMail {
  id: string;
  to: string;
  subject: string;
  template: string;
  variables: Record<string, any>;
  sentAt: Date;
}

export class MockMailFixture {
  private sentMails: SentMail[] = [];
  private mailCounter: number = 0;

  async sendMail(opts: { to: string; subject: string; template: string; variables?: Record<string, any> }): Promise<SentMail> {
    this.mailCounter++;
    const mail: SentMail = {
      id: `mail-${this.mailCounter}`,
      to: opts.to,
      subject: opts.subject,
      template: opts.template,
      variables: opts.variables || {},
      sentAt: new Date(),
    };
    this.sentMails.push(mail);
    return mail;
  }

  getSentMails(): SentMail[] {
    return [...this.sentMails];
  }

  clear(): void {
    this.sentMails = [];
    this.mailCounter = 0;
  }

  assertNoLeakedMails(): void {
    if (this.sentMails.length > 0) {
      throw new Error(`State leak detected in Mailer: ${this.sentMails.length} unhandled emails in buffer`);
    }
  }
}

// ==========================================
// 5. Mock Stellar Fixture
// ==========================================
export class MockStellarFixture {
  private balances: Map<string, number> = new Map();
  private transactions: Map<string, any> = new Map();
  private simulateFailure: boolean = false;
  private failureReason: string = 'Simulated Stellar Horizon Network Error';

  setBalance(address: string, xlmAmount: number): void {
    this.balances.set(address, xlmAmount);
  }

  getBalance(address: string): number {
    return this.balances.get(address) ?? 100; // Default seeded 100 XLM
  }

  setSimulateFailure(fail: boolean, reason?: string): void {
    this.simulateFailure = fail;
    if (reason) this.failureReason = reason;
  }

  async submitTransaction(sender: string, recipient: string, amount: number, memo?: string): Promise<{ txHash: string; status: 'SUCCESS' }> {
    if (this.simulateFailure) {
      throw new Error(this.failureReason);
    }

    const currentBalance = this.getBalance(sender);
    if (currentBalance < amount) {
      throw new Error('tx_insufficient_balance: sender does not have enough XLM');
    }

    this.balances.set(sender, currentBalance - amount);
    this.balances.set(recipient, this.getBalance(recipient) + amount);

    // Deterministic hash based on sender, recipient, amount, and tx count
    const count = this.transactions.size + 1;
    const txHash = `0x${Buffer.from(`tx-${sender}-${recipient}-${amount}-${count}`).toString('hex').padEnd(64, '0').slice(0, 64)}`;

    const tx = { txHash, sender, recipient, amount, memo, timestamp: new Date().toISOString() };
    this.transactions.set(txHash, tx);

    return { txHash, status: 'SUCCESS' };
  }

  getTransaction(txHash: string): any | null {
    return this.transactions.get(txHash) || null;
  }

  clear(): void {
    this.balances.clear();
    this.transactions.clear();
    this.simulateFailure = false;
  }
}

// ==========================================
// 6. Frontend API Boundary Fixture
// ==========================================
export class FrontendApiBoundaryFixture {
  private handlers: Map<string, (req: { path: string; method: string; body?: any; headers?: any }) => any> = new Map();

  mockEndpoint(method: string, path: string, handler: (req: any) => any): void {
    const key = `${method.toUpperCase()} ${path}`;
    this.handlers.set(key, handler);
  }

  async dispatch(method: string, path: string, body?: any, headers: Record<string, string> = {}): Promise<{ status: number; data: any; headers: Record<string, string> }> {
    const key = `${method.toUpperCase()} ${path}`;
    const handler = this.handlers.get(key);

    if (!handler) {
      return {
        status: 404,
        data: { statusCode: 404, message: `Route ${key} not mocked`, error: 'Not Found' },
        headers: { 'content-type': 'application/json' },
      };
    }

    try {
      const response = await handler({ path, method, body, headers });
      return {
        status: response.status ?? 200,
        data: response.data ?? response,
        headers: response.headers ?? { 'content-type': 'application/json' },
      };
    } catch (err: any) {
      return {
        status: err.status ?? 500,
        data: { statusCode: err.status ?? 500, message: err.message },
        headers: { 'content-type': 'application/json' },
      };
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

// ==========================================
// 7. Unified State Leak Detector
// ==========================================
export class StateLeakDetector {
  private redis?: MockRedisFixture;
  private queue?: MockQueueFixture;
  private mail?: MockMailFixture;
  private clock?: DeterministicClock;

  constructor(fixtures: {
    redis?: MockRedisFixture;
    queue?: MockQueueFixture;
    mail?: MockMailFixture;
    clock?: DeterministicClock;
  }) {
    this.redis = fixtures.redis;
    this.queue = fixtures.queue;
    this.mail = fixtures.mail;
    this.clock = fixtures.clock;
  }

  assertNoLeaks(): void {
    const errors: string[] = [];

    if (this.redis) {
      try {
        this.redis.assertNoLeakedKeys();
      } catch (e: any) {
        errors.push(e.message);
      }
    }

    if (this.queue) {
      try {
        this.queue.assertNoLeakedJobs();
      } catch (e: any) {
        errors.push(e.message);
      }
    }

    if (this.mail) {
      try {
        this.mail.assertNoLeakedMails();
      } catch (e: any) {
        errors.push(e.message);
      }
    }

    if (errors.length > 0) {
      throw new Error(`[Deterministic Test Environment Leak] Test left dirty state:\n- ${errors.join('\n- ')}`);
    }
  }

  resetAll(): void {
    this.redis?.flushall();
    this.queue?.clear();
    this.mail?.clear();
    this.clock?.restore();
  }
}
