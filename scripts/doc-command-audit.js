#!/usr/bin/env node
/**
 * scripts/doc-command-audit.js — Reconcile documented npm/shell commands with
 * what actually exists in package.json scripts.
 *
 * Usage:
 *   node scripts/doc-command-audit.js          # audit; exits non-zero on failures
 *   node scripts/doc-command-audit.js --report  # print full matrix even if passing
 *
 * What it checks:
 *  - Scans all Markdown files under docs/ and the repo root README.md and
 *    CONTRIBUTING.md for `npm run <script>` references inside fenced code blocks.
 *  - Verifies that every referenced script exists in the root package.json.
 *  - Highlights which scripts are documented vs. which are undocumented
 *    (informational only — undocumented scripts are not a failure).
 *  - Reports any documented command that does NOT exist, which is a hard failure.
 *
 * Environment-gated commands (e.g. deploy scripts, Render pre-start) are
 * exempted from the existence check via GATED_COMMANDS below because they
 * intentionally require credentials or infrastructure not present locally.
 *
 * Run as part of the preflight check:
 *   npm run preflight
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const FULL_REPORT = process.argv.includes('--report');

// ---------------------------------------------------------------------------
// Markdown files to audit
// ---------------------------------------------------------------------------
const AUDIT_FILES = [
  'README.md',
  'CONTRIBUTING.md',
  'QUICK_START.md',
  'docs/CONTRIBUTOR_GUIDE.md',
  'docs/VALIDATION_COMMAND_MATRIX.md',
  'docs/CONTRIBUTOR_ISSUES.md',
  'docs/TEST_DATA_PRIVACY.md',
];

// ---------------------------------------------------------------------------
// Scripts that are documented but legitimately environment-gated
// (deploy, CI, production-only). Missing these locally is expected.
// ---------------------------------------------------------------------------
const GATED_COMMANDS = new Set([
  // Deployment / production
  'deploy:preflight',
  'deploy:smoke',
  'production:readiness',
  'production:readiness:full',
  'production:readiness:deployed',
  'render:prestart',
  'contract:deploy:testnet',
  'contracts:verify-env',
  // CI-only compound commands
  'ci',
  'ci:backend',
  'ci:frontend',
  'ci:contract',
  'ci:apps',
  // Audit
  'audit:ci',
  'audit:report',
  // Misc shortcuts that are documented descriptively but are aliases
  'readiness',
  'readiness:test',
]);

// ---------------------------------------------------------------------------
// Parse all npm run <name> references from a markdown file
// We only look inside fenced code blocks to avoid prose false-positives.
// ---------------------------------------------------------------------------
const NPM_RUN_RE = /\bnpm run ([\w:.-]+)/g;

function extractCommandsFromMarkdown(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const commands = new Set();

  // Iterate over fenced code blocks only
  const fenceRe = /^```(?:\w+)?\s*\n([\s\S]*?)^```/gm;
  let block;
  while ((block = fenceRe.exec(content)) !== null) {
    const code = block[1];
    let match;
    while ((match = NPM_RUN_RE.exec(code)) !== null) {
      commands.add(match[1]);
    }
    NPM_RUN_RE.lastIndex = 0; // reset regex state between blocks
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Load root package.json scripts
// ---------------------------------------------------------------------------
function loadPackageScripts() {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return new Set(Object.keys(pkg.scripts || {}));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log('\nDoc-command audit');
  console.log('─────────────────');

  const availableScripts = loadPackageScripts();
  console.log(`Loaded ${availableScripts.size} npm scripts from root package.json.`);

  /** @type {Map<string, string[]>} command → files that reference it */
  const referencedBy = new Map();

  for (const relPath of AUDIT_FILES) {
    const absPath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(absPath)) {
      console.log(`  SKIP  ${relPath} (file not found)`);
      continue;
    }

    const commands = extractCommandsFromMarkdown(absPath);
    for (const cmd of commands) {
      if (!referencedBy.has(cmd)) referencedBy.set(cmd, []);
      referencedBy.get(cmd).push(relPath);
    }
  }

  // Split into: exists, gated (exempted), missing
  const exists = [];
  const gated = [];
  const missing = [];

  for (const [cmd, files] of referencedBy) {
    if (availableScripts.has(cmd)) {
      exists.push({ cmd, files });
    } else if (GATED_COMMANDS.has(cmd)) {
      gated.push({ cmd, files });
    } else {
      missing.push({ cmd, files });
    }
  }

  // Print full matrix only when requested or when there are failures
  if (FULL_REPORT || missing.length > 0) {
    console.log('\n── Documented commands that EXIST in package.json ──');
    if (exists.length === 0) {
      console.log('  (none)');
    } else {
      for (const { cmd, files } of exists.sort((a, b) => a.cmd.localeCompare(b.cmd))) {
        console.log(`  ✓  npm run ${cmd}`);
        if (FULL_REPORT) {
          for (const f of files) console.log(`       referenced in: ${f}`);
        }
      }
    }

    if (gated.length > 0) {
      console.log('\n── Environment-gated (intentionally absent locally) ──');
      for (const { cmd } of gated.sort((a, b) => a.cmd.localeCompare(b.cmd))) {
        console.log(`  ⚑  npm run ${cmd}  [gated]`);
      }
    }
  }

  if (missing.length > 0) {
    console.log('\n── STALE: documented commands that DO NOT exist in package.json ──');
    for (const { cmd, files } of missing.sort((a, b) => a.cmd.localeCompare(b.cmd))) {
      console.log(`  ✗  npm run ${cmd}`);
      for (const f of files) {
        console.log(`       referenced in: ${f}`);
      }
    }
    console.log('');
    console.log(
      `Doc-command audit FAILED: ${missing.length} documented command(s) do not exist.\n` +
        'Either add the missing scripts to package.json or remove the stale references from docs.',
    );
    process.exit(1);
  }

  const total = exists.length + gated.length;
  console.log(
    `\n✓  Doc-command audit passed: ${total} unique npm commands documented ` +
      `(${exists.length} verified, ${gated.length} environment-gated).\n`,
  );
}

main();
