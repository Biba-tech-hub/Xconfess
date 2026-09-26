import {
  WORKLOAD_PROFILES,
  SMOKE_PROFILE,
  READ_HEAVY_PROFILE,
  WRITE_SPIKE_PROFILE,
  WS_SOAK_PROFILE,
  normaliseDistribution,
  buildProfileDataset,
  WorkloadProfile,
} from '../workload-profiles';

describe('WorkloadProfiles', () => {
  describe('profile registry', () => {
    it('exports all four named profiles', () => {
      expect(Object.keys(WORKLOAD_PROFILES)).toContain('smoke');
      expect(Object.keys(WORKLOAD_PROFILES)).toContain('read-heavy');
      expect(Object.keys(WORKLOAD_PROFILES)).toContain('write-spike');
      expect(Object.keys(WORKLOAD_PROFILES)).toContain('ws-soak');
    });

    it('each profile has a unique name', () => {
      const names = Object.values(WORKLOAD_PROFILES).map((p) => p.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it('each profile has a non-empty distribution', () => {
      Object.values(WORKLOAD_PROFILES).forEach((p) => {
        expect(p.distribution.length).toBeGreaterThan(0);
      });
    });

    it('each profile has positive concurrentUsers and targetRps', () => {
      Object.values(WORKLOAD_PROFILES).forEach((p) => {
        expect(p.concurrentUsers).toBeGreaterThan(0);
        expect(p.targetRps).toBeGreaterThan(0);
      });
    });

    it('each profile has all positive datasetScale values', () => {
      Object.values(WORKLOAD_PROFILES).forEach((p) => {
        Object.values(p.datasetScale).forEach((v) => {
          expect(v).toBeGreaterThan(0);
        });
      });
    });
  });

  describe('smoke profile', () => {
    it('has concurrentUsers <= 10', () => {
      expect(SMOKE_PROFILE.concurrentUsers).toBeLessThanOrEqual(10);
    });

    it('has a small dataset scale', () => {
      expect(SMOKE_PROFILE.datasetScale.confessions).toBeLessThanOrEqual(100);
    });
  });

  describe('read-heavy profile', () => {
    it('has read operations with higher total weight than writes', () => {
      const readOps = ['GET /confessions', 'GET /confessions/:id', 'GET /reactions', 'GET /confessions/trending', 'GET /confessions/search', 'GET /notifications'];
      const writeOps = ['POST /confessions', 'POST /reactions', 'POST /comments'];

      const readWeight = READ_HEAVY_PROFILE.distribution
        .filter((e) => readOps.includes(e.operation))
        .reduce((s, e) => s + e.weight, 0);

      const writeWeight = READ_HEAVY_PROFILE.distribution
        .filter((e) => writeOps.includes(e.operation))
        .reduce((s, e) => s + e.weight, 0);

      expect(readWeight).toBeGreaterThan(writeWeight);
    });
  });

  describe('write-spike profile', () => {
    it('has write operations with higher total weight than read-heavy profile', () => {
      const writeOps = ['POST /confessions', 'POST /reactions', 'POST /comments'];

      const spikeWrite = WRITE_SPIKE_PROFILE.distribution
        .filter((e) => writeOps.includes(e.operation))
        .reduce((s, e) => s + e.weight, 0);

      const normalWrite = READ_HEAVY_PROFILE.distribution
        .filter((e) => writeOps.includes(e.operation))
        .reduce((s, e) => s + e.weight, 0);

      // Normalise by total weight to compare ratios.
      const spikeTotal = WRITE_SPIKE_PROFILE.distribution.reduce((s, e) => s + e.weight, 0);
      const normalTotal = READ_HEAVY_PROFILE.distribution.reduce((s, e) => s + e.weight, 0);

      expect(spikeWrite / spikeTotal).toBeGreaterThan(normalWrite / normalTotal);
    });
  });

  describe('normaliseDistribution()', () => {
    it('returns normalised weights that sum to 1.0', () => {
      const dist = normaliseDistribution(SMOKE_PROFILE.distribution);
      const sum = dist.reduce((s, e) => s + e.normalisedWeight, 0);
      expect(sum).toBeCloseTo(1.0, 5);
    });

    it('returns 0 weights for empty distribution', () => {
      const dist = normaliseDistribution([
        { operation: 'GET /confessions', weight: 0, rationale: '' },
      ]);
      expect(dist[0].normalisedWeight).toBe(0);
    });

    it('preserves original entries', () => {
      const dist = normaliseDistribution(SMOKE_PROFILE.distribution);
      dist.forEach((e) => {
        expect(e.operation).toBeDefined();
        expect(e.weight).toBeDefined();
        expect(e.rationale).toBeDefined();
      });
    });
  });

  describe('buildProfileDataset()', () => {
    it('returns a dataset object with the correct keys', () => {
      const result = buildProfileDataset(SMOKE_PROFILE);
      expect(result).toHaveProperty('profile');
      expect(result).toHaveProperty('users');
      expect(result).toHaveProperty('confessions');
      expect(result).toHaveProperty('reactions');
      expect(result).toHaveProperty('comments');
      expect(result).toHaveProperty('notificationJobs');
    });

    it('generates the right number of users', () => {
      const { users } = buildProfileDataset(SMOKE_PROFILE);
      expect(users).toHaveLength(SMOKE_PROFILE.datasetScale.users);
    });

    it('generates the right number of confessions', () => {
      const { confessions } = buildProfileDataset(SMOKE_PROFILE);
      expect(confessions).toHaveLength(SMOKE_PROFILE.datasetScale.confessions);
    });

    it('is reproducible — two calls with the same profile return identical datasets', () => {
      const a = buildProfileDataset(SMOKE_PROFILE);
      const b = buildProfileDataset(SMOKE_PROFILE);
      expect(a.users).toEqual(b.users);
      expect(a.confessions).toEqual(b.confessions);
    });

    it('produces different datasets for different profiles', () => {
      const smoke = buildProfileDataset(SMOKE_PROFILE);
      const readHeavy = buildProfileDataset(READ_HEAVY_PROFILE);
      // Different seeds and scales — at minimum the user arrays differ.
      expect(smoke.users).not.toEqual(readHeavy.users);
    });

    it('all four built-in profiles build without throwing', () => {
      const profiles: WorkloadProfile[] = [
        SMOKE_PROFILE,
        READ_HEAVY_PROFILE,
        WRITE_SPIKE_PROFILE,
        WS_SOAK_PROFILE,
      ];
      profiles.forEach((p) => {
        expect(() => buildProfileDataset(p)).not.toThrow();
      });
    });
  });
});
