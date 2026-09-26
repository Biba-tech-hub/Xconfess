#!/usr/bin/env node
/**
 * scripts/bootstrap.js — One-command contributor bootstrap for xConfess.
 *
 * Usage:
 *   npm run bootstrap          # full bootstrap (node, env files, docker check)
 *   npm run bootstrap -- --skip-docker   # skip Docker/service availability check
 *   npm run bootstrap -- --check-only    # check prerequisites without writing files
 *
 * Safe to re-run: existing .env and .env.local files are never overwritten.
 * No production credentials are requested or stored.
 *
 * Validates:
 *  1. Node.js version (22.x required)
 *  2. npm version (>=9 required)
 *  3. Docker availability (warns if absent, does not block)
 *  4. Creates xconfess-backend/.env from .env.example (if not present)
 *  5. Creates xconfess-frontend/.env.local from .env.example (if not present)
 *  6. Reports missing required env keys in the created files
 *
 * After running this script, continue with:
 *   npm run dev:services      # start Postgres + Redis via Docker Compose
 *   npm run dev               # start backend + frontend
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const SKIP_DOCKER = args.includes('--skip-docker');
const CHECK_ONLY = args.includes('--check-only');

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Required Node / npm versions
// ---------------------------------------------------------------------------
const REQUIRED_NODE_MAJOR = 22;
const MIN_NPM_MAJOR = 9;

// ---------------------------------------------------------------------------
// Env file mappings: source → target
// ---------------------------------------------------------------------------
const ENV_FILES = [
  {
    source: path.join(REPO_ROOT, 'xconfess-backend', '.env.example'),
    target: path.join(REPO_ROOT, 'xconfess-backend', '.env'),
    label: 'Backend env',
    // Keys the user must fill in before first boot (everything else has safe defaults)
    requiredKeys: [
      'JWT_SECRET',
      'APP_SECRET',
      'CONFESSION_ENCRYPTION_KEY',
      'ENCRYPTION_CURRENT_KEY_VERSION',
      'ENCRYPTION_MASTER_KEY_v1',
    ],
    // Keys with known safe placeholder defaults already in .env.example
    safeDefaultKeys: [
      'DB_HOST',
      'DB_PORT',
      'REDIS_HOST',
      'REDIS_PORT',
      'STELLAR_FEATURES_ENABLED',
    ],
  },
  {
    source: path.join(REPO_ROOT, 'xconfess-frontend', '.env.example'),
    target: path.join(REPO_ROOT, 'xconfess-frontend', '.env.local'),
    label: 'Frontend env',
    requiredKeys: [],
    safeDefaultKeys: ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_WS_URL'],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(msg) {
  console.log(`  ✓  ${msg}`);
}

function warn(msg) {
  console.log(`  ⚠  ${msg}`);
}

function err(msg) {
  console.log(`  ✗  ${msg}`);
}

function info(msg) {
  console.log(`     ${msg}`);
}

function heading(msg) {
  console.log(`\n── ${msg}`);
}

function parseMajor(version) {
  const m = String(version || '').match(/(\d+)/);
  return m ? Number(m[1]) : NaN;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const idx = l.indexOf('=');
        return idx === -1 ? [l, ''] : [l.slice(0, idx), l.slice(idx + 1)];
      }),
  );
}

// Placeholder values that are intentionally left as-is in local env files.
const PLACEHOLDER_PATTERNS = [
  /change-me/i,
  /^your-/i,
  /^PLACEHOLDER/i,
  /^0{32,}$/,
  /^\[REDACTED/i,
];

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

// ---------------------------------------------------------------------------
// Step 1: Runtime version check
// ---------------------------------------------------------------------------
function checkRuntime() {
  heading('Runtime prerequisites');

  let allOk = true;

  const nodeMajor = parseMajor(process.versions.node);
  if (nodeMajor === REQUIRED_NODE_MAJOR) {
    ok(`Node.js ${process.version}`);
  } else {
    err(
      `Node.js ${REQUIRED_NODE_MAJOR}.x required; found ${process.version}. ` +
        `Run: nvm use ${REQUIRED_NODE_MAJOR}  (or fnm use ${REQUIRED_NODE_MAJOR} / volta install node@${REQUIRED_NODE_MAJOR})`,
    );
    allOk = false;
  }

  const npmVersionString = process.env.npm_config_user_agent?.match(/npm\/([0-9.]+)/)?.[1];
  const npmMajor = parseMajor(npmVersionString);
  if (!npmVersionString) {
    warn('npm version could not be determined from npm_config_user_agent; skipping npm check.');
  } else if (npmMajor >= MIN_NPM_MAJOR) {
    ok(`npm ${npmVersionString}`);
  } else {
    err(`npm ${MIN_NPM_MAJOR}+ required; found ${npmVersionString}. Run: npm install -g npm@latest`);
    allOk = false;
  }

  return allOk;
}

// ---------------------------------------------------------------------------
// Step 2: Docker availability check (warn-only — does not fail bootstrap)
// ---------------------------------------------------------------------------
function checkDocker() {
  heading('Docker availability');

  if (SKIP_DOCKER) {
    warn('Docker check skipped (--skip-docker flag set).');
    return true;
  }

  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    stdio: 'pipe',
  });

  if (result.error || result.status !== 0) {
    warn(
      'Docker is not available or not running. ' +
        'Start Docker Desktop (Windows/macOS) or the Docker daemon (Linux), then run:',
    );
    info('  npm run dev:services');
    warn('Bootstrap will continue — start services before running npm run dev.');
    return false; // warn only, not a hard failure
  }

  ok(`Docker daemon reachable (server ${result.stdout.toString().trim() || 'ok'})`);
  return true;
}

// ---------------------------------------------------------------------------
// Step 3: Create env files from examples
// ---------------------------------------------------------------------------
function bootstrapEnvFiles() {
  heading('Environment files');

  let anyCreated = false;
  let allOk = true;

  for (const file of ENV_FILES) {
    const relTarget = path.relative(REPO_ROOT, file.target);
    const relSource = path.relative(REPO_ROOT, file.source);

    if (!fs.existsSync(file.source)) {
      err(`Source template not found: ${relSource} — repository may be incomplete.`);
      allOk = false;
      continue;
    }

    if (fs.existsSync(file.target)) {
      ok(`${relTarget} already exists — skipped (safe to re-run).`);
      continue;
    }

    if (CHECK_ONLY) {
      warn(`${relTarget} not found. Run without --check-only to create it.`);
      continue;
    }

    fs.copyFileSync(file.source, file.target, fs.constants.COPYFILE_EXCL);
    ok(`Created ${relTarget} from ${relSource}`);
    anyCreated = true;
  }

  if (anyCreated) {
    console.log('');
    console.log('  ℹ  Env files created from .env.example templates.');
    console.log('     These contain safe local-only placeholder values.');
    console.log('     Review and fill in any keys marked "change-me" before first boot.');
  }

  return allOk;
}

// ---------------------------------------------------------------------------
// Step 4: Validate required keys in the created / existing env files
// ---------------------------------------------------------------------------
function validateEnvKeys() {
  heading('Required env-key check');

  let allOk = true;

  for (const file of ENV_FILES) {
    if (!fs.existsSync(file.target)) continue;
    if (file.requiredKeys.length === 0) {
      ok(`${path.relative(REPO_ROOT, file.target)} — no required keys to check`);
      continue;
    }

    const env = parseEnvFile(file.target);
    const missing = [];
    const placeholder = [];

    for (const key of file.requiredKeys) {
      const val = env[key];
      if (val === undefined || val === '') {
        missing.push(key);
      } else if (isPlaceholder(val)) {
        placeholder.push(key);
      }
    }

    const relTarget = path.relative(REPO_ROOT, file.target);

    if (missing.length === 0 && placeholder.length === 0) {
      ok(`${relTarget} — all required keys are set`);
    } else {
      if (placeholder.length > 0) {
        warn(
          `${relTarget} — ${placeholder.length} key(s) still use placeholder values ` +
            '(safe for local boot, required for full feature use):',
        );
        for (const k of placeholder) info(`    ${k}`);
      }
      if (missing.length > 0) {
        err(`${relTarget} — ${missing.length} required key(s) are missing:`);
        for (const k of missing) info(`    ${k}`);
        allOk = false;
      }
    }
  }

  return allOk;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log('\nxConfess contributor bootstrap');
  console.log('================================');
  if (CHECK_ONLY) console.log('Mode: --check-only (no files will be written)\n');

  const runtimeOk = checkRuntime();
  checkDocker(); // warn-only
  const envOk = bootstrapEnvFiles();
  const keysOk = validateEnvKeys();

  console.log('\n────────────────────────────────');

  if (runtimeOk && envOk && keysOk) {
    console.log('\n✓  Bootstrap complete.\n');
    console.log('Next steps:');
    console.log('  1. Review placeholder values in xconfess-backend/.env');
    console.log('     (JWT_SECRET, APP_SECRET, CONFESSION_ENCRYPTION_KEY, ENCRYPTION_MASTER_KEY_v1)');
    console.log('  2. npm run dev:services     # start Postgres + Redis');
    console.log('  3. npm run dev              # start backend + frontend');
    console.log('\nFor full setup details: README.md → Local Development');
  } else {
    console.log('\n✗  Bootstrap finished with issues. Address the errors above before continuing.\n');
    process.exit(1);
  }
}

main();
