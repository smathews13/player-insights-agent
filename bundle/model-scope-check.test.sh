#!/usr/bin/env bash
# Proof that bundle/model-scope-check.py fails on each of the model legs.
#
# The logged leg is driven by fabricated release summaries, so it needs no
# workspace. The configured and documented legs are proved by really editing
# databricks.yml, the semantic resource file and the generated contract, because
# the claim of those legs is that they track those files.
#
# WHY THIS SUITE EXISTS AT ALL. The contract distinguished the app's token from
# the model's from the day it was written, and nothing consumed the model half:
# `app-release.sh` ran the check against the app object and `agent-release.sh` ran
# no scope check of any kind. A leg with no consumer and no test is a comment.
#
#   bundle/model-scope-check.test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
GATE="$HERE/model-scope-check.py"
CONTRACT="$HERE/scope-contract.json"
BUNDLE="$REPO/databricks.yml"
INDEX_YML="$REPO/resources/player_insights_semantic.example.yml"
TARGET="${MODEL_SCOPE_TEST_TARGET:-example}"

PASS=0
FAIL=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-model-scope-test.XXXXXX")"

for f in "$BUNDLE" "$INDEX_YML" "$CONTRACT"; do cp "$f" "$WORK/$(basename "$f").orig"; done
restore() {
  cp "$WORK/databricks.yml.orig" "$BUNDLE"
  cp "$WORK/$(basename "$INDEX_YML").orig" "$INDEX_YML"
  cp "$WORK/scope-contract.json.orig" "$CONTRACT"
}
trap 'restore; rm -rf "$WORK"' EXIT INT TERM

# perl, not sed: BSD sed ignores `\b`, exits 0 and changes nothing, which is how a
# substitution step in this repository silently did nothing for weeks. The count
# is checked so a rule matching nothing fails here rather than passing quietly.
edit() {
  local file="$1" expr="$2" n
  n="$(perl -0777 -pe "\$c += s${expr}; END { print STDERR \$c + 0 }" -i "$file" 2>&1 >/dev/null)"
  if [[ "${n:-0}" -lt 1 ]]; then
    printf '  FAIL  the test edit %s matched nothing in %s\n' "$expr" "$(basename "$file")"
    FAIL=$((FAIL + 1)); return 1
  fi
}

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

summary() {
  local file="$WORK/$1"; shift
  python3 - "$file" "$@" <<'PY'
import json, sys
json.dump({"api_scopes": sys.argv[2:]}, open(sys.argv[1], "w"))
PY
  printf '%s' "$file"
}

# The scopes this target really would bake, read out of the contract rather than
# named here, so the suite carries no scope spelling of its own to go stale.
SQL="$(python3 -c '
import json,sys
c=json.load(open(sys.argv[1]))
print(next(s for s in c["model_scopes"] if s.startswith("sql")))' "$CONTRACT")"
VS="$(python3 -c '
import json,sys
c=json.load(open(sys.argv[1]))
print(" ".join(sorted(s for s in c["model_scopes"] if s.startswith("vectorsearch"))))' "$CONTRACT")"
GENIE="$(python3 -c '
import json,sys
c=json.load(open(sys.argv[1]))
print(next(s for s in c["model_scopes"] if "genie" in s))' "$CONTRACT")"

printf '\n==> the baseline this repository is actually in\n'
check_says "configured and documented agree" 0 "scopes agree" \
  python3 "$GATE" --target "$TARGET"

# shellcheck disable=SC2086
check_says "and agree with a logged model that baked exactly them" 0 "and logged scopes agree" \
  python3 "$GATE" --target "$TARGET" --logged "$(summary good.json "$GENIE" "$SQL" $VS)"

# THE DIRECTORY THE GATE IS INVOKED FROM MUST NOT DECIDE WHETHER IT RUNS. Three of
# the gate's four inputs are siblings of itself -- drift-check.py, scope-contract.py
# and scope-contract.json -- and one is the repository root's databricks.yml, which
# drift-check.py reaches through its own parent. Resolve any of those against the
# current working directory instead of __file__ and the gate dies with
# FileNotFoundError on a path that plainly exists, which reads as a missing file
# rather than as a bug in the gate. It has always been anchored; nothing proved it,
# so nothing would notice a later edit that un-anchored it. `/` and bundle/ are the
# two ends of the range: one shares no prefix with the repository at all, the other
# is the near miss where a `bundle/`-prefixed relative path resolves to
# `bundle/bundle/`.
for from in / "$HERE"; do
  check_says "the gate resolves its siblings when invoked from $from" 0 "scopes agree" \
    bash -c 'cd "$1" && exec python3 "$2" --target "$3"' _ "$from" "$GATE" "$TARGET"
done

printf '\n==> the logged leg: what the release actually baked\n'
# The VS pair, not the SQL scope: the warehouse id is not in the tracked file, so
# the SQL scope is undecidable here and a logged model that omits it is not a
# finding. The semantic index IS declared in the resource file, so the VS pair is
# the scope this target really does ask for.
check_says "a logged model missing a scope this target asks for fails" 1 \
  "will not carry the scope" \
  python3 "$GATE" --target "$TARGET" --logged "$(summary short.json "$GENIE" "$SQL")"

check_says "a logged model carrying a scope nothing asks for fails" 1 \
  "one more API the agent could be made to call" \
  python3 "$GATE" --target "$TARGET" --logged "$(summary wide.json "$GENIE" "$SQL" "files.files")"

check_says "an empty baked scope list fails, and says where it would have failed" 1 \
  "inside the container rather than here" \
  python3 "$GATE" --target "$TARGET" --logged "$(summary empty.json)"

printf '\n==> the configured leg: the target really is read\n'
# A WAREHOUSE THIS FILE CANNOT RESOLVE IS "CANNOT TELL FROM HERE", NOT "NO
# WAREHOUSE" -- the Genie ids' rule, applied to the warehouse because it is the
# same situation: the id names one workspace's warehouse and reaches a release
# through variable-overrides.json or BUNDLE_VAR_warehouse_id, never through this
# tracked file. Read as "no warehouse" it made the gate block a correct release,
# claiming the SQL scope was baked and unasked-for. These two assertions are what
# stops that reading coming back: an absent value and one still written as an
# interpolation must BOTH pass a model that baked the scope.
# shellcheck disable=SC2086
check_says "an unresolvable warehouse leaves the SQL scope undecided, not unasked-for" 0 \
  "$SQL: undecidable statically, and the logged model carries it" \
  python3 "$GATE" --target "$TARGET" --logged "$(summary undecided.json "$GENIE" "$SQL" $VS)"

# shellcheck disable=SC2086
edit "$BUNDLE" "{\n  warehouse_id:\n    description:}{\n  warehouse_id:\n    default: \\\$\\{resources.sql_warehouses.demo.id\\}\n    description:}" && \
  check_says "a warehouse still written as an interpolation is undecided too" 0 \
    "$SQL: undecidable statically, and the logged model carries it" \
    python3 "$GATE" --target "$TARGET" --logged "$(summary interp.json "$GENIE" "$SQL" $VS)"
restore

# THE REAL CHECK MUST STILL FIRE. Undecidable is only the unresolvable case: when
# the file DOES carry a warehouse id, the SQL scope is asked for, and a logged
# model that did not bake it is the failure this gate exists for -- the agent calls
# the SQL API and the downscoped token does not carry the scope.
# shellcheck disable=SC2086
edit "$BUNDLE" "{\n  warehouse_id:\n    description:}{\n  warehouse_id:\n    default: abc123def4567890\n    description:}" && \
  check_says "a resolvable warehouse whose scope the model did not bake still fails" 1 \
    "will not carry the scope" \
    python3 "$GATE" --target "$TARGET" --logged "$(summary mismatch.json "$GENIE" $VS)"
restore

# A target with no semantic layer must not be told it asks for the Vector Search
# pair, because that pair is added under a condition api_scopes() cannot see and
# is the specific place the two lists have drifted apart before.
edit "$INDEX_YML" "{\n      semantic_index_endpoint: }{\n      semantic_index_endpoint_unset: }" && \
  check_says "a target with no semantic index does not ask for the VS pair" 1 \
    "one more API the agent could be made to call" \
    python3 "$GATE" --target "$TARGET" --logged "$(summary vs.json "$GENIE" "$SQL" $VS)"
restore

printf '\n==> the documented leg: the contract really is read\n'
python3 - "$CONTRACT" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for body in d["model_scopes"].values():
    body["asked_when"] = []
json.dump(d, open(p, "w"), indent=2)
PY
check_says "a documented scope with no condition fails" 1 \
  "nothing says when it is asked for" python3 "$GATE" --target "$TARGET"
restore

python3 - "$CONTRACT" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for body in d["model_scopes"].values():
    body["classification"] = {"surface": "unclassified", "reads": "UNKNOWN"}
json.dump(d, open(p, "w"), indent=2)
PY
check_says "an unclassified model scope fails" 1 \
  "can read governed rows" python3 "$GATE" --target "$TARGET"
restore

python3 - "$CONTRACT" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["model_scopes"] = {}
json.dump(d, open(p, "w"), indent=2)
PY
check_says "a contract documenting no model scopes is exit 2, not agreement" 2 \
  "not a model that asks for nothing" python3 "$GATE" --target "$TARGET"
restore

printf '\n==> a check that cannot run must not report agreement\n'
printf 'not json' > "$WORK/bad.json"
check_says "an unreadable logged summary is exit 2" 2 \
  "COULD NOT RUN the logged leg" python3 "$GATE" --target "$TARGET" --logged "$WORK/bad.json"

printf '{"declared_tables": 12}' > "$WORK/wrongshape.json"
check_says "a summary with no api_scopes key is exit 2, not zero scopes" 2 \
  "look the same" python3 "$GATE" --target "$TARGET" --logged "$WORK/wrongshape.json"

check_says "a missing logged summary is exit 2" 2 \
  "COULD NOT RUN the logged leg" python3 "$GATE" --target "$TARGET" --logged "$WORK/nope.json"

check_says "an unknown target is exit 2" 2 \
  "COULD NOT RUN" python3 "$GATE" --target no-such-target

printf '{"model_scopes": {}}' > "$CONTRACT"
check_says "a hand-emptied contract is exit 2, not trusted" 2 \
  "documents no model scopes" python3 "$GATE" --target "$TARGET"
restore

printf '\n'
restore
check_says "the repository was restored" 0 "scopes agree" python3 "$GATE" --target "$TARGET"

if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
if (( PASS < 20 )); then
  printf 'FAIL  only %d assertions ran; this suite has 20. Something is being skipped.\n' "$PASS"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
