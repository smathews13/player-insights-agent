#!/usr/bin/env bash
# Proof that agent/experiments/compare_runs.py fails a synthetic regression
# and refuses a single-metric card.
#
#   bundle/compare-runs.test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
GATE=""
for candidate in \
  "$REPO/agent/experiments/compare_runs.py" \
  "$REPO/platform/agent/experiments/compare_runs.py" \
  "$REPO/extensions/sample-neutral/agent/experiments/compare_runs.py"
do
  if [[ -f "$candidate" ]]; then
    GATE="$candidate"
    break
  fi
done
[[ -n "$GATE" ]] || { echo "compare_runs.py missing"; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-compare-runs.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM
PASS=0
FAIL=0

check_says() {
  local label="$1" expected="$2" needle="$3"; shift 3
  local out status
  out="$("$@" 2>&1)"
  status=$?
  if [[ "$status" != "$expected" ]] || ! printf '%s' "$out" | grep -qF -- "$needle"; then
    printf '  FAIL  %s\n        wanted exit %s and %q; got exit %s\n' \
      "$label" "$expected" "$needle" "$status"
    printf '%s\n' "$out" | sed 's/^/          /'
    FAIL=$((FAIL + 1)); return
  fi
  printf '  ok    %s\n' "$label"
  PASS=$((PASS + 1))
}

python3 - "$WORK" <<'PY'
import json, sys
work = sys.argv[1]

def card(values):
    return {
        "aggregates": [
            {"scorerId": name, "state": "scored", "value": value}
            for name, value in values.items()
        ]
    }

json.dump(card({
    "sql_validity": 1.0,
    "provenance_completeness": 0.9,
    "tool_selection": 0.8,
    "error_rate": 0.05,
}), open(f"{work}/baseline.json", "w"))
json.dump(card({
    "sql_validity": 1.0,
    "provenance_completeness": 0.9,
    "tool_selection": 0.8,
    "error_rate": 0.04,
}), open(f"{work}/ok.json", "w"))
json.dump(card({
    "sql_validity": 0.4,
    "provenance_completeness": 0.9,
    "tool_selection": 0.8,
    "error_rate": 0.05,
}), open(f"{work}/worse.json", "w"))
json.dump(card({"sql_validity": 1.0}), open(f"{work}/thin.json", "w"))
json.dump({"nope": True}, open(f"{work}/bad.json", "w"))
PY

check_says "an equal-or-better candidate passes" 0 \
  "not worse than baseline" \
  python3 "$GATE" --baseline "$WORK/baseline.json" --candidate "$WORK/ok.json"

check_says "a synthetic sql_validity collapse fails the gate" 1 \
  "sql_validity fell" \
  python3 "$GATE" --baseline "$WORK/baseline.json" --candidate "$WORK/worse.json"

check_says "a single-metric card is refused rather than promoted" 2 \
  "single-metric comparison is refused" \
  python3 "$GATE" --baseline "$WORK/thin.json" --candidate "$WORK/thin.json"

check_says "an unreadable scorecard is exit 2" 2 \
  "no aggregates list" \
  python3 "$GATE" --baseline "$WORK/bad.json" --candidate "$WORK/ok.json"

if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
if (( PASS < 4 )); then
  printf 'FAIL  only %d assertions ran.\n' "$PASS"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
