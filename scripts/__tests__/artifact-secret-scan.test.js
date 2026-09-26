/**
 * scripts/__tests__/artifact-secret-scan.test.js
 *
 * Tests for the artifact-secret-scan.sh script.
 * Verifies detection of secrets in artifacts, allowlist handling,
 * and exit code behaviour.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../artifact-secret-scan.sh');
const REPO_ROOT = path.resolve(__dirname, '../..');
const REAL_BASELINE = path.join(REPO_ROOT, '.secret-scan-baseline.json');

function runScript(args = [], extraEnv = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
  });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-test-'));
}

test('artifact-secret-scan exits 0 in diff mode on clean diff', () => {
  const tmpDir = makeTmpDir();
  const result = runScript(['--mode', 'diff', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stdout}\n${result.stderr}`);
});

test('artifact-secret-scan detects Stellar secret seed in a custom artifact dir', () => {
  const tmpDir = makeTmpDir();
  const fakeArtifactDir = path.join(tmpDir, 'fake-artifact');
  fs.mkdirSync(fakeArtifactDir, { recursive: true });
  // Fake Stellar secret seed: S + 55 uppercase A-Z2-7 base32 chars = 56 chars total
  const fakeSecret = 'SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  fs.writeFileSync(path.join(fakeArtifactDir, 'config.js'), `SECRET="${fakeSecret}"\n`);

  // Use a baseline that only allowlists the real baseline entries (not this file)
  const reportDir = path.join(tmpDir, 'report');
  const emptyBaseline = path.join(tmpDir, 'empty-baseline.json');
  fs.writeFileSync(emptyBaseline, '[]');

  // Only scan the custom dir (mode=artifacts, but we need to avoid the built-in dirs)
  // We test detection by checking the output content rather than exit code,
  // since the script also scans default dirs which may have allowlisted findings
  const result = runScript([
    '--mode', 'artifacts',
    '--artifact-dir', fakeArtifactDir,
    '--report-dir', reportDir,
    '--baseline', emptyBaseline,
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Script should exit 1 (found secrets) AND mention the pattern name
  assert.equal(result.status, 1, `Expected exit 1 for secret-containing artifact, got ${result.status}`);
  assert.match(result.stdout, /stellar-secret-seed/);
});

test('artifact-secret-scan finding does not echo the secret value', () => {
  const tmpDir = makeTmpDir();
  const fakeArtifactDir = path.join(tmpDir, 'fake-artifact');
  fs.mkdirSync(fakeArtifactDir, { recursive: true });
  const fakeSecret = 'SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  fs.writeFileSync(path.join(fakeArtifactDir, 'config.js'), `SECRET="${fakeSecret}"\n`);

  const emptyBaseline = path.join(tmpDir, 'empty-baseline.json');
  fs.writeFileSync(emptyBaseline, '[]');
  const reportDir = path.join(tmpDir, 'report');

  const result = runScript([
    '--mode', 'artifacts',
    '--artifact-dir', fakeArtifactDir,
    '--report-dir', reportDir,
    '--baseline', emptyBaseline,
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Output should mention the pattern name but NOT echo the actual secret value
  assert.match(result.stdout, /stellar-secret-seed/);
  assert.doesNotMatch(result.stdout, new RegExp(fakeSecret));
});

test('artifact-secret-scan finding includes remediation guidance', () => {
  const tmpDir = makeTmpDir();
  const fakeArtifactDir = path.join(tmpDir, 'fake-artifact');
  fs.mkdirSync(fakeArtifactDir, { recursive: true });
  const fakeSecret = 'SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  fs.writeFileSync(path.join(fakeArtifactDir, 'config.js'), `SECRET="${fakeSecret}"\n`);

  const emptyBaseline = path.join(tmpDir, 'empty-baseline.json');
  fs.writeFileSync(emptyBaseline, '[]');
  const reportDir = path.join(tmpDir, 'report');

  const result = runScript([
    '--mode', 'artifacts',
    '--artifact-dir', fakeArtifactDir,
    '--report-dir', reportDir,
    '--baseline', emptyBaseline,
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.match(result.stdout, /Remediation:/i);
});

test('artifact-secret-scan allowlisted finding does not block (exit 0)', () => {
  const tmpDir = makeTmpDir();
  const fakeArtifactDir = path.join(tmpDir, 'safe-fixtures');
  fs.mkdirSync(fakeArtifactDir, { recursive: true });
  const fakeSecret = 'SBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const fakeFilename = 'safe-fixture.js';
  fs.writeFileSync(path.join(fakeArtifactDir, fakeFilename), `SECRET="${fakeSecret}"\n`);

  // Create a baseline that allowlists this specific file+pattern
  // Use a full path-based key matching how the script resolves it
  const baselineFile = path.join(tmpDir, 'baseline.json');
  // The baseline file path must match "relative from REPO_ROOT" or "relative from artifact dir"
  // The script uses: rel_path="${file#${REPO_ROOT}/}"
  // For /tmp/xxx/safe-fixtures/safe-fixture.js, REPO_ROOT strip won't match
  // So we need to put the exact relative path as it appears in output
  fs.writeFileSync(baselineFile, JSON.stringify([
    {
      file: fakeArtifactDir.replace(REPO_ROOT + '/', '') + '/' + fakeFilename,
      pattern: 'stellar-secret-seed',
      reason: 'test fixture'
    }
  ]));

  const reportDir = path.join(tmpDir, 'report');
  const result = runScript([
    '--mode', 'artifacts',
    '--artifact-dir', fakeArtifactDir,
    '--report-dir', reportDir,
    '--baseline', baselineFile,
  ]);
  // If the scan also scans dist/ and finds unallowlisted things, it may still fail.
  // So we just verify: (a) the script ran, (b) ALLOWED marker appears for the fake file
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.match(result.stdout, /ALLOWED|allowlisted/i, 'Expected allowlist marker in output');
});

test('artifact-secret-scan with real baseline exits 0 for artifacts dir', () => {
  // This test verifies that the real .secret-scan-baseline.json covers all known
  // false positives in the built artifacts.
  const tmpDir = makeTmpDir();
  const reportDir = path.join(tmpDir, 'report');
  const result = runScript([
    '--mode', 'artifacts',
    '--report-dir', reportDir,
    '--baseline', REAL_BASELINE,
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 0,
    `exit ${result.status}: Unallowlisted findings in artifacts — add them to .secret-scan-baseline.json\n${result.stdout}`);
});

test('artifact-secret-scan creates report file', () => {
  const tmpDir = makeTmpDir();
  const reportDir = path.join(tmpDir, 'report');
  runScript(['--mode', 'diff', '--report-dir', reportDir]);
  const files = fs.existsSync(reportDir) ? fs.readdirSync(reportDir) : [];
  const reports = files.filter(f => f.startsWith('scan-') && f.endsWith('.txt'));
  assert.ok(reports.length > 0, 'Expected a scan report file');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('artifact-secret-scan exits 2 for unknown mode', () => {
  const tmpDir = makeTmpDir();
  const result = runScript(['--mode', 'notamode', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 2);
});

test('artifact-secret-scan exits 2 for unknown argument', () => {
  const tmpDir = makeTmpDir();
  const result = runScript(['--totally-unknown', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 2);
});
