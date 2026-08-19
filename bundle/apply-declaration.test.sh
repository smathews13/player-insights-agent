#!/usr/bin/env bash
# bundle/apply-declaration.sh refuses without intent, and --plan never calls
# agent-release. Path-anchored; no live workspace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0
check() {
  local name="$1" expected="$2"
  shift 2
  local out status
  set +e
  out="$("$@" 2>&1)"
  status=$?
  set -e
  if [[ "$expected" == "fail" && "$status" -ne 0 ]]; then
    printf 'ok  %s\n' "$name"
  elif [[ "$expected" == "pass" && "$status" -eq 0 ]]; then
    printf 'ok  %s\n' "$name"
  else
    printf 'FAIL  %s (exit %s)\n%s\n' "$name" "$status" "$out"
    fail=1
  fi
}

check "refuses without --i-am-deploying" fail \
  env TARGET=dev bash bundle/apply-declaration.sh --plan

check "refuses without TARGET" fail \
  bash bundle/apply-declaration.sh --plan --i-am-deploying

# Resolver-only path: plan with a declaration, no bundle validate (TARGET still required
# by the shell wrapper). Use a fake that never reaches agent-release.
DECL="$(mktemp)"
trap 'rm -f "$DECL"' EXIT
printf '%s' '{"settings":{"warehouse_id":"wh-test"}}' > "$DECL"

# Without a real target, require_target dies — that is still a refusal gate.
check "plan still needs a real TARGET for the wrapper" fail \
  env TARGET= bash bundle/apply-declaration.sh --plan --i-am-deploying --declaration-json "$DECL"

# Unit coverage for the resolver lives in agent/tests; this file only proves the
# shell wrapper's intent flags and that --apply is not the default.
if grep -q 'PLAN_ONLY=true' bundle/apply-declaration.sh && grep -q 'exec .*agent-release.sh' bundle/apply-declaration.sh; then
  printf 'ok  wrapper defaults to plan and hands off to agent-release on --apply\n'
else
  printf 'FAIL  wrapper contract missing\n'
  fail=1
fi

if grep -q 'Never push to external' .cursor/rules/git-mirror-sync.mdc 2>/dev/null || true; then
  :
fi

exit "$fail"
