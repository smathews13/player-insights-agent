#!/usr/bin/env bash
# Meta-tests for the fast/full release tier boundary.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$ROOT/player-insights-agent"
RUNNER="$HERE/release-checks.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-release-tiers.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

PASS=0
FAIL=0
pass() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }

source_section() {
  python3 - "$RUNNER" "$1" "$2" <<'PY'
import sys
text = open(sys.argv[1], encoding="utf-8").read()
start = text.index(sys.argv[2])
end = text.index(sys.argv[3], start)
print(text[start:end])
PY
}

expect_status() {
  local label="$1" expected="$2" needle="$3"; shift 3
  local out status=0
  out="$("$@" 2>&1)" || status=$?
  if [[ "$status" == "$expected" && "$out" == *"$needle"* ]]; then
    pass "$label"
  else
    fail "$label (wanted exit $expected containing '$needle'; got $status)"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
}

printf '\n==> compact fast allowlist and complete full tier\n'
FAST="$(source_section 'run_fast() {' 'run_full() {')"
FULL="$(source_section 'run_full() {' 'case "$TIER"')"
ALLOWLIST="$(source_section 'FAST_VITEST=(' 'step() {')"
for file in \
  scripts/deploy-app-yaml.test.ts \
  server/lib/app-session.test.ts \
  server/lib/migration-runner.test.ts \
  server/lib/telemetry-retention.test.ts \
  server/routes/admin-routes.test.ts; do
  [[ "$ALLOWLIST" == *"$file"* ]] || fail "fast tier lost $file"
done
[[ "$FAST" == *'check-migration-order.mjs'* ]] || fail "fast tier lost migration ordering"
[[ "$FAST" == *'check-derived-tree.test.py'* ]] || fail "fast tier lost the derived-tree adversarial canary"
[[ "$FAST" == *'app-source-staging.test.sh'* ]] || fail "fast tier lost guarded App staging cleanup"
[[ "$FAST" == *'scope-contract.py" --check'* ]] || fail "fast tier lost the target/scope contract"
if [[ "$FAST" != *'pytest'* && "$FAST" != *'npm run typecheck'* \
   && "$FAST" != *'npm run lint'* && "$FAST" != *'npm run format'* \
   && "$FAST" != *'run-checks.sh'* && "$FAST" != *'npm --prefix "$APP" test'* ]]; then
  pass "fast tier excludes every full-suite command"
else
  fail "fast tier contains a full-suite command"
fi

for required in \
  'npm --prefix "$APP" test' \
  'npm --prefix "$APP" run typecheck' \
  'npm --prefix "$APP" run lint' \
  'npm --prefix "$APP" run format' \
  'uv run --directory "$ROOT/agent" --python 3.13 pytest' \
  'uv run --directory "$ROOT/agent" --python 3.13 ruff check .' \
  'run-checks.sh' \
  'run-checks.test.sh' \
  'sync-mirror.test.sh' \
  'npm --prefix "$APP" run build:deploy'; do
  [[ "$FULL" == *"$required"* ]] || fail "full tier does not invoke $required"
done
if [[ "$FAIL" -eq 0 ]]; then
  pass "fast and full tier membership is explicit"
fi

printf '\n==> representative release corruption goes red\n'
mkdir -p "$WORK/secret-tree"
printf 'owner=<your-username>\n' > "$WORK/secret-tree/settings.txt"
expect_status "private value is refused" 1 "private value survived" \
  python3 "$ROOT/mirror/check-derived-tree.py" "$WORK/secret-tree"

cp -R "$APP/build/deploy" "$WORK/broken-artifact"
printf '{}\n' > "$WORK/broken-artifact/package.json"
expect_status "package-bearing artifact is refused" 1 "trigger package installation" \
  node "$APP/scripts/check-deploy-artifact.mjs" --deploy-dir "$WORK/broken-artifact"

SCOPE_ROOT="$WORK/scope"
mkdir -p "$SCOPE_ROOT/bundle" "$SCOPE_ROOT/player-insights-agent/server/lib" "$SCOPE_ROOT/agent"
cp "$ROOT/databricks.yml" "$SCOPE_ROOT/databricks.yml"
cp "$HERE/scope-contract.json" "$SCOPE_ROOT/bundle/scope-contract.json"
cp "$APP/server/lib/dependency-probes.ts" "$SCOPE_ROOT/player-insights-agent/server/lib/dependency-probes.ts"
cp "$ROOT/agent/user_authorization.py" "$ROOT/agent/semantic_retrieval.py" "$SCOPE_ROOT/agent/"
python3 - "$SCOPE_ROOT/databricks.yml" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
at = text.index("\n  app_user_api_scopes:")
match = re.search(r"\n(\s+)- \S+", text[at:])
assert match
insert = at + match.end()
path.write_text(text[:insert] + f"\n{match.group(1)}- files.files" + text[insert:])
PY
expect_status "scope contract corruption is refused" 1 "scope-contract.json no longer matches" \
  env PIA_SCOPE_REPO="$SCOPE_ROOT" python3 "$HERE/scope-contract.py" --check

cp "$APP/server/lib/migrations.ts" "$WORK/migrations.ts"
python3 - "$WORK/migrations.ts" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = "    version: 24,\n"
assert old in text
path.write_text(text.replace(old, "    version: 26,\n", 1))
PY
expect_status "migration ordering corruption is refused" 1 "must be unique, contiguous, and ascending" \
  node "$APP/scripts/check-migration-order.mjs" "$WORK/migrations.ts"

REGRESSION_ROOT="$WORK/regressed-root"
REGRESSION_APP="$REGRESSION_ROOT/player-insights-agent"
REGRESSION_RUNNER="$REGRESSION_ROOT/bundle/release-checks.sh"
mkdir -p "$REGRESSION_APP" "$REGRESSION_ROOT/bundle" "$REGRESSION_ROOT/mirror"
git -C "$ROOT" archive HEAD:player-insights-agent | tar -x -C "$REGRESSION_APP"
ln -s "$APP/node_modules" "$REGRESSION_APP/node_modules"
cp "$RUNNER" "$REGRESSION_RUNNER"
cp "$ROOT/mirror/check-derived-tree.py" "$ROOT/mirror/check-derived-tree.test.py" \
  "$REGRESSION_ROOT/mirror/"
python3 - "$REGRESSION_APP/server/lib/migration-runner.ts" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
marker = "// Stop. Ordering is the entire value of numbering"
start = text.index(marker)
stop = text.index("    break;", start)
path.write_text(text[:stop] + "    continue;" + text[stop + len("    break;"):])
PY
expect_status "v23 failure cannot continue into v24 in the fast gate" 1 \
  "never attempts or records later migrations when v23 is incomplete" \
  bash "$REGRESSION_RUNNER" fast

printf '\n'
if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
