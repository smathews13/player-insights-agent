#!/usr/bin/env bash
# Grant, and prove, one data group per label in Unity Catalog.
#
#   LABEL_ACCESS_CONFIG=<file> TARGET=<target> [PROFILE=<profile>] bash bundle/label-access.sh [--apply|--verify]
#
# With no flag it prints the plan: the grants it would add and the row-filter
# SQL for each cross-label master table. Nothing is changed.
#
# --apply adds the grants (add-only; no existing privilege is revoked), creates
# each master table's row-filter function, attaches it, then runs --verify.
#
# --verify reads EFFECTIVE privileges, so a grant inherited from a catalog or
# another group counts. It fails when:
#   * a label group lacks USE CATALOG, USE SCHEMA or SELECT on its own schemas
#     or the shared schemas;
#   * a label group can read another label's schema;
#   * a master table readable by label groups has no row filter, or one only
#     central should read is readable by a label group;
#   * a label's schemas are outside the target's agent read scope
#     (var.data_catalogs), which is how a label silently drops out of answers.
#
# The config is customer data and is not committed. See
# label-access.example.json for its shape. `group_check` defaults to
# is_account_group_member, which is right for groups synced from Entra ID.
# Unity Catalog cannot grant to workspace-local groups, so a test without
# account groups names service principals and uses current_user.
source "$(dirname "$0")/_lib.sh"

MODE=plan
case "${1:-}" in
  "") ;;
  --apply) MODE=apply ;;
  --verify) MODE=verify ;;
  *) die "Unknown option '${1}'. Use --apply, --verify, or nothing for the plan." ;;
esac

require_cmd databricks
require_cmd python3
[[ -n "${LABEL_ACCESS_CONFIG:-}" ]] || die "LABEL_ACCESS_CONFIG is not set. Copy bundle/label-access.example.json, fill it in, and point at it."
[[ -f "$LABEL_ACCESS_CONFIG" ]] || die "No label access config at $LABEL_ACCESS_CONFIG."
resolve_profile
load_bundle_json
SCOPE_JSON="$(bundle_var_json data_catalogs)"
WAREHOUSE_ID="${WAREHOUSE_ID:-$(bundle_var_or_empty warehouse_id)}"

# plan_json -> one JSON document: the grants, the expectations and the SQL.
PLAN_JSON="$(SCOPE_JSON="$SCOPE_JSON" python3 - "$LABEL_ACCESS_CONFIG" <<'PY'
import json, os, re, sys

config = json.load(open(sys.argv[1]))
ident = re.compile(r"^[A-Za-z0-9_\-]+$")

def need(value, what):
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"label access config: {what} is missing")
    return value.strip()

catalog = need(config.get("catalog"), "catalog")
shared = [need(s, "shared_schemas entry") for s in config.get("shared_schemas") or []]
central = [need(g, "central_groups entry") for g in config.get("central_groups") or []]
check = config.get("group_check") or "is_account_group_member"
if check not in ("is_account_group_member", "is_member", "current_user"):
    raise SystemExit("label access config: group_check must be is_account_group_member, is_member or current_user")
labels = []
for entry in config.get("labels") or []:
    labels.append({
        "label": need(entry.get("label"), "labels[].label"),
        "group": need(entry.get("group"), "labels[].group"),
        "schemas": [need(s, "labels[].schemas entry") for s in entry.get("schemas") or []],
    })
if not labels:
    raise SystemExit("label access config: no labels")
for name in [catalog, *shared, *(s for l in labels for s in l["schemas"])]:
    if not ident.match(name):
        raise SystemExit(f"label access config: '{name}' is not a plain catalog or schema name")

def sql_string(value):
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"

masters, statements = [], []
for entry in config.get("master_tables") or []:
    table = need(entry.get("table"), "master_tables[].table")
    column = need(entry.get("label_column"), "master_tables[].label_column")
    readers = entry.get("readers") or "central"
    if readers not in ("central", "all_labels"):
        raise SystemExit("label access config: master_tables[].readers must be central or all_labels")
    parts = table.split(".")
    if len(parts) != 3 or not all(ident.match(p) for p in parts) or not ident.match(column):
        raise SystemExit(f"label access config: '{table}' must be catalog.schema.table with a plain column")
    function = entry.get("filter_function") or f"{parts[0]}.{parts[1]}.{parts[2]}_label_filter"
    masters.append({"table": table, "column": column, "readers": readers, "function": function})
    if readers == "all_labels":
        def member(principal):
            # current_user names one principal rather than a group. Only for
            # principals that cannot be grouped in Unity Catalog, as in the E2E test.
            if check == "current_user":
                return f"current_user() = {sql_string(principal)}"
            return f"{check}({sql_string(principal)})"
        terms = [member(g) for g in central]
        terms += [f"({column}_value = {sql_string(l['label'])} AND {member(l['group'])})" for l in labels]
        statements.append(
            f"CREATE OR REPLACE FUNCTION {function}({column}_value STRING)\n"
            f"RETURNS BOOLEAN\nRETURN " + "\n    OR ".join(terms or ["FALSE"])
        )
        statements.append(f"ALTER TABLE {table} SET ROW FILTER {function} ON ({column})")

grants = []  # [securable_type, full_name, principal, [privileges]]
def grant(kind, name, principal, privileges):
    grants.append([kind, name, principal, privileges])

readers_of_everything = central
for group in [*(l["group"] for l in labels), *central]:
    grant("catalog", catalog, group, ["USE_CATALOG"])
for label in labels:
    for schema in [*label["schemas"], *shared]:
        grant("schema", f"{catalog}.{schema}", label["group"], ["USE_SCHEMA", "SELECT"])
for group in central:
    for schema in [*(s for l in labels for s in l["schemas"]), *shared]:
        grant("schema", f"{catalog}.{schema}", group, ["USE_SCHEMA", "SELECT"])
for master in masters:
    m_catalog, m_schema, _ = master["table"].split(".")
    readers = [*central, *(l["group"] for l in labels)] if master["readers"] == "all_labels" else central
    for group in readers:
        grant("catalog", m_catalog, group, ["USE_CATALOG"])
        grant("schema", f"{m_catalog}.{m_schema}", group, ["USE_SCHEMA"])
        grant("table", master["table"], group, ["SELECT"])

# The agent read scope: entries are catalog or catalog.schema.
scope = [str(s).strip().lower() for s in json.loads(os.environ["SCOPE_JSON"] or "[]")]
def in_scope(schema_full):
    if config.get("check_agent_scope") is False:
        return True
    c = schema_full.split(".")[0]
    return schema_full.lower() in scope or c.lower() in scope

print(json.dumps({
    "catalog": catalog, "shared": shared, "central": central, "labels": labels,
    "masters": masters, "statements": statements,
    "grants": [g for i, g in enumerate(grants) if g not in grants[:i]],
    "out_of_scope": sorted({
        f"{l['label']}: {catalog}.{s}" for l in labels for s in l["schemas"] if not in_scope(f"{catalog}.{s}")
    } | {f"shared: {catalog}.{s}" for s in shared if not in_scope(f"{catalog}.{s}")}),
}))
PY
)" || die "The label access config could not be read."

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
plan_field() { PLAN_JSON="$PLAN_JSON" python3 -c "import json,os,sys;d=json.loads(os.environ['PLAN_JSON']);print(json.dumps(d[sys.argv[1]]))" "$1"; }

print_plan() {
  step "Grants (add-only)"
  PLAN_JSON="$PLAN_JSON" python3 -c '
import json, os
for kind, name, principal, privileges in json.loads(os.environ["PLAN_JSON"])["grants"]:
    print("  %-7s %-60s %s: %s" % (kind, name, principal, ", ".join(privileges)))'
  step "Row filters"
  PLAN_JSON="$PLAN_JSON" python3 -c '
import json, os
plan = json.loads(os.environ["PLAN_JSON"])
for master in plan["masters"]:
    if master["readers"] == "central":
        print("  %s: central groups only, no row filter needed" % master["table"])
for statement in plan["statements"]:
    print("\n" + statement + ";")'
}

run_statement() {
  [[ -n "$WAREHOUSE_ID" ]] || die "No warehouse to run the row-filter SQL on. Set WAREHOUSE_ID."
  local body result
  body="$(python3 -c 'import json,sys;print(json.dumps({"warehouse_id":sys.argv[1],"statement":sys.argv[2],"wait_timeout":"50s"}))' "$WAREHOUSE_ID" "$1")"
  result="$(databricks api post /api/2.0/sql/statements --json "$body" --profile "$PROFILE" -o json)" \
    || die "The SQL statement API refused: ${1%%$'\n'*}"
  RESULT="$result" python3 -c '
import json, os
state = json.loads(os.environ["RESULT"]).get("status", {})
if state.get("state") != "SUCCEEDED":
    raise SystemExit(state.get("error", {}).get("message") or state.get("state") or "no state")' \
    || die "SQL failed: ${1%%$'\n'*}"
}

apply_plan() {
  step "Adding grants"
  local kind name principal privileges
  while IFS=$'\t' read -r kind name principal privileges; do
    databricks grants update "$kind" "$name" --profile "$PROFILE" \
      --json "$(python3 -c 'import json,sys;print(json.dumps({"changes":[{"principal":sys.argv[1],"add":sys.argv[2].split(",")}]}))' "$principal" "$privileges")" \
      >/dev/null || die "Could not grant $privileges on $kind $name to $principal."
    note "$kind $name -> $principal: $privileges"
  done < <(PLAN_JSON="$PLAN_JSON" python3 -c '
import json, os
for kind, name, principal, privileges in json.loads(os.environ["PLAN_JSON"])["grants"]:
    print("\t".join([kind, name, principal, ",".join(privileges)]))')
  step "Row filters"
  local count i statement
  count="$(PLAN_JSON="$PLAN_JSON" python3 -c 'import json,os;print(len(json.loads(os.environ["PLAN_JSON"])["statements"]))')"
  for ((i = 0; i < count; i++)); do
    statement="$(PLAN_JSON="$PLAN_JSON" python3 -c 'import json,os,sys;print(json.loads(os.environ["PLAN_JSON"])["statements"][int(sys.argv[1])])' "$i")"
    run_statement "$statement"
    note "${statement%%$'\n'*}"
  done
}

# effective_privileges <type> <name> <principal> -> comma list, empty for none.
effective_privileges() {
  local out
  out="$(databricks grants get-effective "$1" "$2" --principal "$3" --profile "$PROFILE" -o json 2>/dev/null)" || {
    printf 'UNREADABLE'
    return 0
  }
  OUT="$out" python3 -c '
import json, os
held = set()
for assignment in json.loads(os.environ["OUT"] or "{}").get("privilege_assignments") or []:
    for privilege in assignment.get("privileges") or []:
        held.add(privilege.get("privilege", ""))
print(",".join(sorted(held)))'
}

verify_plan() {
  step "Verifying effective privileges"
  local failures=0 label group schema held own other
  has() { [[ ",$1," == *",$2,"* || ",$1," == *",ALL_PRIVILEGES,"* ]]; }
  fail() { note "FAIL $*"; failures=$((failures + 1)); }
  pass() { note "ok   $*"; }

  local catalog shared_list labels_count i
  catalog="$(PLAN_JSON="$PLAN_JSON" python3 -c 'import json,os;print(json.loads(os.environ["PLAN_JSON"])["catalog"])')"
  shared_list="$(PLAN_JSON="$PLAN_JSON" python3 -c 'import json,os;print(" ".join(json.loads(os.environ["PLAN_JSON"])["shared"]))')"
  labels_count="$(PLAN_JSON="$PLAN_JSON" python3 -c 'import json,os;print(len(json.loads(os.environ["PLAN_JSON"])["labels"]))')"
  label_field() { PLAN_JSON="$PLAN_JSON" python3 -c 'import json,os,sys;l=json.loads(os.environ["PLAN_JSON"])["labels"][int(sys.argv[1])];v=l[sys.argv[2]];print(" ".join(v) if isinstance(v,list) else v)' "$1" "$2"; }

  for ((i = 0; i < labels_count; i++)); do
    group="$(label_field "$i" group)"
    own="$(label_field "$i" schemas)"
    held="$(effective_privileges catalog "$catalog" "$group")"
    if has "$held" USE_CATALOG; then pass "$group: USE CATALOG $catalog"; else fail "$group lacks USE CATALOG on $catalog"; fi
    for schema in $own $shared_list; do
      held="$(effective_privileges schema "$catalog.$schema" "$group")"
      if has "$held" USE_SCHEMA && has "$held" SELECT; then
        pass "$group: reads $catalog.$schema"
      else
        fail "$group cannot read $catalog.$schema (holds: ${held:-nothing})"
      fi
    done
    local j
    for ((j = 0; j < labels_count; j++)); do
      [[ $j -eq $i ]] && continue
      for other in $(label_field "$j" schemas); do
        [[ " $own $shared_list " == *" $other "* ]] && continue
        held="$(effective_privileges schema "$catalog.$other" "$group")"
        if [[ "$held" == UNREADABLE ]]; then
          fail "$group on $catalog.$other could not be read"
        elif has "$held" SELECT; then
          fail "$group can read another label's schema $catalog.$other (holds: $held)"
        else
          pass "$group: no read on $catalog.$other"
        fi
      done
    done
  done

  local masters_count table readers fn filter
  masters_count="$(PLAN_JSON="$PLAN_JSON" python3 -c 'import json,os;print(len(json.loads(os.environ["PLAN_JSON"])["masters"]))')"
  for ((i = 0; i < masters_count; i++)); do
    read -r table readers fn < <(PLAN_JSON="$PLAN_JSON" python3 -c 'import json,os,sys;m=json.loads(os.environ["PLAN_JSON"])["masters"][int(sys.argv[1])];print(m["table"],m["readers"],m["function"])' "$i")
    filter="$(databricks tables get "$table" --profile "$PROFILE" -o json 2>/dev/null \
      | python3 -c 'import json,sys;print((json.load(sys.stdin).get("row_filter") or {}).get("function_name",""))' 2>/dev/null || true)"
    local k label_group before=$failures
    if [[ "$readers" == central ]]; then
      for ((k = 0; k < labels_count; k++)); do
        label_group="$(label_field "$k" group)"
        held="$(effective_privileges table "$table" "$label_group")"
        if [[ "$held" == UNREADABLE ]]; then
          fail "$label_group on $table could not be read"
        elif has "$held" SELECT; then
          fail "$label_group can read $table, which only central groups should read"
        fi
      done
      [[ $failures -eq $before ]] && pass "$table: no label group reads it"
    elif [[ "$(lower "$filter")" == "$(lower "$fn")" ]]; then
      pass "$table is filtered by $fn"
    else
      fail "$table has no label row filter (found: ${filter:-none})"
    fi
  done

  step "Agent read scope (var.data_catalogs for $TARGET)"
  local missing
  missing="$(plan_field out_of_scope | python3 -c 'import json,sys;print("\n".join(json.load(sys.stdin)))')"
  if [[ -n "$missing" ]]; then
    while IFS= read -r line; do fail "outside the agent's read scope: $line"; done <<<"$missing"
  else
    pass "every label schema and shared schema is inside the agent's read scope"
  fi

  [[ $failures -eq 0 ]] || die "$failures label access check(s) failed."
  note "All label access checks passed."
}

case "$MODE" in
  plan) print_plan ;;
  apply) print_plan; apply_plan; verify_plan ;;
  verify) verify_plan ;;
esac
