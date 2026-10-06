#!/usr/bin/env bash
# Tests for bundle/prune-served-entities.py.
#
# WHAT THIS IS FOR: the tool removes provisioned capacity from a live serving
# endpoint, unattended, straight after a release. The failure that matters is
# not "it did not prune" -- that just costs money for another day. It is
# "it pruned the wrong thing", which takes the demo down. So the cases below
# are mostly about what it must REFUSE and must KEEP, and every one asserts on
# the plan it produced rather than on the exit status alone.
#
# The interesting rules are in plan_prune/build_update_payload, which are pure
# functions over the endpoint's config block, so none of this needs a
# workspace.
#
# Run:  bundle/prune-served-entities.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/prune-served-entities.py"

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

# plan(<keep_rollbacks>, <entities-json>) -> "keep=.. remove=.."
# Drives the pure planner directly so a case is one line.
plan() {
  python3 - "$TOOL" "$1" "$2" <<'PY'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("prune", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
cfg = json.loads(sys.argv[3])
p = m.plan_prune(cfg, int(sys.argv[2]))
if p["refuse"]:
    print("refuse")
else:
    nv = lambda es: ",".join(sorted((e["entity_version"] for e in es), key=int))
    print("keep=%s remove=%s" % (nv(p["keep"]), nv(p["remove"]) or "-"))
PY
}

# Builds an endpoint config: cfg "36:100 35:0 34:0"
cfg() {
  python3 - "$1" <<'PY'
import json, sys
ents, routes = [], []
for tok in sys.argv[1].split():
    v, pct = tok.split(":")
    name = f"m_{v}"
    ents.append({
        "name": name, "entity_version": v,
        "entity_name": "cat.sch.player_insights_agent",
        "scale_to_zero_enabled": False, "workload_size": "Small",
        "state": {"deployment": "DEPLOYMENT_READY"},
        "creator": "someone@example.com", "creation_timestamp": 1,
    })
    routes.append({"served_entity_name": name, "served_model_name": name,
                   "traffic_percentage": int(pct)})
print(json.dumps({"served_entities": ents, "traffic_config": {"routes": routes}}))
PY
}

echo "plan_prune"

# The shape this task was created to fix: ten entities, one serving.
TEN="$(cfg "36:100 35:0 34:0 31:0 30:0 29:0 27:0 25:0 24:0 23:0")"
check "keeps the serving version plus one rollback" \
  "keep=35,36 remove=23,24,25,27,29,30,31,34" "$(plan 1 "$TEN")"
check "rollback count is configurable" \
  "keep=31,34,35,36 remove=23,24,25,27,29,30" "$(plan 3 "$TEN")"
check "keep-rollbacks 0 leaves only what serves" \
  "keep=36 remove=23,24,25,27,29,30,31,34,35" "$(plan 0 "$TEN")"
check "asking for more rollbacks than exist is not an error" \
  "keep=23,24,25,27,29,30,31,34,35,36 remove=-" "$(plan 99 "$TEN")"

# The safety rules.
check "never removes an entity carrying traffic, even a small share" \
  "keep=34,35,36 remove=33" \
  "$(plan 1 "$(cfg "36:90 35:10 34:0 33:0")")"
check "refuses when nothing is taking traffic" \
  "refuse" "$(plan 1 "$(cfg "36:0 35:0")")"
check "an already-pruned endpoint is a no-op" \
  "keep=35,36 remove=-" "$(plan 1 "$(cfg "36:100 35:0")")"
check "a single-entity endpoint is a no-op" \
  "keep=36 remove=-" "$(plan 1 "$(cfg "36:100")")"

# Rollbacks are versions you retreat TO. An idle version ABOVE the serving one
# is a deploy that never took traffic, not a rollback target, so it is not
# allowed to occupy the rollback slot and mask the real one.
check "an idle version above the serving one is removed, not kept as rollback" \
  "keep=34,35 remove=36,37" \
  "$(plan 1 "$(cfg "37:0 36:0 35:100 34:0")")"

# Version ordering is numeric. Lexically "9" > "10", which would keep the wrong
# rollback and remove the one somebody actually wants.
check "orders versions numerically, not lexically" \
  "keep=9,10 remove=2,8" "$(plan 1 "$(cfg "10:100 9:0 8:0 2:0")")"

echo "build_update_payload"

payload() {
  python3 - "$TOOL" "$1" "$2" <<'PY'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("prune", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
p = m.plan_prune(json.loads(sys.argv[3]), int(sys.argv[2]))
print(json.dumps(m.build_update_payload(p), sort_keys=True))
PY
}

PL="$(payload 1 "$TEN")"

check "traffic for the serving version is restated as 100" "100" \
  "$(printf '%s' "$PL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(next(r['traffic_percentage'] for r in d['traffic_config']['routes'] if r['served_model_name']=='m_36'))")"
check "the kept rollback is restated at 0, not left to be redistributed" "0" \
  "$(printf '%s' "$PL" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(next(r['traffic_percentage'] for r in d['traffic_config']['routes'] if r['served_model_name']=='m_35'))")"
check "the write carries exactly the kept entities" "2" \
  "$(printf '%s' "$PL" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['served_entities']))")"
# scale_to_zero off is a deliberate setting on the SERVING entity: a cold start
# on the first question of a demo is exactly what it prevents, so a prune that
# flipped it would look like a cost win and read as a broken demo. The idle
# rollback answers nobody, so it is switched to scale to zero instead of
# billing an always-on replica.
check "serving entity keeps scale_to_zero off; the idle rollback is switched on" "False,True" \
  "$(printf '%s' "$PL" | python3 -c "
import json,sys
es={e['name']:e for e in json.load(sys.stdin)['served_entities']}
print(','.join(str(es[n]['scale_to_zero_enabled']) for n in ('m_36','m_35')))")"
check "an entity carrying a small share of traffic is not treated as idle" "False,False,True" \
  "$(payload 1 "$(cfg "36:90 35:10 34:0")" | python3 -c "
import json,sys
es={e['name']:e for e in json.load(sys.stdin)['served_entities']}
print(','.join(str(es[n]['scale_to_zero_enabled']) for n in ('m_36','m_35','m_34')))")"
check "an always-on rollback is reported even when nothing is removed" "m_35" \
  "$(python3 - "$TOOL" "$(cfg "36:100 35:0")" <<'PY'
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("prune", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
p = m.plan_prune(json.loads(sys.argv[2]), 1)
print(",".join(e["name"] for e in p["always_on_idle"]))
PY
)"
check "read-only fields the API rejects on write are stripped" "" \
  "$(printf '%s' "$PL" | python3 -c "
import json,sys
bad={'state','creator','creation_timestamp'}
print(','.join(sorted(k for e in json.load(sys.stdin)['served_entities'] for k in e if k in bad)))")"

echo "refusals and exit codes"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/prune-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

python3 -c "
import json,sys
cfg=json.loads(sys.argv[1])
json.dump({'state':{'config_update':'IN_PROGRESS','ready':'NOT_READY'},'config':cfg}, open(sys.argv[2],'w'))
" "$TEN" "$tmp/updating.json"
python3 -c "
import json,sys
cfg=json.loads(sys.argv[1])
json.dump({'state':{'config_update':'NOT_UPDATING','ready':'READY'},'config':cfg}, open(sys.argv[2],'w'))
" "$TEN" "$tmp/settled.json"

"$TOOL" --endpoint e --profile p --config-json "$tmp/updating.json" >/dev/null 2>&1
check "refuses (exit 1) while the endpoint is mid-update" "1" "$?"

out="$("$TOOL" --endpoint e --profile p --config-json "$tmp/settled.json" 2>&1)"
rc=$?
check "reports pending prune with exit 3, distinct from failure" "3" "$rc"
case "$out" in
  *"--apply"*) PASS=$((PASS + 1)); printf '  ok    %s\n' "the warning carries the exact command to run" ;;
  *) FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "the warning carries the exact command to run" ;;
esac
case "$out" in
  *"stays registered"*) PASS=$((PASS + 1)); printf '  ok    %s\n' "the warning says the registry is not touched" ;;
  *) FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "the warning says the registry is not touched" ;;
esac

echo "the shipped default"

# WHY THIS IS PINNED: a kept rollback is the version released BEFORE the current
# one, so a standing rollback slot leaves an older behaviour one traffic switch
# from live. That is how a rollback published before the read-as-the-app
# fallback was removed would put the fallback back. The default was 1 until
# 2026-08-17 and is 0 now, deliberately. Nothing else asserts it, so a revert
# would otherwise be silent.
#
# Asserted through the tool's own output rather than by reading the literal, so
# the case fails if the DEFAULT changes or if the planner stops honouring it.
# `$out` above is a run with no --keep-rollbacks, over ten entities with only
# v36 serving: at the default, v35 is removed rather than kept back.
#
# The WHOLE kept list is compared, not searched for a substring. `keeping` lists
# entities in endpoint order, so at a default of 1 the line reads
# "v36(100%), v35(0%)" -- which a prefix match on "v36(100%)" accepts, making
# the case pass on exactly the regression it exists to catch.
check "defaults to keeping no rollback, only what serves" \
  "v36(100%)" \
  "$(printf '%s\n' "$out" | sed -n 's/^  keeping  *//p')"

# The release does not use that default: it passes var.serving_rollbacks_kept
# explicitly. A config that still said 1 would quietly override the tool and
# contradict the comment above, so the two are checked against each other.
BUNDLE_DEFAULT="$(python3 - "$HERE/../databricks.yml" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
# The variable block, up to the next top-level-ish key at the same indent.
m = re.search(r"\n  serving_rollbacks_kept:\n(.*?)(?=\n  \w)", src, re.S)
if not m:
    print("MISSING")
else:
    d = re.search(r"^\s*default:\s*(\S+)\s*$", m.group(1), re.M)
    print(d.group(1) if d else "MISSING")
PY
)"
check "var.serving_rollbacks_kept default agrees with the tool" "0" "$BUNDLE_DEFAULT"

# The registry is a different blast radius. Nothing in this tool may reach it.
if grep -Eq 'model-versions|registered-models|delete_model_version|unity-catalog/models' "$TOOL"; then
  FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "the tool has no code path that touches the registry"
else
  PASS=$((PASS + 1)); printf '  ok    %s\n' "the tool has no code path that touches the registry"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
# A FLOOR, NOT A TOTAL. `FAIL -eq 0` is also true of a run that asserted nothing,
# which is how a green check that matched nothing has got past this project three
# times. The other four suites in this directory already carry one; this was the
# last that could exit 0 having checked nothing. Deliberately below the current
# count, so adding a case is not a two-file change; raise it when cases are added.
readonly MIN_ASSERTIONS=18
[[ "$PASS" -ge "$MIN_ASSERTIONS" ]] || {
  printf '\nFAIL  only %d assertions ran; at least %d are expected.\n' "$PASS" "$MIN_ASSERTIONS" >&2
  printf '      Nothing failed, but this run did not check what it claims to.\n' >&2
  exit 1
}
