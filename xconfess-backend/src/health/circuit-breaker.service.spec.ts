import { Test, TestingModule } from '@nestjs/testing';
import { CircuitBreakerService } from './circuit-breaker.service';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CircuitBreakerService],
    }).compile();
    service = module.get(CircuitBreakerService);
  });

  describe('registration', () => {
    it('auto-registers a circuit on first use', () => {
      expect(service.isOpen('unknown-dep')).toBe(false);
      const status = service.getStatus('unknown-dep');
      expect(status).not.toBeNull();
      expect(status!.state).toBe('CLOSED');
    });

    it('does not overwrite an existing circuit on duplicate register', () => {
      service.register('dep-a', { failureThreshold: 2 });
      service.recordFailure('dep-a'); // 1 failure
      service.register('dep-a', { failureThreshold: 99 }); // should not replace
      service.recordFailure('dep-a'); // 2nd failure — should still open (threshold=2)
      expect(service.getStatus('dep-a')!.state).toBe('OPEN');
    });
  });

  describe('CLOSED → OPEN transition', () => {
    it('stays CLOSED before the failure threshold is reached', () => {
      service.register('db', { failureThreshold: 3 });
      service.recordFailure('db');
      service.recordFailure('db');
      expect(service.isOpen('db')).toBe(false);
      expect(service.getStatus('db')!.state).toBe('CLOSED');
    });

    it('opens the circuit once the failure threshold is reached', () => {
      service.register('db', { failureThreshold: 3 });
      service.recordFailure('db');
      service.recordFailure('db');
      service.recordFailure('db');
      expect(service.isOpen('db')).toBe(true);
      expect(service.getStatus('db')!.state).toBe('OPEN');
    });

    it('sets degradedMode when OPEN', () => {
      service.register('redis', { failureThreshold: 1 });
      service.recordFailure('redis');
      expect(service.getStatus('redis')!.degradedMode).toBe(true);
    });
  });

  describe('OPEN → HALF_OPEN transition', () => {
    it('keeps circuit OPEN before the reset timeout', () => {
      service.register('email', {
        failureThreshold: 1,
        resetTimeoutMs: 60_000,
      });
      service.recordFailure('email');
      expect(service.isOpen('email')).toBe(true);
    });

    it('transitions to HALF_OPEN after reset timeout and allows one probe', () => {
      service.register('stellar-rpc', {
        failureThreshold: 1,
        resetTimeoutMs: 0, // immediate for test
      });
      service.recordFailure('stellar-rpc');
      // isOpen should return false (allow probe) once timeout elapsed
      expect(service.isOpen('stellar-rpc')).toBe(false);
      expect(service.getStatus('stellar-rpc')!.state).toBe('HALF_OPEN');
    });
  });

  describe('HALF_OPEN recovery', () => {
    it('closes the circuit on a successful probe', () => {
      service.register('stellar-rpc', {
        failureThreshold: 1,
        resetTimeoutMs: 0,
      });
      service.recordFailure('stellar-rpc');
      service.isOpen('stellar-rpc'); // trigger HALF_OPEN
      service.recordSuccess('stellar-rpc');
      expect(service.getStatus('stellar-rpc')!.state).toBe('CLOSED');
      expect(service.getStatus('stellar-rpc')!.degradedMode).toBe(false);
    });

    it('reopens the circuit when the probe fails', () => {
      service.register('stellar-rpc', {
        failureThreshold: 1,
        resetTimeoutMs: 0,
      });
      service.recordFailure('stellar-rpc');
      service.isOpen('stellar-rpc'); // HALF_OPEN
      service.recordFailure('stellar-rpc'); // probe fails → reopen
      expect(service.getStatus('stellar-rpc')!.state).toBe('OPEN');
    });
  });

  describe('recordSuccess', () => {
    it('resets failure count and closes the circuit', () => {
      service.register('db', { failureThreshold: 5 });
      service.recordFailure('db');
      service.recordFailure('db');
      service.recordSuccess('db');
      const status = service.getStatus('db')!;
      expect(status.state).toBe('CLOSED');
      expect(status.failureCount).toBe(0);
    });
  });

  describe('manual reset', () => {
    it('forcibly closes an OPEN circuit', () => {
      service.register('db', { failureThreshold: 1 });
      service.recordFailure('db');
      expect(service.isOpen('db')).toBe(true);
      service.reset('db');
      expect(service.isOpen('db')).toBe(false);
    });

    it('is a no-op for an unknown circuit name', () => {
      expect(() => service.reset('nonexistent')).not.toThrow();
    });
  });

  describe('getAll', () => {
    it('returns an entry for every registered circuit', () => {
      service.register('dep-x', { tier: 'critical' });
      service.register('dep-y', { tier: 'optional' });
      const all = service.getAll();
      const names = all.map((s) => s.name);
      expect(names).toContain('dep-x');
      expect(names).toContain('dep-y');
    });

    it('includes the correct tier', () => {
      service.register('postgres', { tier: 'critical' });
      const status = service.getAll().find((s) => s.name === 'postgres');
      expect(status?.tier).toBe('critical');
    });
  });
});
