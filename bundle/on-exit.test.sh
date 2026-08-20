#!/usr/bin/env bash
# Tests for on_exit in bundle/_lib.sh, the mechanism a release now depends on to
# put back the generated build/deploy/app.yaml.
#
# WHAT THIS IS FOR: that file is tracked, it publishes, and a release writes this
# deployment's administrator addresses into it. Until now the release printed a
# reminder to restore it, which means a release that FAILED -- the run most likely
# to be followed by someone poking at the tree and committing -- printed nothing,
# because it never reached the note.
#
# The mechanism has to hold two properties, and both have already been got wrong
# in this repository:
#
#   1. Cleanup runs on the failure paths, not just the happy one.
#   2. A second registration does not silently replace the first. `trap ... EXIT`
#      does exactly that: one script in this repository leaked a temp directory
#      for weeks because a later trap took over the one that removed it, and
#      seed_bundle_cache owns a registration in every release.
#
# Run:  bundle/on-exit.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/on-exit-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS + 1)); printf '  ok    %s\n' "$label"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL  %s\n        expected %q, got %q\n' "$label" "$expected" "$actual"
  fi
}

# A script that registers two hooks and then does whatever $1 says.
run_case() {
  local body="$1" script="$WORK/case.sh"
  cat >"$script" <<EOF
set -euo pipefail
source "$HERE/_lib.sh"
on_exit 'printf "first\n" >> "$WORK/order"'
on_exit 'printf "second\n" >> "$WORK/order"'
$body
EOF
  rm -f "$WORK/order"
  local status=0
  bash "$script" >"$WORK/out" 2>&1 || status=$?
  printf '%s' "$status"
}

echo "on_exit"
status="$(run_case 'true')"
check "runs on a clean exit" "first second" "$(tr '\n' ' ' < "$WORK/order" | sed 's/ $//')"
check "leaves a clean exit status alone" "0" "$status"

status="$(run_case 'die "something went wrong"')"
check "runs both hooks when the script dies" "first second" "$(tr '\n' ' ' < "$WORK/order" | sed 's/ $//')"
check "preserves the failing exit status" "1" "$status"

status="$(run_case 'false')"
check "runs on a set -e failure" "first second" "$(tr '\n' ' ' < "$WORK/order" | sed 's/ $//')"

status="$(run_case 'exit 7')"
check "preserves an explicit exit code" "7" "$status"

# A hook that fails must not become the script's verdict: cleanup runs on the
# error paths, where swallowing the real failure would be the worst outcome.
cat >"$WORK/hook-fails.sh" <<EOF
set -euo pipefail
source "$HERE/_lib.sh"
on_exit 'false'
on_exit 'printf "ran\n" > "$WORK/after-failing-hook"'
exit 3
EOF
rm -f "$WORK/after-failing-hook"
hook_status=0
bash "$WORK/hook-fails.sh" >/dev/null 2>&1 || hook_status=$?
check "a failing hook does not change the exit status" "3" "$hook_status"
check "a failing hook does not stop the next one" "ran" "$(cat "$WORK/after-failing-hook" 2>/dev/null || true)"

echo
echo "release serialization"
mkdir -p "$WORK/locks"
cat >"$WORK/lock-holder.sh" <<EOF
set -euo pipefail
source "$HERE/_lib.sh"
acquire_run_lock "app-release-example-<your profile>"
touch "$WORK/lock-ready"
while [[ ! -e "$WORK/lock-stop" ]]; do sleep 0.05; done
EOF
cat >"$WORK/lock-contender.sh" <<EOF
set -euo pipefail
source "$HERE/_lib.sh"
acquire_run_lock "app-release-example-<your profile>"
EOF
TMPDIR="$WORK/locks" bash "$WORK/lock-holder.sh" >"$WORK/holder-out" 2>&1 &
holder_pid=$!
for _ in {1..100}; do
  [[ -e "$WORK/lock-ready" ]] && break
  sleep 0.02
done
contender_status=0
TMPDIR="$WORK/locks" bash "$WORK/lock-contender.sh" >"$WORK/contender-out" 2>&1 \
  || contender_status=$?
check "a concurrent release is refused" "1" "$contender_status"
check "the refusal explains the user-facing risk" "1" \
  "$(grep -c 'Refusing to race its build, upload, or deployment' "$WORK/contender-out" || true)"
touch "$WORK/lock-stop"
wait "$holder_pid"
after_status=0
TMPDIR="$WORK/locks" bash "$WORK/lock-contender.sh" >/dev/null 2>&1 || after_status=$?
check "the lock is released when its owner exits" "0" "$after_status"

# The property the release actually needs: a file the script modified is put back
# even though the script failed afterwards.
echo
echo "the release's use of it"
FIX="$WORK/repo"
mkdir -p "$FIX"
git -C "$FIX" init --quiet
git -C "$FIX" config user.email "test@example.invalid"
git -C "$FIX" config user.name "Fixture"
mkdir -p "$WORK/no-hooks"
git -C "$FIX" config core.hooksPath "$WORK/no-hooks"
printf 'value: committed\n' > "$FIX/app.yaml"
git -C "$FIX" add app.yaml
git -C "$FIX" commit --quiet -m "committed app.yaml"

cat >"$WORK/release-like.sh" <<EOF
set -euo pipefail
source "$HERE/_lib.sh"
on_exit 'git -C "$FIX" restore -- app.yaml'
printf 'value: an-administrator@example.com\n' > "$FIX/app.yaml"
die "the deploy failed after the build wrote the file"
EOF
bash "$WORK/release-like.sh" >/dev/null 2>&1 || true
check "restores a generated file after a failed release" "value: committed" "$(cat "$FIX/app.yaml")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
# A floor, not a total, for the reason bundle/bundle-var.test.sh states.
readonly MIN_ASSERTIONS=10
[[ "$PASS" -ge "$MIN_ASSERTIONS" ]] || {
  printf '\nFAIL  only %d assertions ran; at least %d are expected.\n' "$PASS" "$MIN_ASSERTIONS" >&2
  exit 1
}
