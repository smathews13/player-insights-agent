#!/usr/bin/env bash
# Two explicit verification tiers for release tooling.
#
#   bundle/release-checks.sh fast          release-critical, workspace-free checks
#   bundle/release-checks.sh full          complete manual/CI audit (no browser)
#
# GitHub Actions is disabled for this repository by an enterprise administrator,
# so `full` is documented and runnable but is not claimed as automated.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$ROOT/player-insights-agent"
TIER="${1:-}"

FAST_VITEST=(
  "scripts/deploy-app-yaml.test.ts"
  "server/lib/app-session.test.ts"
  "server/lib/migration-runner.test.ts"
  "server/lib/telemetry-retention.test.ts"
  "server/routes/admin-routes.test.ts"
)

step() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

run_fast() {
  step "Release-critical app, access, session, and migration checks"
  (
    cd "$APP"
    npm test -- "${FAST_VITEST[@]}"
    node scripts/check-migration-order.mjs
  )

  step "Release-critical public derivation leak canary"
  python3 "$ROOT/mirror/check-derived-tree.test.py"

  step "Release-critical Player Insights Agent brand contract"
  python3 "$HERE/brand-contract.test.py"

  step "Release-critical App staging cleanup safety"
  bash "$HERE/app-source-staging.test.sh"

  if [[ -f "$HERE/scope-contract.py" && -f "$HERE/scope-contract.json" ]]; then
    step "Release-critical target and scope contract"
    python3 "$HERE/scope-contract.py" --check
  else
    printf '  note  the internal scope contract is not published in this checkout.\n'
    printf '        app.yaml and runtime access invariants still ran above.\n'
  fi
}

run_full() {
  local failed=()
  full_check() {
    local label="$1"; shift
    step "$label"
    if "$@"; then
      return 0
    fi
    failed+=("$label")
    return 0
  }

  full_check "Complete application unit suite" npm --prefix "$APP" test
  full_check "Complete application typecheck" npm --prefix "$APP" run typecheck
  full_check "Complete application lint" npm --prefix "$APP" run lint
  full_check "Complete application format check" npm --prefix "$APP" run format

  full_check "Complete Python agent unit suite" \
    uv run --directory "$ROOT/agent" --python 3.13 pytest
  full_check "Complete Python agent lint" \
    uv run --directory "$ROOT/agent" --python 3.13 ruff check .

  full_check "Complete bundle checker suites" bash "$HERE/run-checks.sh"
  full_check "Bundle runner control-flow meta-test" bash "$HERE/run-checks.test.sh"
  full_check "Complete mirror derivation regression suite" bash "$ROOT/mirror/sync-mirror.test.sh"
  full_check "Production deploy build and artifact audit" npm --prefix "$APP" run build:deploy

  if (( ${#failed[@]} )); then
    printf '\nFull audit failed in %d command(s):\n' "${#failed[@]}" >&2
    printf '  - %s\n' "${failed[@]}" >&2
    return 1
  fi
  printf '\nFull audit passed.\n'
}

case "$TIER" in
  fast) run_fast ;;
  full) run_full ;;
  *) die "usage: bundle/release-checks.sh fast|full" ;;
esac
