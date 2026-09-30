#!/usr/bin/env bash
# Proof that bundle/genie-fingerprint-check.py fails a re-curated space.
#
#   bundle/genie-fingerprint-check.test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/genie-fingerprint-check.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-genie-fp.XXXXXX")"
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
baked = [{"role": "data", "space_id": "s1", "created_at": "t0", "sha256": "aaa", "tables": ["c.s.t"]}]
live_ok = [{"role": "data", "space_id": "s1", "created_at": "t0", "sha256": "aaa", "tables": ["c.s.t"]}]
live_drift = [{"role": "data", "space_id": "s1", "created_at": "t0", "sha256": "bbb", "tables": ["c.s.u"]}]
peer = [{"role": "data", "space_id": "s2", "created_at": "t1", "sha256": "ccc", "tables": ["c.s.t", "c.s.extra"]}]
json.dump(baked, open(f"{work}/baked.json", "w"))
json.dump(live_ok, open(f"{work}/live-ok.json", "w"))
json.dump(live_drift, open(f"{work}/live-drift.json", "w"))
json.dump({"api_scopes": ["sql"], "genie_space_fingerprints": json.dumps(baked)}, open(f"{work}/summary.json", "w"))
json.dump({"api_scopes": ["sql"], "genie_space_fingerprints": json.dumps(peer)}, open(f"{work}/peer-summary.json", "w"))
json.dump({"api_scopes": ["sql"]}, open(f"{work}/no-fp.json", "w"))
PY

check_says "matching live and baked fingerprints pass" 0 \
  "matches the artifact" \
  python3 "$GATE" --fixture-baked "$WORK/baked.json" --fixture-live "$WORK/live-ok.json"

check_says "a re-curated space fails and asks for a re-log" 1 \
  "Re-log the model" \
  python3 "$GATE" --fixture-baked "$WORK/baked.json" --fixture-live "$WORK/live-drift.json"

check_says "peer table drift is a finding" 1 \
  "right target curates tables" \
  python3 "$GATE" --logged "$WORK/summary.json" --peer-logged "$WORK/peer-summary.json" \
    --fixture-live "$WORK/live-ok.json"

check_says "allowlisted extra tables pass" 0 \
  "peer target tables agree" \
  python3 "$GATE" --logged "$WORK/summary.json" --peer-logged "$WORK/peer-summary.json" \
    --fixture-live "$WORK/live-ok.json" --allow-table-diff c.s.extra

check_says "a summary with no fingerprint key is exit 2" 2 \
  "no genie_space_fingerprints key" \
  python3 "$GATE" --logged "$WORK/no-fp.json" --skip-live

check_says "model logging and release wire the fingerprint before promotion" 0 \
  "fingerprint release wiring is ordered" \
  python3 - "$HERE/../agent/log_model.py" "$HERE/agent-release.sh" <<'PY'
from pathlib import Path
import sys

log_model = Path(sys.argv[1]).read_text()
release = Path(sys.argv[2]).read_text()

capture = log_model.index("space_fingerprint_records = records_from_genie")
model_config = log_model.index("SPACE_FINGERPRINTS_KEY: space_fingerprints", capture)
summary = log_model.rindex("SPACE_FINGERPRINTS_KEY: space_fingerprints")
assert capture < model_config < summary

parsed_summary = release.index('LOG_SUMMARY="$(mktemp')
fingerprint_gate = release.index('step "Genie space fingerprint vs the live space"')
endpoint_deploy = release.index('python deploy_agent.py --model-version "$MODEL_VERSION"')
assert parsed_summary < fingerprint_gate < endpoint_deploy
assert 'case "$FINGERPRINT_STATUS" in' in release
assert '1)' in release[fingerprint_gate:endpoint_deploy]
assert '2)' in release[fingerprint_gate:endpoint_deploy]
print("fingerprint release wiring is ordered")
PY

if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
if (( PASS < 6 )); then
  printf 'FAIL  only %d assertions ran.\n' "$PASS"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
