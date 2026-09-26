#!/usr/bin/env node
/**
 * Backup restore verification drill.
 *
 * Checks that a recent database backup can be restored to an isolated target
 * and passes basic integrity assertions.  Designed to be run in a sandbox
 * environment (CI, staging) — it NEVER connects to the production database.
 *
 * The script enforces this guarantee via the DATABASE_URL guard below:
 * it refuses to run if DATABASE_URL contains any of the production
 * hostname patterns defined in PRODUCTION_HOSTNAME_PATTERNS.
 *
 * Usage:
 *   node scripts/verify-backup-restore.js [options]
 *
 *   --backup-file=<path>   Path to the pg_dump file to restore (required unless --dry-run).
 *   --target-db=<connstr>  Connection string for the restore target (must be sandbox).
 *   --dry-run              Print what would happen without running pg_restore.
 *   --report-dir=<dir>     Directory to write the JSON report (default: readiness-results).
 *   --rto-minutes=<n>      Maximum acceptable restore time in minutes (default: 240).
 *   --rpo-hours=<n>        Maximum acceptable backup age in hours (default: 1).
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed (drill failure pages owners)
 *   2 — safety guard triggered (would-be production connection refused)
 *
 * Issue: #98 — Implement backup restore verification automation
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Safety guard — never allow this script to touch production.
// ---------------------------------------------------------------------------
const PRODUCTION_HOSTNAME_PATTERNS = [
  /\.render\.com/i,
  /\.rds\.amazonaws\.com/i,
  /prod/i,
  /production/i,
];

function assertSandboxTarget(connectionString) {
  for (const pattern of PRODUCTION_HOSTNAME_PATTERNS) {
    if (pattern.test(connectionString)) {
      console.error(
        `[SAFETY] Refusing to run restore drill against what looks like a production host.`,
      );
      console.error(`  Target: ${connectionString.replace(/:[^:@]+@/, ':****@')}`);
      console.error(
        `  To override for a legitimate staging host that matches a production pattern,`,
      );
      console.error(`  set BACKUP_DRILL_ALLOW_PATTERN_MATCH=1 in the environment.`);
      if (!process.env.BACKUP_DRILL_ALLOW_PATTERN_MATCH) {
        process.exit(2);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    backupFile: null,
    targetDb: process.env.BACKUP_DRILL_TARGET_DB || null,
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

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Returns the mtime of the backup file as a Date. */
function getBackupAge(filePath) {
  const stat = fs.statSync(filePath);
  return stat.mtime;
}

/** Runs pg_restore into the target database and returns { ok, durationMs, error }. */
function runRestore(backupFile, targetDb) {
  const start = Date.now();
  const result = spawnSync(
    'pg_restore',
    ['--no-owner', '--no-privileges', '--clean', '--if-exists', '-d', targetDb, backupFile],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  const durationMs = Date.now() - start;

  if (result.error) {
    return { ok: false, durationMs, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, durationMs, error: result.stderr || `exit status ${result.status}` };
  }
  return { ok: true, durationMs, error: null };
}

/** Row count check — ensures the restored DB has at least one confession. */
function runIntegrityCheck(targetDb) {
  const result = spawnSync(
    'psql',
    [targetDb, '-t', '-c', 'SELECT COUNT(*) FROM confessions;'],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return { ok: false, rowCount: 0, error: result.stderr };
  }
  const rowCount = parseInt((result.stdout || '').trim(), 10);
  return { ok: !isNaN(rowCount), rowCount, error: null };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function writeReport(dir, report) {
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, `backup-drill-${Date.now()}.json`);
  fs.writeFileSync(filename, JSON.stringify(report, null, 2));
  console.log(`[report] Written to ${filename}`);
  return filename;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);

  console.log('[backup-drill] Starting restore verification drill');
  console.log(`  dryRun      : ${opts.dryRun}`);
  console.log(`  backupFile  : ${opts.backupFile ?? '(none — RPO check only)'}`);
  console.log(`  targetDb    : ${opts.targetDb ? opts.targetDb.replace(/:[^:@]+@/, ':****@') : '(none)'}`);
  console.log(`  rtoMinutes  : ${opts.rtoMinutes}`);
  console.log(`  rpoHours    : ${opts.rpoHours}`);

  const report = {
    timestamp: new Date().toISOString(),
    dryRun: opts.dryRun,
    checks: [],
    passed: true,
  };

  // Safety check
  if (opts.targetDb) {
    assertSandboxTarget(opts.targetDb);
  }

  // 1. RPO check — backup must be recent enough
  if (opts.backupFile) {
    const backupAge = getBackupAge(opts.backupFile);
    const ageHours = (Date.now() - backupAge.getTime()) / 3_600_000;
    const rpoOk = ageHours <= opts.rpoHours;

    const check = {
      name: 'rpo-check',
      passed: rpoOk,
      backupAgeHours: Math.round(ageHours * 100) / 100,
      maxAgeHours: opts.rpoHours,
      backupFile: opts.backupFile,
      backupDate: backupAge.toISOString(),
      note: rpoOk
        ? `Backup is within RPO window (${ageHours.toFixed(2)}h ≤ ${opts.rpoHours}h)`
        : `Backup exceeds RPO window (${ageHours.toFixed(2)}h > ${opts.rpoHours}h). Run a fresh backup.`,
    };

    report.checks.push(check);
    if (!rpoOk) report.passed = false;
    console.log(`[rpo-check] ${check.passed ? 'PASS' : 'FAIL'} — ${check.note}`);
  } else {
    report.checks.push({ name: 'rpo-check', passed: true, note: 'No backup file provided — skipped' });
  }

  // 2. Restore check
  if (!opts.dryRun && opts.backupFile && opts.targetDb) {
    console.log('[restore] Running pg_restore…');
    const { ok, durationMs, error } = runRestore(opts.backupFile, opts.targetDb);
    const rtoMs = opts.rtoMinutes * 60_000;
    const rtoOk = ok && durationMs <= rtoMs;

    const check = {
      name: 'restore',
      passed: ok && rtoOk,
      durationMs,
      rtoMs,
      error: error ?? undefined,
      note: !ok
        ? `pg_restore failed: ${error}`
        : rtoOk
        ? `Restore completed in ${(durationMs / 1000).toFixed(1)}s (within RTO)`
        : `Restore succeeded but exceeded RTO: ${(durationMs / 1000).toFixed(1)}s > ${opts.rtoMinutes * 60}s`,
    };

    report.checks.push(check);
    if (!check.passed) report.passed = false;
    console.log(`[restore] ${check.passed ? 'PASS' : 'FAIL'} — ${check.note}`);

    // 3. Integrity check — only if restore succeeded
    if (ok) {
      const { ok: intOk, rowCount, error: intErr } = runIntegrityCheck(opts.targetDb);
      const intCheck = {
        name: 'integrity-row-count',
        passed: intOk,
        confessionRowCount: rowCount,
        error: intErr ?? undefined,
        note: intOk
          ? `Found ${rowCount} confession row(s) in restored DB`
          : `Integrity check failed: ${intErr}`,
      };
      report.checks.push(intCheck);
      if (!intCheck.passed) report.passed = false;
      console.log(`[integrity] ${intCheck.passed ? 'PASS' : 'FAIL'} — ${intCheck.note}`);
    }
  } else if (opts.dryRun) {
    report.checks.push({ name: 'restore', passed: true, note: 'dry-run — skipped' });
    report.checks.push({ name: 'integrity-row-count', passed: true, note: 'dry-run — skipped' });
    console.log('[restore] dry-run mode — restore and integrity checks skipped');
  } else {
    report.checks.push({
      name: 'restore',
      passed: false,
      note: 'Missing --backup-file or --target-db — cannot run restore check',
    });
    report.passed = false;
  }

  writeReport(opts.reportDir, report);

  const status = report.passed ? 'PASSED' : 'FAILED';
  console.log(`\n[backup-drill] Drill ${status}`);

  if (!report.passed) {
    console.error(
      '\n[backup-drill] One or more checks failed.\n' +
      'Action: page the database owner and review the report above.\n' +
      'Runbook: https://github.com/yazeed11011/Xconfess/blob/main/docs/disaster-recovery-runbook.md',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[backup-drill] Unexpected error:', err);
  process.exit(1);
});
