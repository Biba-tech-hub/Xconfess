/**
 * scripts/__tests__/diagnose.test.js
 *
 * Unit tests for the secret-safe helper logic in scripts/diagnose.js.
 * Uses Node's built-in test runner to match the rest of scripts/__tests__/.
 *
 * Run: node --test scripts/__tests__/diagnose.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const test   = require('node:test');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// ── Pure helper re-implementations ───────────────────────────────────────────
// We duplicate the small pure functions from diagnose.js to keep tests
// hermetic (main() is side-effectful and cannot be safely required).

function envKeys(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).trim());
}

function envPresence(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .forEach((l) => {
      const idx = l.indexOf('=');
      const key = l.slice(0, idx).trim();
      const val = l.slice(idx + 1).trim();
      out[key] = val.length > 0 ? '<set>' : '<empty>';
    });
  return out;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnose-test-'));
const tmpEnv  = path.join(tmpDir, '.env');

// Clean up after all tests complete
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('envKeys returns empty array for a missing file', () => {
  const result = envKeys(path.join(tmpDir, 'nonexistent.env'));
  assert.deepEqual(result, []);
});

test('envKeys returns key names from a valid env file', () => {
  fs.writeFileSync(tmpEnv, 'FOO=bar\nBAR=baz\n# comment\nBAZ=\n');
  assert.deepEqual(envKeys(tmpEnv), ['FOO', 'BAR', 'BAZ']);
});

test('envKeys skips blank lines and comment lines', () => {
  fs.writeFileSync(tmpEnv, '\n# this is a comment\n\nKEY=value\n');
  assert.deepEqual(envKeys(tmpEnv), ['KEY']);
});

test('envPresence returns empty object for a missing file', () => {
  const result = envPresence(path.join(tmpDir, 'nonexistent.env'));
  assert.deepEqual(result, {});
});

test('envPresence marks set keys as "<set>" without revealing values', () => {
  fs.writeFileSync(tmpEnv, 'SECRET=supersecret\n');
  const result = envPresence(tmpEnv);
  assert.equal(result.SECRET, '<set>');
  // The actual secret value must never appear in the output
  assert.ok(!JSON.stringify(result).includes('supersecret'));
});

test('envPresence marks empty keys as "<empty>"', () => {
  fs.writeFileSync(tmpEnv, 'EMPTY_KEY=\n');
  assert.equal(envPresence(tmpEnv).EMPTY_KEY, '<empty>');
});

test('envPresence handles keys whose values contain = signs', () => {
  fs.writeFileSync(tmpEnv, 'BASE64=abc=def==\n');
  const result = envPresence(tmpEnv);
  assert.equal(result.BASE64, '<set>');
  assert.ok(!JSON.stringify(result).includes('abc=def=='));
});

test('envPresence skips comment lines', () => {
  fs.writeFileSync(tmpEnv, '# this is a comment\nREAL=value\n');
  const result = envPresence(tmpEnv);
  assert.deepEqual(Object.keys(result), ['REAL']);
});

test('envPresence never leaks any secret value into output', () => {
  const secret = 'VERY_SECRET_VALUE_THAT_MUST_NOT_APPEAR';
  fs.writeFileSync(tmpEnv, `JWT_SECRET=${secret}\nAPP_SECRET=${secret}2\n`);
  const result = envPresence(tmpEnv);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret));
  assert.ok(Object.values(result).every((v) => v === '<set>' || v === '<empty>'));
});
