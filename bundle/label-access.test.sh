#!/usr/bin/env bash
# Offline proof that label-access.sh grants each label group only its own
# schemas plus the shared ones, attaches the master-table row filter, and that
# --verify catches a cross-label read, a missing row filter, a central-only
# table a label can read or whose privileges cannot be read, and a label outside
# the agent's read scope. The checks themselves are the module's; its own tests
# cover the access matrix, owners, bindings and the no-data identities.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pia-label-access-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

PASS=0
FAIL=0
ok() { printf '  ok    %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }

mkdir -p "$WORK/bin"
cat > "$WORK/bin/databricks" <<'PY'
#!/usr/bin/env python3
"""The calls label_access.py makes through `databricks api`, against files in $WORK."""
import json, os, sys
from urllib.parse import parse_qs, unquote, urlsplit

args = sys.argv[1:]
open(os.environ["CALLS"], "a").write(" ".join(args) + "\n")
if args[:2] == ["bundle", "validate"]:
    sys.stdout.write(open(os.environ["BUNDLE_FIXTURE"]).read())
    raise SystemExit(0)
if args[0] != "api":
    sys.exit(f"unexpected databricks call: {' '.join(args)}")
method, url = args[1], urlsplit(args[2])
body = json.loads(args[args.index("--json") + 1]) if "--json" in args else None
parts = [unquote(p) for p in url.path.split("/")]
grants_path = os.environ["GRANTS"]
state = json.load(open(grants_path))

if method == "patch" and "permissions" in parts:
    kind, name = parts[-2], parts[-1]
    for change in body["changes"]:
        key = f"{kind} {name} {change['principal']}"
        state[key] = sorted(set(state.get(key, [])) | set(change.get("add", [])))
    json.dump(state, open(grants_path, "w"))
    print("{}")
elif method == "get" and "effective-permissions" in parts:
    kind, name = parts[-2], parts[-1]
    principal = parse_qs(url.query)["principal"][0]
    if os.environ.get("UNREADABLE_TABLES") == "1" and kind == "table":
        sys.exit("Error: permission denied")
    held = list(state.get(f"{kind} {name} {principal}", []))
    if os.environ.get("OPEN_CATALOG") == "1" and kind == "schema":
        held += ["ALL_PRIVILEGES", "SELECT", "USE_SCHEMA"]
    print(json.dumps({"privilege_assignments": [{"principal": principal, "privileges": [{"privilege": p} for p in held]}]}))
elif method == "get" and parts[-2] == "tables":
    filtered = os.environ["FILTERED"]
    print(json.dumps({"row_filter": {"function_name": open(filtered).read()}} if os.path.exists(filtered) else {}))
elif method == "get" and parts[-2] in ("catalogs", "schemas"):
    print(json.dumps({"owner": "Data_Governance", "isolation_mode": "ISOLATED"}))
elif method == "post" and url.path == "/api/2.0/sql/statements":
    statement = body["statement"]
    if statement.startswith("ALTER TABLE "):
        open(os.environ["FILTERED"], "w").write(statement.split(" SET ROW FILTER ")[1].split()[0])
    open(os.environ["STATEMENTS"], "a").write(statement + "\n")
    print('{"status":{"state":"SUCCEEDED"}}')
else:
    sys.exit(f"unexpected databricks call: {' '.join(args)}")
PY
chmod +x "$WORK/bin/databricks"

bundle_fixture() {
  printf '{"variables":{"data_catalogs":{"value":%s},"warehouse_id":{"value":"wh-1"}}}' "$1" > "$WORK/bundle.json"
}

config() {
  cat > "$WORK/config.json" <<JSON
{
  "catalog": "prod",
  "shared_schemas": ["global_production"],
  "central_groups": ["Central_Readers"],
  "labels": [
    {"label": "A", "group": "Label_A_Readers", "schemas": ["label_a_production"]},
    {"label": "B", "group": "Label_B_Readers", "schemas": ["label_b_production"]}
  ],
  "master_tables": [{"table": "prod.xlabel.master", "label_column": "label", "readers": "${1:-all_labels}"}]
}
JSON
}

reset() {
  printf '{}' > "$WORK/grants.json"
  : > "$WORK/calls"
  : > "$WORK/statements"
  rm -f "$WORK/filtered"
}

run_tool() {
  env -u PIA_BUNDLE_JSON_CACHE PATH="$WORK/bin:$PATH" CALLS="$WORK/calls" GRANTS="$WORK/grants.json" \
    FILTERED="$WORK/filtered" STATEMENTS="$WORK/statements" BUNDLE_FIXTURE="$WORK/bundle.json" \
    LABEL_ACCESS_CONFIG="$WORK/config.json" TARGET=test PROFILE=test-profile OPEN_CATALOG="${OPEN_CATALOG:-}" \
    UNREADABLE_TABLES="${UNREADABLE_TABLES:-}" \
    bash "$HERE/label-access.sh" "$@" > "$WORK/output" 2>&1
}

granted() {
  python3 - "$WORK/grants.json" "$1" "$2" <<'PY'
import json, sys
path, key, privilege = sys.argv[1:]
raise SystemExit(0 if privilege in json.load(open(path)).get(key, []) else 1)
PY
}

echo "label-access.sh"

bundle_fixture '["prod"]'
config
reset
if run_tool && ! grep -q '^api patch\|^api post' "$WORK/calls"; then
  ok "the plan changes nothing"
else
  bad "the plan wrote something: $(cat "$WORK/calls")"
fi
grep -q "Label_A_Readers: USE_SCHEMA, SELECT" "$WORK/output" && grep -q "SET ROW FILTER" "$WORK/output" \
  && ok "the plan lists the grants and the row-filter SQL" || bad "the plan is incomplete: $(cat "$WORK/output")"

reset
if run_tool --apply; then ok "apply grants, filters and verifies"; else bad "apply failed: $(cat "$WORK/output")"; fi
granted "schema prod.label_a_production Label_A_Readers" SELECT && granted "schema prod.global_production Label_A_Readers" SELECT \
  && ok "a label group reads its own schema and the shared one" || bad "a label group is missing its own grants"
granted "schema prod.label_b_production Label_A_Readers" SELECT \
  && bad "a label group was granted another label's schema" || ok "no label group is granted another label's schema"
granted "schema prod.label_a_production Central_Readers" SELECT && granted "schema prod.label_b_production Central_Readers" SELECT \
  && ok "the central group reads every label" || bad "the central group is missing a label"
grep -q "(label_value = 'A' AND is_account_group_member('Label_A_Readers'))" "$WORK/statements" \
  && grep -q "is_account_group_member('Central_Readers')" "$WORK/statements" \
  && ok "the row filter admits each label to its own rows and central to all" \
  || bad "the row filter is wrong: $(cat "$WORK/statements")"

if OPEN_CATALOG=1 run_tool --verify; then
  bad "verify passed although every label can read every schema"
else
  grep -q "Label_A_Readers can read another label's schema prod.label_b_production" "$WORK/output" \
    && ok "verify reports a cross-label read" || bad "verify failed for another reason: $(cat "$WORK/output")"
fi

rm -f "$WORK/filtered"
if run_tool --verify; then bad "verify passed with no row filter attached"; else
  grep -q "prod.xlabel.master has no label row filter" "$WORK/output" \
    && ok "verify reports a master table without its row filter" || bad "unexpected: $(cat "$WORK/output")"
fi

config central
reset
run_tool --apply >/dev/null
if [[ -s "$WORK/statements" ]]; then bad "a central-only master table got a row filter"; else ok "a central-only master table needs no row filter"; fi
granted "table prod.xlabel.master Label_A_Readers" SELECT \
  && bad "a label group was granted a central-only master table" || ok "a central-only master table is not granted to label groups"
printf '%s' "$(python3 -c '
import json,sys
s=json.load(open(sys.argv[1])); s["table prod.xlabel.master Label_B_Readers"]=["SELECT"]; json.dump(s,open(sys.argv[1],"w"))' "$WORK/grants.json")"
if run_tool --verify; then bad "verify passed although a label reads a central-only table"; else
  grep -q "Label_B_Readers can read prod.xlabel.master, which only central groups should read" "$WORK/output" \
    && ok "verify reports a label reading a central-only table" || bad "unexpected: $(cat "$WORK/output")"
fi

reset
run_tool --apply >/dev/null
if UNREADABLE_TABLES=1 run_tool --verify; then bad "verify passed although no label group's table privileges could be read"; else
  grep -q "Label_A_Readers on prod.xlabel.master could not be read" "$WORK/output" \
    && ! grep -q "prod.xlabel.master: no label group reads it" "$WORK/output" \
    && ok "verify fails a central-only table whose privileges cannot be read" || bad "unexpected: $(cat "$WORK/output")"
fi

bundle_fixture '["prod.label_a_production","prod.global_production"]'
config
reset
run_tool --apply >/dev/null
grep -q "outside the agent's read scope: B: prod.label_b_production" "$WORK/output" \
  && ok "verify reports a label outside the agent's read scope" || bad "scope not checked: $(cat "$WORK/output")"

printf '{"labels":[]}' > "$WORK/config.json"
reset
if run_tool; then bad "a config without a catalog was accepted"; else
  grep -q "catalog is missing" "$WORK/output" && ok "rejects a config without a catalog" || bad "unexpected: $(cat "$WORK/output")"
fi

if python3 "$HERE/label_access_module_test.py" > "$WORK/module" 2>&1; then
  ok "the Genie Code skill's module applies and verifies the same plan"
else
  bad "the Genie Code skill's module tests failed: $(tail -20 "$WORK/module")"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
