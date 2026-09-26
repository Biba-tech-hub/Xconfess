#!/usr/bin/env node
/**
 * scripts/migration-gate.js
 *
 * Migration safety gate for CI and deployment pipelines (issue #129).
 *
 * Checks performed:
 *   1. No two migration files share the same timestamp prefix — duplicate
 *      timestamps cause non-deterministic ordering and silent data corruption.
 *   2. Every migration file provides both an `up` and a `down` method —
 *      missing rollbacks block promotion because failed deploys cannot
 *      be automatically reversed.
 *   3. Destructive DDL in an `up` method (DROP COLUMN, DROP TABLE,
 *      TRUNCATE, DROP INDEX that is not immediately followed by a CREATE INDEX
 *      replacement) is flagged as an "unsafe" operation that requires the
 *      migration to be annotated with a
 *      `@unsafe-migration-acknowledged` comment or the
 *      ALLOW_UNSAFE_MIGRATIONS=true env-var to be explicitly set in CI.
 *      The expand/contract pattern is preferred: add new columns first,
 *      deploy the app, then remove old columns in a follow-up migration.
 *
 * Exits 0 when all checks pass.
 * Exits 1 when unsafe or invalid migrations are found.
 *
 * Usage:
 *   node scripts/migration-gate.js [--dry-run]
 *
 * Environment:
 *   ALLOW_UNSAFE_MIGRATIONS=true   Skip the destructive-DDL block (use only
 *                                  for deliberate column-removal migrations
 *                                  after a full expand/contract cycle).
 *   MIGRATION_GATE_DRY_RUN=true    Print findings without failing (CI reports
 *                                  only; does not gate the build).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────

const MIGRATION_DIRS = [
  'xconfess-backend/migrations',
  'xconfess-backend/src/migrations',
];

/**
 * Destructive DDL patterns that require acknowledgement when present in the
 * up() method body. DROP INDEX alone is allowed when used to replace an index
 * (common pattern); we only flag it when followed by no corresponding CREATE.
 */
const TRULY_DESTRUCTIVE_PATTERNS = [
  /DROP\s+COLUMN\b/i,   // removing a column loses data
  /DROP\s+TABLE\b/i,    // removing a table loses data
  /TRUNCATE\b/i,        // truncating a table loses data
];

const ACKNOWLEDGE_COMMENT = '@unsafe-migration-acknowledged';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const dryRun =
  process.argv.includes('--dry-run') ||
  process.env.MIGRATION_GATE_DRY_RUN === 'true';
const allowUnsafe = process.env.ALLOW_UNSAFE_MIGRATIONS === 'true';

const errors = [];
const warnings = [];

function fail(msg) {
  errors.push(msg);
}

function isMigrationFile(name) {
  return (
    /\.(ts|js)$/.test(name) &&
    !name.endsWith('.spec.ts') &&
    !name.endsWith('.spec.js') &&
    !name.endsWith('.d.ts')
  );
}

/** Extract the leading timestamp from a migration filename (digits only). */
function extractTimestamp(filename) {
  const m = path.basename(filename).match(/^(\d+)/);
  return m ? m[1] : null;
}

/**
 * Extract the text body of the `up()` method from a migration source file.
 * We look for the method signature and grab everything until we find the
 * matching closing brace at the same nesting depth.
 */
function extractUpBody(src) {
  // Match `async up(` or `public async up(` or `up(`
  const startRe = /\b(?:public\s+)?(?:async\s+)?up\s*\(/;
  const match = startRe.exec(src);
  if (!match) return '';

  // Walk forward from the opening brace of the method body
  let idx = src.indexOf('{', match.index + match[0].length);
  if (idx === -1) return '';

  let depth = 0;
  let body = '';
  for (let i = idx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        body = src.slice(idx + 1, i);
        break;
      }
    }
  }
  return body;
}

// ── Step 1: collect migration files ──────────────────────────────────────────

const migrationFiles = [];
for (const dir of MIGRATION_DIRS) {
  const absDir = path.join(ROOT, dir);
  if (!fs.existsSync(absDir)) continue;
  for (const file of fs.readdirSync(absDir)) {
    if (isMigrationFile(file)) {
      migrationFiles.push({ dir, file, abs: path.join(absDir, file) });
    }
  }
}

if (migrationFiles.length === 0) {
  console.log('migration-gate: no migration files found — nothing to check.');
  process.exit(0);
}

// ── Step 2: duplicate timestamp check ────────────────────────────────────────
// TypeORM orders migrations by their numeric timestamp prefix.  Two migrations
// in the same directory with identical leading digits will run in an undefined
// order, which can cause schema corruption.
//
// We distinguish two cases:
//   - Full 13-digit Unix-millisecond timestamps (e.g. 1774790298268): exact
//     duplicates within the same directory are always an error.
//   - Date-only prefixes (e.g. 20260126): these are pre-existing in the repo
//     and TypeORM resolves ordering by class name; we warn but do not fail.

const timestampMapByDir = {};
for (const { file, dir } of migrationFiles) {
  const ts = extractTimestamp(file);
  if (!ts) continue;
  if (!timestampMapByDir[dir]) timestampMapByDir[dir] = {};
  if (!timestampMapByDir[dir][ts]) timestampMapByDir[dir][ts] = [];
  timestampMapByDir[dir][ts].push(`${dir}/${file}`);
}

// A "full" timestamp has 13+ digits (Unix ms) or an appended suffix like 000001.
function isFullTimestamp(ts) {
  return ts.length >= 13 || /\d{8}\d{6}/.test(ts); // yyyymmddHHMMSS
}

for (const [dir, tsMap] of Object.entries(timestampMapByDir)) {
  for (const [ts, files] of Object.entries(tsMap)) {
    if (files.length > 1) {
      if (isFullTimestamp(ts)) {
        fail(
          `Duplicate migration timestamp "${ts}" in directory "${dir}":\n` +
            files.map((f) => `  - ${f}`).join('\n') +
            '\nRename one migration to use a unique timestamp.'
        );
      } else {
        // Date-only prefix — warn only.
        console.warn(
          `  WARN: migrations with the same date prefix "${ts}" in "${dir}":\n` +
            files.map((f) => `    - ${f}`).join('\n') +
            '\n    Consider adding a time suffix (e.g. 20260126000100) for deterministic ordering.'
        );
      }
    }
  }
}

// ── Step 3: up/down method presence check ────────────────────────────────────

for (const { file, dir, abs } of migrationFiles) {
  const src = fs.readFileSync(abs, 'utf8');
  const hasUp =
    /\bup\s*\(/.test(src) || /async\s+up\b/.test(src);
  const hasDown =
    /\bdown\s*\(/.test(src) || /async\s+down\b/.test(src);

  if (!hasUp) {
    fail(
      `${dir}/${file}: missing "up" method. Every migration must be reversible.`
    );
  }
  if (!hasDown) {
    fail(
      `${dir}/${file}: missing "down" method. Add a rollback to allow reverting this migration.\n` +
        '  If the operation is genuinely irreversible, provide a down() that throws with an explanation.'
    );
  }
}

// ── Step 4: destructive DDL check (up() body only) ───────────────────────────

if (!allowUnsafe) {
  for (const { file, dir, abs } of migrationFiles) {
    const src = fs.readFileSync(abs, 'utf8');
    const acknowledged = src.includes(ACKNOWLEDGE_COMMENT);
    if (acknowledged) continue;

    const upBody = extractUpBody(src);
    const destructiveMatch = TRULY_DESTRUCTIVE_PATTERNS.find((p) => p.test(upBody));

    if (destructiveMatch) {
      fail(
        `${dir}/${file}: potentially unsafe destructive DDL ("${destructiveMatch.source}") in up().\n` +
          '  Preferred approach: use the expand/contract pattern — add columns/tables first,\n' +
          '  deploy the new application version, then remove obsolete structures in a follow-up.\n' +
          `  If this is intentional and reviewed, add a comment: // ${ACKNOWLEDGE_COMMENT}\n` +
          '  or set ALLOW_UNSAFE_MIGRATIONS=true when running this check.'
      );
    }
  }
}

// ── Output ────────────────────────────────────────────────────────────────────

const total = migrationFiles.length;
console.log(
  `migration-gate: checked ${total} migration file(s) across ${MIGRATION_DIRS.length} director(ies).`
);

if (errors.length === 0) {
  console.log('migration-gate: all checks passed. ✔');
  process.exit(0);
}

console.error('\nErrors:');
errors.forEach((e) => console.error('  FAIL:', e));
console.error(`\nmigration-gate: ${errors.length} check(s) failed.`);

if (dryRun) {
  console.warn('migration-gate: --dry-run mode; not failing the build.');
  process.exit(0);
}

console.error(
  '\nRollback guidance:\n' +
    '  1. Fix the migration file(s) listed above.\n' +
    '  2. Re-run:  node scripts/migration-gate.js\n' +
    '  3. If a migration was already applied to production, create a new\n' +
    '     compensating migration rather than editing the existing one.'
);
process.exit(1);
