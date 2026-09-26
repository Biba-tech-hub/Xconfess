# Test Data Privacy and Secret Scanning

This document describes the rules for test fixtures, synthetic data, and how
the secret scanning CI gate works. See also: [Security Audit Suppressions](SECURITY_AUDIT_SUPPRESSIONS.md).

## TL;DR

- **Never** use real credentials, tokens, keys, or personally identifiable data
  in test fixtures, snapshots, or seed scripts.
- Use the approved synthetic placeholders listed below.
- Run `npm run secret-scan` locally before opening a PR; the CI will fail if
  secrets are found.

---

## Secret Scanning Gates

xConfess runs two complementary secret-scanning checks in CI:

| Check | Trigger | Tool |
|---|---|---|
| `npm run secret-scan` | Every PR and push to `main` | Python scanner in `scripts/secret-scanning-preflight.sh` |
| Gitleaks detect | Optional local enforcement | `.gitleaks.toml` (project root) |

Both checks run before any build or test jobs. A PR **cannot be merged** if
either check fails.

### Running locally

```bash
# Python-based scanner (no extra install required)
npm run secret-scan             # full scan
npm run secret-scan:self-test   # verify the scanner itself catches secrets
```

If you have the [Gitleaks CLI](https://github.com/gitleaks/gitleaks) installed:

```bash
gitleaks detect --source . --config .gitleaks.toml
```

---

## Approved Fixture Placeholders

Use these values in test files, seed scripts, `.env.example`, and documentation.
They are allowlisted by both the Python scanner and `.gitleaks.toml` and will
not cause CI failures.

### Stellar keys

| Purpose | Safe placeholder value |
|---|---|
| Stellar secret seed (`STELLAR_SERVER_SECRET`) | `SCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| Stellar public key | `GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |

### Encryption keys

| Purpose | Safe placeholder value |
|---|---|
| `CONFESSION_ENCRYPTION_KEY` (64 hex) | `0000000000000000000000000000000000000000000000000000000000000000` |
| `ENCRYPTION_MASTER_KEY_v1` (64 hex) | `0000000000000000000000000000000000000000000000000000000000000002` |

### Auth secrets

| Purpose | Safe placeholder value |
|---|---|
| `JWT_SECRET` | `local-dev-jwt-secret-change-me-32-chars-minimum` |
| `APP_SECRET` | `local-dev-app-secret-change-me-32-chars-minimum` |
| JWT bearer token | `[REDACTED_JWT]` |

### API keys and PATs

| Purpose | Safe placeholder value |
|---|---|
| OpenAI API key | `sk-proj-REDACTED` |
| GitHub PAT | `ghp_[REDACTED]` |
| Generic secret | `[REDACTED]` |

---

## Rules for Test Fixtures

1. **Synthetic users**: Use clearly fake names and email addresses.
   - ✅ `testuser@example.com`, `alice@test.invalid`
   - ❌ Real email addresses, even from public sources

2. **No snapshots containing secrets**: If a Jest/Vitest snapshot captures an
   API response or component prop that contains a token or key field, replace
   the value with the approved placeholder before committing.

3. **Seed data**: The `npm run seed` script creates demo data using fake values
   only (passwords hashed from `password123`, placeholder emails, stub Stellar
   IDs). Do not add real user data to the seed script.

4. **Testnet credentials**: Stellar testnet keypairs used in integration tests
   must be dedicated testnet-only keys with zero real-money exposure. They must
   be stored as CI secrets, not committed to the repo.

5. **Test token scope**: Any token used only in tests should be clearly
   commented as `/* test-only token — never reuse in production */` so
   future contributors know it is intentionally scoped.

---

## What the Scanner Checks

The Python-based scanner (`scripts/secret-scanning-preflight.sh`) detects:

- Stellar secret seeds (56-char base-32 strings starting with `S`)
- JSON Web Tokens (`eyJ...`)
- OpenAI/Anthropic API keys (`sk-proj-...`)
- Stripe live keys (`sk_live_...`, `rk_live_...`)
- GitHub Personal Access Tokens (`ghp_...`, `github_pat_...`)
- Private key PEM blocks (lines starting with `-----BEGIN` followed by `PRIVATE KEY-----`)
- AWS secret access keys

The scanner skips:
- `*.spec.ts`, `*.test.ts` and other test files
- `package-lock.json`, `Cargo.lock`
- Binary assets (images, fonts, WASM)
- `scripts/secret-scanning-preflight.sh` itself (contains pattern strings)

See `scripts/secret-scanning-preflight.sh` for the full rule and allowlist
definitions, and `.gitleaks.toml` for the Gitleaks equivalent.

---

## Adding a New Suppression

If the scanner flags a value that is genuinely safe (e.g., a new doc
placeholder or an allowlisted testnet contract ID), add a suppression in
**both** places:

1. `SAFE_PLACEHOLDER_REGEXES` list in `scripts/secret-scanning-preflight.sh`
2. `[allowlist] > regexes` in `.gitleaks.toml`
3. Document the suppression in `docs/SECURITY_AUDIT_SUPPRESSIONS.md`
