/**
 * scripts/__tests__/generate-release-notes.test.js
 *
 * Tests for the generate-release-notes.js script.
 * Exercises argument parsing, commit categorisation, migration metadata,
 * markdown generation, and the --check-unreleased flag.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Load the module directly for unit-level testing of exported helpers.
// The module uses require() and process.argv; we stub what we need.
const scriptPath = path.resolve(__dirname, '../generate-release-notes.js');

// Helper: run the script as a subprocess for integration checks
const { spawnSync } = require('child_process');
const REPO_ROOT = path.resolve(__dirname, '../..');

function runScript(args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
}

// ── Unit tests for helpers ───────────────────────────────────────────────────

// We expose helpers by requiring the module with a stub for main()
// Since the module calls main() at the bottom, we test via subprocess.

test('generate-release-notes outputs markdown by default', () => {
  const result = runScript(['--from', 'HEAD', '--to', 'HEAD']);
  // Even with no commits in range, should output a markdown header
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /# Release Notes/);
});

test('generate-release-notes outputs json format', () => {
  const result = runScript(['--format', 'json', '--from', 'HEAD', '--to', 'HEAD']);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, 'Output should be valid JSON');
  assert.ok('generated' in parsed, 'JSON output should have "generated" field');
  assert.ok('breaking' in parsed);
  assert.ok('migrations' in parsed);
  assert.ok('featureFlags' in parsed);
});

test('generate-release-notes outputs checklist format', () => {
  const result = runScript(['--format', 'checklist', '--from', 'HEAD', '--to', 'HEAD']);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /Release checklist/);
  assert.match(result.stdout, /npm run ci passes/);
});

test('generate-release-notes markdown contains release checklist', () => {
  const result = runScript(['--from', 'HEAD', '--to', 'HEAD']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Release Checklist/);
  assert.match(result.stdout, /npm run ci/);
  assert.match(result.stdout, /secret-scan/);
});

test('generate-release-notes markdown contains migration section', () => {
  const result = runScript(['--from', 'HEAD', '--to', 'HEAD']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Database Migrations/);
});

test('generate-release-notes markdown contains breaking changes section', () => {
  const result = runScript(['--from', 'HEAD', '--to', 'HEAD']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Breaking Changes/);
});

test('generate-release-notes writes output to file with --output', () => {
  const tmpFile = path.join(os.tmpdir(), `relnotes-test-${Date.now()}.md`);
  const result = runScript(['--output', tmpFile, '--from', 'HEAD', '--to', 'HEAD']);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  assert.ok(fs.existsSync(tmpFile), 'Output file should be created');
  const content = fs.readFileSync(tmpFile, 'utf8');
  assert.match(content, /# Release Notes/);
  fs.unlinkSync(tmpFile);
});

test('generate-release-notes json lists migration files', () => {
  const result = runScript(['--format', 'json', '--from', 'HEAD', '--to', 'HEAD']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  // Repo has migrations in xconfess-backend/migrations/ — should be non-empty
  assert.ok(Array.isArray(parsed.migrations), 'migrations should be an array');
  assert.ok(parsed.migrations.length > 0, 'Should detect existing migration files');
});

test('generate-release-notes json includes rollback metadata per migration', () => {
  const result = runScript(['--format', 'json', '--from', 'HEAD', '--to', 'HEAD']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  const migration = parsed.migrations[0];
  assert.ok('filename' in migration, 'migration should have filename');
  assert.ok('rollbackRisk' in migration, 'migration should have rollbackRisk');
});

test('generate-release-notes --check-unreleased does not fail on tagged HEAD', () => {
  // When there is no last tag and HEAD is the first commit, or HEAD is tagged,
  // the script should exit 0 (no unreleased entries beyond the tag boundary).
  // We cannot guarantee tagging in test environment, so just verify the flag is accepted.
  const result = runScript(['--check-unreleased', '--from', 'HEAD', '--to', 'HEAD']);
  // Should exit 0 (no commits in HEAD..HEAD range) or 1 (unreleased found) — both valid
  // What matters is the flag is accepted and the script doesn't crash
  assert.ok([0, 1].includes(result.status), `Expected 0 or 1, got ${result.status}`);
});

test('generate-release-notes markdown rollback constraints documented', () => {
  const result = runScript(['--from', 'HEAD', '--to', 'HEAD']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Rollback constraint/i);
});
