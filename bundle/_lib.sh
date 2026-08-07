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
_BUNDLE_JSON=""
load_bundle_json() {
  require_target
  [[ -n "$_BUNDLE_JSON" ]] && return 0
  local args=(bundle validate -t "$TARGET" -o json)
  [[ -n "$PROFILE" ]] && args+=(--profile "$PROFILE")
  _BUNDLE_JSON="$(cd "$BUNDLE_ROOT" && databricks "${args[@]}" 2>/dev/null)" \
    || die "bundle validate failed for target '$TARGET'.
Run it yourself to see why:
  (cd $BUNDLE_ROOT && databricks bundle validate -t $TARGET${PROFILE:+ --profile \"$PROFILE\"})
A target that carries no host of its own also needs PROFILE set."
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
