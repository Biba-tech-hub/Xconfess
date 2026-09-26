const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  captureEnvironmentMetadata,
  evaluateRegression,
  saveBenchmarkArtifact,
  updateBaselineWithRationale,
  sanitizeEnvironment,
  parseArgs,
} = require('../benchmark-triage');

test('sanitizeEnvironment redacts sensitive keys', () => {
  const env = {
    NODE_ENV: 'test',
    JWT_SECRET: 'supersecret',
    API_KEY: '12345',
    DATABASE_URL: 'postgres://user:password@localhost/db',
    PORT: '5000',
  };

  const sanitized = sanitizeEnvironment(env);
  assert.equal(sanitized.NODE_ENV, 'test');
  assert.equal(sanitized.PORT, '5000');
  assert.equal(sanitized.JWT_SECRET, '[REDACTED]');
  assert.equal(sanitized.API_KEY, '[REDACTED]');
  assert.equal(sanitized.DATABASE_URL, '[REDACTED]');
});

test('captureEnvironmentMetadata records system, git, and Node versions', () => {
  const meta = captureEnvironmentMetadata();
  assert.ok(meta.nodeVersion);
  assert.ok(meta.osPlatform);
  assert.ok(meta.cpuCores > 0);
  assert.ok(meta.totalMemoryMb > 0);
  assert.ok(meta.timestamp);
  assert.ok(meta.commitSha);
});

test('evaluateRegression correctly classifies STABLE, NOISE, and REGRESSION', () => {
  const baseline = {
    workloads: {
      'GET /confessions': { avgLatencyMs: 100, p95LatencyMs: 200, throughputRps: 500, errorRate: 0 },
      'POST /confessions': { avgLatencyMs: 100, p95LatencyMs: 200, throughputRps: 500, errorRate: 0 },
      'GET /reactions': { avgLatencyMs: 100, p95LatencyMs: 200, throughputRps: 500, errorRate: 0 },
    },
  };

  // 1. Stable: 2% latency increase (<= 5% noiseBand)
  // 2. Noise: 7% latency increase (> 5% noiseBand, but <= 10% threshold)
  // 3. Regression: 25% latency increase (> 10% threshold)
  const measured = {
    environment: { commitSha: 'abc12345' },
    workloads: {
      'GET /confessions': { avgLatencyMs: 102, p95LatencyMs: 204, throughputRps: 498, errorRate: 0 },
      'POST /confessions': { avgLatencyMs: 107, p95LatencyMs: 214, throughputRps: 490, errorRate: 0 },
      'GET /reactions': { avgLatencyMs: 125, p95LatencyMs: 250, throughputRps: 400, errorRate: 0 },
    },
  };

  const evalResult = evaluateRegression(measured, baseline);
  assert.equal(evalResult.passed, false);
  assert.equal(evalResult.hasRegressions, true);

  const confessions = evalResult.results.find((r) => r.workload === 'GET /confessions');
  assert.equal(confessions.classification, 'STABLE');
  assert.equal(confessions.status, 'PASS');

  const postConfessions = evalResult.results.find((r) => r.workload === 'POST /confessions');
  assert.equal(postConfessions.classification, 'NOISE');
  assert.equal(postConfessions.status, 'PASS');

  const reactions = evalResult.results.find((r) => r.workload === 'GET /reactions');
  assert.equal(reactions.classification, 'REGRESSION');
  assert.equal(reactions.status, 'FAIL');
  assert.equal(reactions.commitSha, 'abc12345');
});

test('saveBenchmarkArtifact persists comparable run reports', () => {
  const tmpDir = path.join(os.tmpdir(), `bench-test-${Date.now()}`);
  const runData = {
    runId: 'test-run-1',
    environment: { commitSha: 'feedbeef', nodeVersion: 'v22.0.0' },
    workloads: { 'GET /test': { avgLatencyMs: 50, throughputRps: 1000 } },
  };

  const { filePath } = saveBenchmarkArtifact(runData, tmpDir);
  assert.ok(fs.existsSync(filePath));

  const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.equal(saved.runId, 'test-run-1');
  assert.equal(saved.environment.commitSha, 'feedbeef');

  // Verify latest-run.json is also created
  const latestPath = path.join(tmpDir, 'latest-run.json');
  assert.ok(fs.existsSync(latestPath));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('updateBaselineWithRationale rejects missing or insufficient rationale', () => {
  const tmpBaseline = path.join(os.tmpdir(), `baseline-${Date.now()}.json`);
  const workloads = { 'GET /test': { avgLatencyMs: 50 } };

  // Missing rationale
  assert.throws(() => {
    updateBaselineWithRationale(workloads, null, tmpBaseline);
  }, /A documented rationale of at least 10 characters is required/);

  // Short rationale
  assert.throws(() => {
    updateBaselineWithRationale(workloads, 'too short', tmpBaseline);
  }, /A documented rationale of at least 10 characters is required/);

  // Valid rationale
  const updated = updateBaselineWithRationale(workloads, 'Valid optimization after adding redis caching', tmpBaseline);
  assert.equal(updated.lastRationale, 'Valid optimization after adding redis caching');
  assert.ok(fs.existsSync(tmpBaseline));

  fs.rmSync(tmpBaseline, { force: true });
});

test('parseArgs parses CLI flags correctly', () => {
  const args = parseArgs(['--check', '--rationale=Upgraded cluster capacity', '--json']);
  assert.equal(args.check, true);
  assert.equal(args.rationale, 'Upgraded cluster capacity');
  assert.equal(args.json, true);
});
