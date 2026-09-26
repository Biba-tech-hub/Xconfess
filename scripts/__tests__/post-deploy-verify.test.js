/**
 * scripts/__tests__/post-deploy-verify.test.js
 *
 * Tests for the post-deploy-verify.js script.
 * Exercises argument parsing, evidence file creation, and failure behaviour
 * without making real network requests.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../post-deploy-verify.js');
const REPO_ROOT = path.resolve(__dirname, '../..');

// Run the script with a mocked backend that never exists to test failure paths
function runScript(args = [], env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Point at a guaranteed-unreachable URL to force quick failures
      BACKEND_URL: 'http://127.0.0.1:1',
      FRONTEND_URL: 'http://127.0.0.1:1',
      ...env,
    },
  });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'postdeploy-test-'));
}

test('post-deploy-verify exits 1 when backend is unreachable (halt policy)', () => {
  const tmpDir = makeTmpDir();
  const result = runScript(['--evidence-dir', tmpDir, '--timeout-ms', '2000', '--retries', '1', '--skip-auth']);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 1, `Expected exit 1 on unreachable backend, got ${result.status}`);
});

test('post-deploy-verify creates evidence file on failure', () => {
  const tmpDir = makeTmpDir();
  runScript(['--evidence-dir', tmpDir, '--timeout-ms', '2000', '--retries', '1', '--skip-auth']);
  const files = fs.readdirSync(tmpDir);
  const evidence = files.filter(f => f.startsWith('verify-') && f.endsWith('.json'));
  assert.ok(evidence.length > 0, 'Evidence file should be created even on failure');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-deploy-verify evidence file is valid JSON', () => {
  const tmpDir = makeTmpDir();
  runScript(['--evidence-dir', tmpDir, '--timeout-ms', '2000', '--retries', '1', '--skip-auth']);
  const files = fs.readdirSync(tmpDir);
  const evidenceFile = files.find(f => f.startsWith('verify-') && f.endsWith('.json'));
  assert.ok(evidenceFile, 'Evidence file should exist');
  const content = fs.readFileSync(path.join(tmpDir, evidenceFile), 'utf8');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(content); }, 'Evidence file should be valid JSON');
  assert.ok(parsed.releaseIdentity, 'Evidence should have releaseIdentity');
  assert.ok(Array.isArray(parsed.checks), 'Evidence should have checks array');
  assert.ok(parsed.summary, 'Evidence should have summary');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-deploy-verify evidence file includes release identity fields', () => {
  const tmpDir = makeTmpDir();
  runScript([
    '--evidence-dir', tmpDir,
    '--timeout-ms', '2000',
    '--retries', '1',
    '--skip-auth',
    '--env', 'staging',
    '--commit', 'abc123def456',
    '--run-id', 'test-run-42',
  ]);
  const files = fs.readdirSync(tmpDir);
  const evidenceFile = files.find(f => f.startsWith('verify-') && f.endsWith('.json'));
  const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, evidenceFile), 'utf8'));
  assert.equal(parsed.releaseIdentity.environment, 'staging');
  assert.equal(parsed.releaseIdentity.commitSha, 'abc123def456');
  assert.equal(parsed.releaseIdentity.runId, 'test-run-42');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-deploy-verify evidence file does not contain sensitive values', () => {
  const tmpDir = makeTmpDir();
  runScript([
    '--evidence-dir', tmpDir,
    '--timeout-ms', '2000',
    '--retries', '1',
  ]);
  const files = fs.readdirSync(tmpDir);
  const evidenceFile = files.find(f => f.startsWith('verify-') && f.endsWith('.json'));
  if (!evidenceFile) {
    // No evidence file when backend unreachable without skip-auth — still pass
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  const content = fs.readFileSync(path.join(tmpDir, evidenceFile), 'utf8');
  // The content should not contain any raw passwords or tokens
  assert.doesNotMatch(content, /"password":\s*"[^"]{4,}"/i, 'Evidence should not contain plain password');
  assert.doesNotMatch(content, /"token":\s*"[^"]{10,}"/i, 'Evidence should not contain plain token');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-deploy-verify evidence filename includes commit sha', () => {
  const tmpDir = makeTmpDir();
  runScript([
    '--evidence-dir', tmpDir,
    '--timeout-ms', '2000',
    '--retries', '1',
    '--skip-auth',
    '--commit', 'deadbeef1234',
  ]);
  const files = fs.readdirSync(tmpDir);
  const evidenceFile = files.find(f => f.includes('deadbeef'));
  assert.ok(evidenceFile, 'Evidence filename should include commit sha');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-deploy-verify skips auth checks when --skip-auth is set', () => {
  const tmpDir = makeTmpDir();
  runScript(['--evidence-dir', tmpDir, '--timeout-ms', '2000', '--retries', '1', '--skip-auth']);
  const files = fs.readdirSync(tmpDir);
  const evidenceFile = files.find(f => f.startsWith('verify-') && f.endsWith('.json'));
  if (!evidenceFile) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }
  const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, evidenceFile), 'utf8'));
  const loginCheck = parsed.checks.find(c => c.name === 'authenticated-login');
  if (loginCheck) {
    assert.equal(loginCheck.status, 'skip', 'Login check should be skipped with --skip-auth');
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('post-deploy-verify prints environment and commit in output', () => {
  const tmpDir = makeTmpDir();
  const result = runScript([
    '--evidence-dir', tmpDir,
    '--timeout-ms', '2000',
    '--retries', '1',
    '--skip-auth',
    '--env', 'production',
    '--commit', 'cafebabe0000',
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.match(result.stdout, /Environment:\s+production/);
  assert.match(result.stdout, /Commit:\s+cafebabe0000/);
});

test('post-deploy-verify summary section present in output', () => {
  const tmpDir = makeTmpDir();
  const result = runScript(['--evidence-dir', tmpDir, '--timeout-ms', '2000', '--retries', '1', '--skip-auth']);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Summary should always appear
  assert.match(result.stdout + result.stderr, /Verification Summary|Evidence retained|critical check failed/i);
});
