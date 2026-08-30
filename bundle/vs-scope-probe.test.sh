#!/usr/bin/env bash
# Proof that bundle/vs-scope-probe.py fails on each of the three questions it asks.
#
# Driven by fabricated API replies through --responses, so it needs no workspace
# and gives the same answer every time. The declared leg edits databricks.yml for
# real, because the claim of that leg is that it reads the target's list.
#
# WHY THE SHAPE CASES MATTER MOST. Declared and reachable are both satisfiable by
# configuration. The synthetic invocation is the one that fails when the scope is
# spelled in a way the validator accepts and the API does not honour -- which is
# the shape of the two failures this repository has actually had here: a coarse
# scope name the Apps API rejected outright, and a probe path refused at runtime
# whose symptom was a GRANT statement printed at a reader who already had access.
#
#   bundle/vs-scope-probe.test.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
GATE="$HERE/vs-scope-probe.py"
BUNDLE="$REPO/databricks.yml"
CONTRACT="$HERE/scope-contract.json"
TARGET="${VS_PROBE_TEST_TARGET:-example}"

PASS=0
FAIL=0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-vs-probe-test.XXXXXX")"

cp "$BUNDLE" "$WORK/databricks.yml.orig"
cp "$CONTRACT" "$WORK/scope-contract.json.orig"
restore() {
  cp "$WORK/databricks.yml.orig" "$BUNDLE"
  cp "$WORK/scope-contract.json.orig" "$CONTRACT"
}
trap 'restore; rm -rf "$WORK"' EXIT INT TERM

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

GOOD="$WORK/good"
mkdir -p "$GOOD"
cat > "$GOOD/endpoint.json" <<'JSON'
{"name": "semantic-vs", "endpoint_status": {"state": "ONLINE"}}
JSON
cat > "$GOOD/index.json" <<'JSON'
{"name": "an.index", "status": {"indexed_row_count": 62}}
JSON
# The reply shape the live index really returns, columns and envelope included.
cat > "$GOOD/query.json" <<'JSON'
{"manifest": {"column_count": 3,
              "columns": [{"name": "entry_id"}, {"name": "content"}, {"name": "score"}]},
 "result": {"data_array": [["an-id", "some entry text", 0.54]], "row_count": 1}}
JSON

copy_good() { rm -rf "$1"; cp -R "$GOOD" "$1"; }

printf '\n==> the baseline: declared, reachable and answering\n'
check_says "a healthy index passes all three" 0 "declared, reachable and answering" \
  python3 "$GATE" --target "$TARGET" --responses "$GOOD"

printf '\n==> DECLARED: the target must ask for what the index needs\n'
edit "$BUNDLE" "{\n      - vectorsearch.vector-search-indexes:read}{}" && \
  check_says "an undeclared Vector Search scope fails" 1 \
    "reads a refusal as a missing Unity Catalog grant" \
    python3 "$GATE" --target "$TARGET" --responses "$GOOD"
restore

printf '\n==> REACHABLE: the endpoint and index must answer\n'
BAD="$WORK/offline"; copy_good "$BAD"
printf '{"name": "x", "endpoint_status": {"state": "PROVISIONING"}}' > "$BAD/endpoint.json"
check_says "an endpoint that is not ONLINE fails" 1 \
  "reads as 'found no semantics'" python3 "$GATE" --target "$TARGET" --responses "$BAD"

BAD="$WORK/emptyindex"; copy_good "$BAD"
printf '{"name": "x", "status": {"indexed_row_count": 0}}' > "$BAD/index.json"
check_says "an index holding nothing fails" 1 \
  "would answer nothing for a real question" python3 "$GATE" --target "$TARGET" --responses "$BAD"

printf '\n==> ANSWERS: the synthetic invocation, and the SHAPE of its reply\n'
BAD="$WORK/nocols"; copy_good "$BAD"
printf '{"result": {"data_array": []}}' > "$BAD/query.json"
check_says "a reply with no column manifest fails" 1 \
  "not the shape agent/semantic_retrieval.py reads" \
  python3 "$GATE" --target "$TARGET" --responses "$BAD"

# THE CASE A REACHABILITY CHECK MISSES: the call succeeded, and the result is
# unusable because a column the retrieval tool reads is not in it.
BAD="$WORK/missingcol"; copy_good "$BAD"
cat > "$BAD/query.json" <<'JSON'
{"manifest": {"columns": [{"name": "entry_id"}, {"name": "score"}]},
 "result": {"data_array": [], "row_count": 0}}
JSON
check_says "a reply missing a column the tool reads fails" 1 \
  "the result is unusable" python3 "$GATE" --target "$TARGET" --responses "$BAD"

BAD="$WORK/noenvelope"; copy_good "$BAD"
printf '{"manifest": {"columns": [{"name": "entry_id"}, {"name": "content"}]}}' > "$BAD/query.json"
check_says "a reply with no result envelope fails" 1 \
  "not even an empty one" python3 "$GATE" --target "$TARGET" --responses "$BAD"

# A query that matched nothing is NOT a failure -- the probe string is chosen to
# match nothing, and a nearest-neighbour search returns the closest row anyway.
BAD="$WORK/nomatch"; copy_good "$BAD"
cat > "$BAD/query.json" <<'JSON'
{"manifest": {"columns": [{"name": "entry_id"}, {"name": "content"}]},
 "result": {"data_array": [], "row_count": 0}}
JSON
check_says "a query matching nothing passes, since the probe string matches nothing" 0 \
  "declared, reachable and answering" python3 "$GATE" --target "$TARGET" --responses "$BAD"

printf '\n==> a probe that was prevented from asking must not report a working index\n'
BAD="$WORK/absent"; copy_good "$BAD"; rm -f "$BAD/query.json"
check_says "a missing reply is exit 2, not a pass" 2 \
  "PREVENTED from asking" python3 "$GATE" --target "$TARGET" --responses "$BAD"

BAD="$WORK/unparseable"; copy_good "$BAD"; printf 'Error: unknown flag' > "$BAD/query.json"
check_says "an unparseable reply is exit 2, not an empty result" 2 \
  "not readable JSON" python3 "$GATE" --target "$TARGET" --responses "$BAD"

BAD="$WORK/noendpoint"; copy_good "$BAD"; rm -f "$BAD/endpoint.json"
check_says "an unreachable endpoint is exit 2, and says how far it got" 2 \
  "got as far as" python3 "$GATE" --target "$TARGET" --responses "$BAD"

check_says "an unknown target is exit 2" 2 \
  "COULD NOT RUN" python3 "$GATE" --target no-such-target --responses "$GOOD"

python3 - "$CONTRACT" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
d["app_scopes"] = {k: v for k, v in d["app_scopes"].items() if not k.startswith("vectorsearch")}
json.dump(d, open(p, "w"), indent=2)
PY
check_says "a contract recording no VS scope is exit 2, not nothing to check" 2 \
  "is not written down anywhere" python3 "$GATE" --target "$TARGET" --responses "$GOOD"
restore

printf '\n'
restore
check_says "the repository was restored" 0 "declared, reachable and answering" \
  python3 "$GATE" --target "$TARGET" --responses "$GOOD"

if (( FAIL )); then
  printf 'FAIL  %d of %d assertions failed.\n' "$FAIL" "$((PASS + FAIL))"
  exit 1
fi
if (( PASS < 14 )); then
  printf 'FAIL  only %d assertions ran; this suite has 14. Something is being skipped.\n' "$PASS"
  exit 1
fi
printf 'PASS  %d assertions.\n' "$PASS"
