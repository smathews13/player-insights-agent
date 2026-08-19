#!/usr/bin/env bash
# Shared helpers for the imperative steps that sit either side of
# `databricks bundle deploy`. Sourced, not executed.
#
# Everything here reads its configuration OUT of the bundle rather than
# redeclaring it, so there is exactly one place an environment-specific value is
# written down: databricks.yml.
#
# That is an invariant to hold, not a description of one. Anything
# agent/config.py can resolve from the environment either has a variable in
# databricks.yml or is cleared by the script that would otherwise leak it; see
# the block around the exports in agent-release.sh. A value that lives only in
# the shell running a release drops silently out of the next run from a clean
# one.

set -euo pipefail

BUNDLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# TARGET has NO DEFAULT, deliberately. There is no safe guess: any default would
# aim every release run without it at whatever workspace that default named,
# including releases run by someone who has never heard of it. An unset TARGET
# stops the script.
TARGET="${TARGET:-}"
# PROFILE is resolved from the bundle when the target names one (see
# resolve_profile). A CLI profile name may contain a space, and the demo
# workspace's does, so every expansion of $PROFILE must stay quoted.
PROFILE="${PROFILE:-}"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not on PATH"
}

# Register all cleanup through one EXIT trap.
# Hooks run in registration order and their failures are swallowed: cleanup runs
# on the failure paths too, where a hook that exits non-zero would replace the
# real error with its own.
_CLEANUP_HOOKS=()
_run_cleanup_hooks() {
  local status=$? hook
  for hook in ${_CLEANUP_HOOKS[@]+"${_CLEANUP_HOOKS[@]}"}; do
    eval "$hook" || true
  done
  return "$status"
}
on_exit() {
  _CLEANUP_HOOKS+=("$1")
  trap _run_cleanup_hooks EXIT
}

require_target() {
  [[ -n "$TARGET" ]] && return 0
  die "TARGET is not set, and there is deliberately no default.

  TARGET=<target> PROFILE=<your-profile> $(basename "${BASH_SOURCE[1]:-<script>}")

<target> is one of the targets declared under 'targets:' in databricks.yml.
Read them from there rather than guessing, because a wrong guess aims a release
at somebody else's workspace.

A target that declares its own workspace.profile does not need PROFILE. Every
other target must state one; 'databricks auth profiles' lists what you have."
}

# Resolved bundle configuration as JSON.
#
# Loading is a separate function from reading, and callers must load first in
# their OWN shell. `die` only exits the shell it runs in, so a reader called as
# `X="$(bundle_var foo)"` would have a failed validate exit that subshell and feed
# an empty string to python, burying the real message under a JSONDecodeError
# traceback. The cache needs the same thing: an assignment made inside `$(...)` is
# discarded, so a reader that loaded for itself would re-run `bundle validate`
# every time.
#
# The cache below is the same idea one level up. `_BUNDLE_JSON` only spans one
# process, and a release is several: app-release.sh runs preflight.sh and
# certify-release.sh as children, agent-release.sh does the same, and each child
# resolved the identical target from scratch. Measured on this bundle, `bundle
# validate` costs 7.5 seconds, so one applied app release spent ~23 seconds
# answering the same question three times. The document cannot change while a
# release is in flight, so the top-level script resolves it once and the
# children read the answer.
_BUNDLE_JSON=""

# Keyed, because the answer is only reusable for the target and credentials it
# was resolved for. A script that reads another target's resolution is a release
# aimed at the wrong workspace, which is the failure this whole file exists to
# make impossible.
_bundle_cache_key() { printf '%s\t%s' "$TARGET" "$PROFILE"; }

load_bundle_json() {
  require_target
  [[ -n "$_BUNDLE_JSON" ]] && return 0

  local cache="${PIA_BUNDLE_JSON_CACHE:-}"
  if [[ -n "$cache" && -s "$cache" && -r "$cache.key" ]] \
     && [[ "$(cat "$cache.key")" == "$(_bundle_cache_key)" ]]; then
    _BUNDLE_JSON="$(cat "$cache")"
    return 0
  fi

  local args=(bundle validate -t "$TARGET" -o json)
  [[ -n "$PROFILE" ]] && args+=(--profile "$PROFILE")
  _BUNDLE_JSON="$(cd "$BUNDLE_ROOT" && databricks "${args[@]}" 2>/dev/null)" \
    || die "bundle validate failed for target '$TARGET'.
Run it yourself to see why:
  (cd $BUNDLE_ROOT && databricks bundle validate -t $TARGET${PROFILE:+ --profile \"$PROFILE\"})
A target that carries no host of its own also needs PROFILE set."
}

# Called by a top-level release script, AFTER resolve_profile, so the answer
# cached is the one its children will ask for. Anything it spawns inherits
# PIA_BUNDLE_JSON_CACHE and reads the file instead of the CLI.
#
# A TEMP FILE OWNED BY THIS RUN, deliberately, rather than a location on disk
# that persists between them. A stale resolution is worse than a slow one: it
# describes a bundle somebody has since edited, and nothing downstream can tell.
# It is removed on every exit path, and a run that finds the variable already
# set is a child and leaves the owner's file alone.
seed_bundle_cache() {
  [[ -n "${PIA_BUNDLE_JSON_CACHE:-}" ]] && return 0
  load_bundle_json
  PIA_BUNDLE_JSON_CACHE="$(mktemp "${TMPDIR:-/tmp}/pia-bundle-json.XXXXXX")"
  export PIA_BUNDLE_JSON_CACHE
  on_exit 'rm -f "$PIA_BUNDLE_JSON_CACHE" "$PIA_BUNDLE_JSON_CACHE.key"'
  printf '%s' "$_BUNDLE_JSON" > "$PIA_BUNDLE_JSON_CACHE"
  _bundle_cache_key > "$PIA_BUNDLE_JSON_CACHE.key"
}

bundle_json() {
  load_bundle_json
  printf '%s' "$_BUNDLE_JSON"
}

# The CLI profile for commands that are not bundle-aware (workspace import-dir,
# apps deploy, postgres list-roles). Read out of the bundle when the target
# declares one, so there is still exactly one place it is written down.
# Sets PROFILE as a side effect. Call it from the script's own shell, not from a
# command substitution, or the assignment is lost.
resolve_profile() {
  [[ -n "$PROFILE" ]] && return 0
  load_bundle_json
  PROFILE="$(printf '%s' "$_BUNDLE_JSON" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('workspace',{}).get('profile') or '')
")"
  [[ -n "$PROFILE" ]] || die "PROFILE is not set and target '$TARGET' does not name one.

A customer target deliberately carries no host and no profile, so nothing from
the demo workspace can be inherited. State yours:
  PROFILE=<your-profile> TARGET=$TARGET <script>
List them with:  databricks auth profiles"
}

# bundle_var <name> -> resolved value of ${var.<name>} for the active target.
bundle_var() {
  load_bundle_json
  printf '%s' "$_BUNDLE_JSON" | python3 -c "
import json,sys
name=sys.argv[1]
entry=json.load(sys.stdin).get('variables',{}).get(name,{})
# See bundle_var_or_empty: a per-target override lands in 'default'.
v=entry.get('value')
if v is None:
    v=entry.get('default')
if v in (None,''):
    sys.exit('variable '+name+' has no value for this target')
print(v)
" "$1"
}

# bundle_var_or_empty <name> -> resolved value, or "" for a variable whose value
# legitimately IS empty.
#
# Separate from bundle_var because most variables have no meaningful empty value
# and a blank one means a broken target, which is worth dying over. A denylist is
# the exception: empty is the normal case. It still dies when the variable is not
# DECLARED, so deleting it from databricks.yml cannot quietly read as "nobody set
# one". Telling those two apart is the entire point of putting it in the bundle.
bundle_var_or_empty() {
  load_bundle_json
  printf '%s' "$_BUNDLE_JSON" | python3 -c "
import json,sys
name=sys.argv[1]
variables=json.load(sys.stdin).get('variables',{})
if name not in variables:
    sys.exit('variable '+name+' is not declared in databricks.yml')
entry=variables[name]
# A per-target variables: block lands in 'default', not 'value'. Reading only
# 'value' silently returns empty for a variable a target overrode, so the target
# runs on the base default while bundle validate shows the override.
v=entry.get('value')
if v is None:
    v=entry.get('default')
print('' if v is None else v)
" "$1"
}

# bundle_var_json <name> -> resolved complex value as compact JSON.
bundle_var_json() {
  load_bundle_json
  printf '%s' "$_BUNDLE_JSON" | python3 -c "
import json,sys
name=sys.argv[1]
entry=json.load(sys.stdin).get('variables',{}).get(name,{})
v=entry.get('value')
if v is None:
    v=entry.get('default')
if v in (None,'',[]):
    sys.exit('variable '+name+' has no value for this target')
print(json.dumps(v, separators=(',',':')))
" "$1"
}

# bundle_var_csv <name> -> a complex list of strings as comma-separated text.
bundle_var_csv() {
  bundle_var_json "$1" | python3 -c '
import json,sys
value=json.load(sys.stdin)
if not isinstance(value,list) or not all(isinstance(item,str) and item.strip() for item in value):
    raise SystemExit("variable must be a non-empty list of strings")
print(",".join(item.strip() for item in value))
'
}

# bundle_data_schema_scopes -> concrete catalog.schema entries from data_catalogs.
# Whole-catalog entries are expanded against the active workspace.
bundle_data_schema_scopes() {
  local scope catalog
  while IFS= read -r scope; do
    if [[ "$scope" == *.* ]]; then
      printf '%s\n' "$scope"
      continue
    fi
    catalog="$scope"
    databricks schemas list "$catalog" --profile "$PROFILE" -o json | python3 -c '
import json,sys
catalog=sys.argv[1]
body=json.load(sys.stdin)
rows=body if isinstance(body,list) else body.get("schemas",[])
for row in rows:
    name=str(row.get("name") or "")
    if name and name != "information_schema":
        print(f"{catalog}.{name}")
' "$catalog"
  done < <(bundle_var_json data_catalogs | python3 -c '
import json,sys
value=json.load(sys.stdin)
if not isinstance(value,list) or not value:
    raise SystemExit("data_catalogs must be a non-empty list")
for item in value:
    if not isinstance(item,str) or len(item.strip().strip("`").split(".")) not in (1,2):
        raise SystemExit("each data_catalogs entry must be catalog or catalog.schema")
    print(item.strip().strip("`"))
')
}

# bundle_resource_id <group> <key> -> id of a DEPLOYED bundle resource.
# Requires a prior `databricks bundle deploy`; reads the remote deployment state.
bundle_resource_id() {
  local args=(bundle summary -t "$TARGET" -o json)
  [[ -n "$PROFILE" ]] && args+=(--profile "$PROFILE")
  (cd "$BUNDLE_ROOT" && databricks "${args[@]}" 2>/dev/null) | python3 -c "
import json,sys
group,key=sys.argv[1],sys.argv[2]
d=json.load(sys.stdin).get('resources',{}).get(group,{}).get(key,{})
i=d.get('id') or d.get('name')
if not i:
    sys.exit('resource '+group+'.'+key+' is not deployed yet')
print(i)
" "$1" "$2"
}
