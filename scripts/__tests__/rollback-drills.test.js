/**
 * scripts/__tests__/rollback-drills.test.js
 *
 * Tests for the rollback-drills.sh script logic.
 * Verifies that the script exits correctly and produces expected output
 * for the --dry-run and per-drill modes.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.resolve(__dirname, '../rollback-drills.sh');
const REPO_ROOT = path.resolve(__dirname, '../..');

function runDrill(args = [], env = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
}

test('rollback-drills.sh exits 0 in dry-run mode for all drills', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--drill', 'all', '--dry-run', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 0, `Expected exit 0, got ${result.status}.\nSTDOUT: ${result.stdout}\nSTDERR: ${result.stderr}`);
});

test('rollback-drills.sh dry-run prints [DRY-RUN] markers', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--drill', 'all', '--dry-run', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.match(result.stdout, /\[DRY-RUN\]/, 'Expected [DRY-RUN] markers in output');
});

test('rollback-drills.sh runs app drill in isolation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--drill', 'app', '--dry-run', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Backend Application Rollback/);
});

test('rollback-drills.sh runs schema drill in isolation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--drill', 'schema', '--dry-run', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Schema Migration Rollback/);
});

test('rollback-drills.sh runs contract drill in isolation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--drill', 'contract', '--dry-run', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Soroban Contract Rollback/);
});

test('rollback-drills.sh runs frontend drill in isolation', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--drill', 'frontend', '--dry-run', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Frontend Deployment Rollback/);
});

test('rollback-drills.sh exits 2 for unknown drill name', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--drill', 'nonexistent', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 2);
});

test('rollback-drills.sh exits 2 for unknown argument', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--invalid-flag', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 2);
});

test('rollback-drills.sh creates report file in report-dir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  runDrill(['--drill', 'app', '--dry-run', '--report-dir', tmpDir]);
  const files = fs.readdirSync(tmpDir);
  const reports = files.filter(f => f.startsWith('drill-') && f.endsWith('.txt'));
  assert.ok(reports.length > 0, 'Expected a drill report file to be created');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('rollback-drills.sh schema drill checks migration down() methods', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--drill', 'schema', '--dry-run', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Should mention down() method check
  assert.match(result.stdout, /down\(\) method/i);
});

test('rollback-drills.sh all drills document RTO target', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-test-'));
  const result = runDrill(['--drill', 'all', '--rto-minutes', '60', '--dry-run', '--report-dir', tmpDir]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.match(result.stdout, /RTO target:\s+60m/);
});
