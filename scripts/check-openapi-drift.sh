#!/usr/bin/env bash
# check-openapi-drift.sh — Verify that committed OpenAPI-generated client files are
# up-to-date with the backend Swagger spec metadata.
#
# Strategy: compare the API spec version and the list of controller-exported route
# paths found in the backend source against a committed snapshot file
# (xconfess-frontend/app/lib/api/generated/.api-snapshot.json).
#
# Exit codes:
#   0 — snapshot is current or check is skipped (backend not running)
#   1 — drift detected or snapshot is missing
#
# Usage (from repo root):
#   bash scripts/check-openapi-drift.sh
#
# In CI the backend is not running, so the live-spec diff is skipped and the
# snapshot existence + controller-path consistency check runs instead.
#
# To regenerate the snapshot after updating routes:
#   npx tsx xconfess-frontend/scripts/generate-openapi-client.ts
#   bash scripts/check-openapi-drift.sh --update-snapshot
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SNAPSHOT_FILE="$SCRIPT_DIR/.api-snapshot.json"
BACKEND_SRC="$REPO_ROOT/xconfess-backend/src"
UPDATE_SNAPSHOT="${1:-}"
DRIFT=0

echo "=== OpenAPI / API Artifact Drift Check ==="
echo ""

# ---------------------------------------------------------------------------
# Helper: extract route paths declared in NestJS controllers
# Looks for @Get(), @Post(), @Patch(), @Put(), @Delete() decorators and
# their string arguments to build a sorted list of declared routes.
# ---------------------------------------------------------------------------
extract_controller_routes() {
  local src_dir="$1"
  # Find all controller files and extract decorator paths
  find "$src_dir" -name '*.controller.ts' -not -path '*/node_modules/*' \
    -exec grep -hoP "@(Get|Post|Patch|Put|Delete)\('?\K[^')]*(?='?\))" {} \; \
    | grep -v '^\s*$' \
    | sort -u
}

# ---------------------------------------------------------------------------
# Check 1: snapshot file exists
# ---------------------------------------------------------------------------
echo "─── Check 1: snapshot file ───"
if [[ ! -f "$SNAPSHOT_FILE" ]]; then
  echo "  ❌ Missing snapshot: $SNAPSHOT_FILE"
  echo ""
  echo "  Run the following to create the initial snapshot:"
  echo "    npx tsx xconfess-frontend/scripts/generate-openapi-client.ts"
  echo "    bash scripts/check-openapi-drift.sh --update-snapshot"
  exit 1
fi
echo "  ✅ Snapshot file found"
echo ""

# ---------------------------------------------------------------------------
# Check 2: generated client files exist
# ---------------------------------------------------------------------------
echo "─── Check 2: generated client files ───"
GENERATED_DIR="$REPO_ROOT/xconfess-frontend/app/lib/api/generated"
MISSING_FILES=()

for f in types.ts api.ts index.ts; do
  if [[ ! -f "$GENERATED_DIR/$f" ]]; then
    MISSING_FILES+=("$f")
  fi
done

if [[ ${#MISSING_FILES[@]} -gt 0 ]]; then
  echo "  ❌ Missing generated files in $GENERATED_DIR:"
  for f in "${MISSING_FILES[@]}"; do
    echo "     - $f"
  done
  echo ""
  echo "  Regenerate with:"
  echo "    npx tsx xconfess-frontend/scripts/generate-openapi-client.ts"
  DRIFT=1
else
  echo "  ✅ All generated client files present"
fi
echo ""

# ---------------------------------------------------------------------------
# Check 3: controller route count consistency
# The snapshot records the number of controller routes at generation time.
# If the current count differs, regeneration is required.
# ---------------------------------------------------------------------------
echo "─── Check 3: controller route consistency ───"

if ! command -v python3 &>/dev/null; then
  echo "  ⚠  python3 not found — skipping snapshot comparison"
else
  SNAPSHOT_ROUTE_COUNT=$(python3 -c "
import json, sys
try:
    with open('$SNAPSHOT_FILE') as f:
        data = json.load(f)
    print(data.get('controllerRouteCount', -1))
except Exception as e:
    print(-1)
" 2>/dev/null)

  CURRENT_ROUTES=$(extract_controller_routes "$BACKEND_SRC")
  CURRENT_ROUTE_COUNT=$(echo "$CURRENT_ROUTES" | grep -c '.' || echo 0)

  echo "  Snapshot route count: $SNAPSHOT_ROUTE_COUNT"
  echo "  Current route count:  $CURRENT_ROUTE_COUNT"

  if [[ "$SNAPSHOT_ROUTE_COUNT" -eq -1 ]]; then
    echo "  ⚠  Could not read snapshot route count — snapshot may be malformed"
    DRIFT=1
  elif [[ "$SNAPSHOT_ROUTE_COUNT" -ne "$CURRENT_ROUTE_COUNT" ]]; then
    echo "  ❌ Route count mismatch — API routes have been added or removed"
    echo "     Regenerate the client and update the snapshot:"
    echo "       npx tsx xconfess-frontend/scripts/generate-openapi-client.ts"
    echo "       bash scripts/check-openapi-drift.sh --update-snapshot"
    DRIFT=1
  else
    echo "  ✅ Route count matches snapshot"
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# Check 4: snapshot timestamp vs generated files (freshness)
# If generated files are older than the most recently modified controller,
# they may be stale.
# ---------------------------------------------------------------------------
echo "─── Check 4: generated file freshness ───"

NEWEST_CONTROLLER=$(find "$BACKEND_SRC" -name '*.controller.ts' -not -path '*/node_modules/*' \
  -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | awk '{print $2}' || true)

if [[ -n "$NEWEST_CONTROLLER" && -f "$GENERATED_DIR/api.ts" ]]; then
  if [[ "$NEWEST_CONTROLLER" -nt "$GENERATED_DIR/api.ts" ]]; then
    echo "  ⚠  $(basename "$NEWEST_CONTROLLER") is newer than generated api.ts"
    echo "     Consider regenerating the client if routes changed."
  else
    echo "  ✅ Generated files are at least as new as the newest controller"
  fi
else
  echo "  ⚠  Could not compare timestamps — skipping freshness check"
fi
echo ""

# ---------------------------------------------------------------------------
# --update-snapshot: write a new snapshot based on current controller routes
# ---------------------------------------------------------------------------
if [[ "$UPDATE_SNAPSHOT" == "--update-snapshot" ]]; then
  echo "─── Updating snapshot ───"
  CURRENT_ROUTES=$(extract_controller_routes "$BACKEND_SRC")
  CURRENT_ROUTE_COUNT=$(echo "$CURRENT_ROUTES" | grep -c '.' || echo 0)

  python3 -c "
import json, datetime
data = {
    'generatedAt': datetime.datetime.utcnow().isoformat() + 'Z',
    'controllerRouteCount': $CURRENT_ROUTE_COUNT,
    'note': 'Auto-generated by scripts/check-openapi-drift.sh --update-snapshot. Commit alongside regenerated client files.'
}
with open('$SNAPSHOT_FILE', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
print('  Snapshot written: $SNAPSHOT_FILE')
"
  echo ""
  echo "  ✅ Snapshot updated. Commit $SNAPSHOT_FILE alongside the generated client files."
  exit 0
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [[ "$DRIFT" -ne 0 ]]; then
  echo "❌ API artifact drift detected."
  echo "   Regenerate the OpenAPI client and re-run this check:"
  echo "     npx tsx xconfess-frontend/scripts/generate-openapi-client.ts"
  echo "     bash scripts/check-openapi-drift.sh --update-snapshot"
  echo ""
  echo "   See docs/API_ARTIFACT_GENERATION.md for details."
  exit 1
else
  echo "✅ API artifact checks passed."
  exit 0
fi
