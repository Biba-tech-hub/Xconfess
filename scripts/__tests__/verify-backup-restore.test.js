/**
 * Unit tests for backup restore verification drill.
 *
 * Tests the pure logic (safety guard, arg parsing, RPO check) without
 * invoking pg_restore or a real database.
 *
 * Issue: #98 — Implement backup restore verification automation
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// ---------------------------------------------------------------------------
// Inline the testable pure-logic extracted from verify-backup-restore.js
// ---------------------------------------------------------------------------

const PRODUCTION_HOSTNAME_PATTERNS = [
  /\.render\.com/i,
  /\.rds\.amazonaws\.com/i,
  /prod/i,
  /production/i,
];

function isProductionTarget(connectionString) {
  return PRODUCTION_HOSTNAME_PATTERNS.some((p) => p.test(connectionString));
}

function parseArgs(args) {
  const opts = {
    backupFile: null,
    targetDb: null,
    dryRun: args.includes('--dry-run'),
    reportDir: 'readiness-results',
    rtoMinutes: 240,
    rpoHours: 1,
  };
  for (const arg of args) {
    if (arg.startsWith('--backup-file=')) opts.backupFile = arg.slice('--backup-file='.length);
    if (arg.startsWith('--target-db=')) opts.targetDb = arg.slice('--target-db='.length);
    if (arg.startsWith('--report-dir=')) opts.reportDir = arg.slice('--report-dir='.length);
    if (arg.startsWith('--rto-minutes=')) opts.rtoMinutes = parseInt(arg.slice('--rto-minutes='.length), 10);
    if (arg.startsWith('--rpo-hours=')) opts.rpoHours = parseInt(arg.slice('--rpo-hours='.length), 10);
  }
  return opts;
}

function checkRpo(backupMtime, rpoHours) {
  const ageHours = (Date.now() - backupMtime.getTime()) / 3_600_000;
  return { ok: ageHours <= rpoHours, ageHours };
}

// ---------------------------------------------------------------------------
// Safety guard tests
// ---------------------------------------------------------------------------

test('safety guard: detects render.com as production', () => {
  assert.equal(isProductionTarget('postgres://u:p@myapp.render.com/db'), true);
});

test('safety guard: detects rds.amazonaws.com as production', () => {
  assert.equal(isProductionTarget('postgres://u:p@myapp.us-east-1.rds.amazonaws.com/db'), true);
});

test('safety guard: detects "prod" in hostname as production', () => {
  assert.equal(isProductionTarget('postgres://u:p@prod-db.example.com/db'), true);
});

test('safety guard: detects "production" in hostname as production', () => {
  assert.equal(isProductionTarget('postgres://u:p@production.example.com/db'), true);
});

test('safety guard: allows localhost sandbox connection string', () => {
  assert.equal(isProductionTarget('postgres://u:p@localhost:5432/drill_test'), false);
});

test('safety guard: allows staging hostname without production keywords', () => {
  assert.equal(isProductionTarget('postgres://u:p@staging-db.example.com/db'), false);
});

// ---------------------------------------------------------------------------
// Argument parsing tests
// ---------------------------------------------------------------------------

test('parseArgs: parses --backup-file', () => {
  const opts = parseArgs(['--backup-file=/tmp/backup.dump']);
  assert.equal(opts.backupFile, '/tmp/backup.dump');
});

test('parseArgs: parses --dry-run flag', () => {
  const opts = parseArgs(['--dry-run']);
  assert.equal(opts.dryRun, true);
});

test('parseArgs: parses --rto-minutes', () => {
  const opts = parseArgs(['--rto-minutes=30']);
  assert.equal(opts.rtoMinutes, 30);
});

test('parseArgs: parses --rpo-hours', () => {
  const opts = parseArgs(['--rpo-hours=2']);
  assert.equal(opts.rpoHours, 2);
});

test('parseArgs: defaults rtoMinutes=240 and rpoHours=1', () => {
  const opts = parseArgs([]);
  assert.equal(opts.rtoMinutes, 240);
  assert.equal(opts.rpoHours, 1);
});

test('parseArgs: parses --report-dir', () => {
  const opts = parseArgs(['--report-dir=/tmp/reports']);
  assert.equal(opts.reportDir, '/tmp/reports');
});

// ---------------------------------------------------------------------------
// RPO check tests
// ---------------------------------------------------------------------------

test('RPO check: passes when backup is within the window (30 min, limit 1 h)', () => {
  const recent = new Date(Date.now() - 30 * 60_000);
  const { ok, ageHours } = checkRpo(recent, 1);
  assert.equal(ok, true);
  assert.ok(ageHours < 1, `Expected ageHours < 1, got ${ageHours}`);
});

test('RPO check: fails when backup exceeds the window (3 h, limit 1 h)', () => {
  const old = new Date(Date.now() - 3 * 3_600_000);
  const { ok, ageHours } = checkRpo(old, 1);
  assert.equal(ok, false);
  assert.ok(ageHours > 1, `Expected ageHours > 1, got ${ageHours}`);
});

test('RPO check: passes at just inside the boundary (59 min, limit 1 h)', () => {
  const almost = new Date(Date.now() - 59 * 60_000);
  const { ok } = checkRpo(almost, 1);
  assert.equal(ok, true);
});
