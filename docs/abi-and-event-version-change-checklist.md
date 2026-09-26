# ABI and Event Version Change Checklist

This checklist must be executed whenever contract interfaces, storage schemas, or event payloads are modified to prevent backend parsers and frontend clients from drifting from deployed contracts.

## 1. Contract Phase
- [ ] Determine change classification: Additive (Backward-compatible) vs Breaking (Major bump).
- [ ] For additive event changes: keep `event_version = 1` or bump `event_version` if field ordering changes.
- [ ] Update `abi.json` in `xconfess-contracts/contracts/<contract-name>/abi.json`.
- [ ] Update `deployments/contract-abi-manifest.json` with new function entry points.
- [ ] Ensure `schema_version` functions and migration logic are preserved.

## 2. Backend Event Parser Phase
- [ ] Update `xconfess-backend/src/stellar/event-parser/contract-event-parser.ts` `EVENT_SCHEMAS` with new field order / version.
- [ ] Maintain historical schemas: never remove or overwrite old schema versions so historical ledger events remain decodeable.
- [ ] Verify unsupported or unknown event versions fail safely with `EventParseErrorCode.UNSUPPORTED_VERSION`.
- [ ] Update fixture references in `xconfess-backend/src/stellar/event-parser/contract-event-fixtures.ts`.

## 3. Frontend Client Phase
- [ ] Regenerate or update typed client bindings in `xconfess-frontend/src/contracts/generated/`.
- [ ] Ensure version constants (`*_EVENT_SCHEMA_VERSION`, `*_ABI_VERSION`) are updated in generated clients.
- [ ] Verify frontend contract calls utilize updated parameter structures.

## 4. Pre-release Verification Checklist
- [ ] Storage compatibility tests cover state preservation across upgrades.
- [ ] Event parser tests verify forward compatibility and safe rejection of unknown versions.
- [ ] Deployment metadata in `deployments/testnet.json` is updated following testnet dry-run.
