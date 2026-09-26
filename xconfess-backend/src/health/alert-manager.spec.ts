import {
  AlertManager,
  buildIdentityKey,
  resolveOwner,
  ALERT_OWNERSHIP_MAP,
  AlertDefinition,
} from './alert-manager';

const baseAlert: AlertDefinition = {
  alertName: 'postgres.down',
  severity: 'critical',
  service: 'database',
  message: 'Postgres is unreachable',
};

describe('buildIdentityKey', () => {
  it('produces the same key for alerts with identical name, service, and labels', () => {
    const a = buildIdentityKey({ ...baseAlert, labels: { region: 'us-east-1' } });
    const b = buildIdentityKey({ ...baseAlert, labels: { region: 'us-east-1' } });
    expect(a).toBe(b);
  });

  it('produces different keys for different alert names', () => {
    const a = buildIdentityKey({ ...baseAlert, alertName: 'postgres.down' });
    const b = buildIdentityKey({ ...baseAlert, alertName: 'postgres.slow' });
    expect(a).not.toBe(b);
  });

  it('produces different keys for different services', () => {
    const a = buildIdentityKey({ ...baseAlert, service: 'database' });
    const b = buildIdentityKey({ ...baseAlert, service: 'redis' });
    expect(a).not.toBe(b);
  });

  it('sorts label keys for stable identity regardless of insertion order', () => {
    const a = buildIdentityKey({ ...baseAlert, labels: { b: '2', a: '1' } });
    const b = buildIdentityKey({ ...baseAlert, labels: { a: '1', b: '2' } });
    expect(a).toBe(b);
  });
});

describe('resolveOwner', () => {
  it('returns the registered owner for known services', () => {
    const entry = resolveOwner('database');
    expect(entry.owner.handle).toBeDefined();
    expect(entry.owner.runbookUrl).toMatch(/http/);
  });

  it('returns the default owner for unknown services', () => {
    const entry = resolveOwner('unknown-service');
    expect(entry.owner.handle).toBeDefined();
    expect(entry.owner.runbookUrl).toMatch(/http/);
  });
});

describe('ALERT_OWNERSHIP_MAP', () => {
  it('every entry has a non-empty runbookUrl', () => {
    for (const [service, entry] of Object.entries(ALERT_OWNERSHIP_MAP)) {
      expect(entry.owner.runbookUrl.length).toBeGreaterThan(0);
      void service;
    }
  });

  it('every entry has a valid handle', () => {
    for (const entry of Object.values(ALERT_OWNERSHIP_MAP)) {
      expect(entry.owner.handle).toMatch(/^@/);
    }
  });
});

describe('AlertManager', () => {
  let manager: AlertManager;

  beforeEach(() => {
    // Use very short dedup windows so tests can manipulate timing.
    manager = new AlertManager({ critical: 0, warning: 0, info: 0 });
  });

  describe('fire', () => {
    it('fires a new alert with state "firing"', () => {
      const alert = manager.fire(baseAlert);
      expect(alert.state).toBe('firing');
      expect(alert.identityKey).toBeDefined();
      expect(alert.owner).toBeDefined();
      expect(alert.suppressedCount).toBe(0);
    });

    it('assigns the correct owner from the ownership map', () => {
      const alert = manager.fire(baseAlert);
      const registered = resolveOwner('database');
      expect(alert.owner.handle).toBe(registered.owner.handle);
    });

    it('deduplicates when the same alert fires within the window', () => {
      // Use a real window so the second fire is within it
      const mgr = new AlertManager({ critical: 60_000, warning: 60_000, info: 60_000 });
      mgr.fire(baseAlert);
      const second = mgr.fire(baseAlert);
      expect(second.state).toBe('suppressed');
      expect(second.suppressedCount).toBe(1);
    });

    it('fires again once the dedup window expires', () => {
      // With window=0, every call fires
      const first = manager.fire(baseAlert);
      const second = manager.fire(baseAlert);
      expect(first.state).toBe('firing');
      expect(second.state).toBe('firing');
    });

    it('suppresses all alerts in maintenance mode', () => {
      manager.setMaintenanceMode(true);
      const alert = manager.fire(baseAlert);
      expect(alert.state).toBe('suppressed');
    });

    it('fires normally once maintenance mode is lifted', () => {
      manager.setMaintenanceMode(true);
      manager.setMaintenanceMode(false);
      const alert = manager.fire(baseAlert);
      expect(alert.state).toBe('firing');
    });
  });

  describe('resolve', () => {
    it('returns the resolved alert', () => {
      const fired = manager.fire(baseAlert);
      const resolved = manager.resolve(fired.identityKey);
      expect(resolved?.state).toBe('resolved');
      expect(resolved?.resolvedAt).toBeDefined();
    });

    it('removes the alert from the active set after resolve', () => {
      const fired = manager.fire(baseAlert);
      manager.resolve(fired.identityKey);
      expect(manager.getActive()).toHaveLength(0);
    });

    it('returns null when the identity key is not found', () => {
      expect(manager.resolve('nonexistent::key')).toBeNull();
    });
  });

  describe('getActive', () => {
    it('returns all currently firing alerts', () => {
      manager.fire(baseAlert);
      manager.fire({ ...baseAlert, alertName: 'redis.down', service: 'redis' });
      expect(manager.getActive()).toHaveLength(2);
    });

    it('excludes resolved alerts', () => {
      const fired = manager.fire(baseAlert);
      manager.resolve(fired.identityKey);
      expect(manager.getActive()).toHaveLength(0);
    });
  });

  describe('hasCritical', () => {
    it('returns true when a critical alert is firing', () => {
      manager.fire(baseAlert); // severity: critical
      expect(manager.hasCritical()).toBe(true);
    });

    it('returns false when only warning/info alerts are firing', () => {
      manager.fire({ ...baseAlert, severity: 'warning' });
      expect(manager.hasCritical()).toBe(false);
    });
  });
});
