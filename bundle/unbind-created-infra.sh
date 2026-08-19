#!/usr/bin/env bash
# Release the Lakebase instance and the two Genie spaces from bundle state,
# WITHOUT deleting them. Run this ONCE, before the next deploy of a target that
# was deployed while the bundle still created those five resources.
#
# WHY THIS EXISTS. The bundle used to declare the Lakebase project, branch and
# database, and both Genie spaces, as its own resources, so deploying it created
# them and its state claimed them. It now ATTACHES to resources that already
# exist and declares none of them. State still remembers all five. A resource in
# state and absent from configuration is a resource the CLI plans to DELETE:
#
#     $ databricks bundle plan -t example --profile "<your profile>"
#     delete genie_spaces.data_genie_space
#     delete genie_spaces.dictionary_genie_space
#     delete postgres_branches.player_insights_branch
#     delete postgres_databases.player_insights_database
#     delete postgres_projects.player_insights_lakebase
#     Plan: 0 to add, 4 to change, 5 to delete, 6 unchanged
#
# That branch holds the app's live state: every conversation, attachment,
# benchmark suite and run. Those Genie spaces are what the agent asks. The delete
# is not recoverable by redeploying, so this has to be dealt with BEFORE the next
# deploy rather than discovered during one.
#
# `unbind` is the operation that deals with it. It edits the bundle's state and
# makes no API call against the object; the CLI's own help: "the workspace
# resource continues to exist and function normally". After unbinding, all five
# drop out of the plan entirely -- not deleted, just no longer the bundle's.
#
# DO NOT reach for PIA_PLAN_ALLOW_DESTROY to get a deploy through. That gate is
# working correctly here: it is refusing to delete the live demo. Acknowledging
# those five names by hand is how you lose the database.
#
# WHY A WORKTREE. `unbind` resolves its KEY argument against the bundle
# CONFIGURATION, not against state. Once the resources are gone from the YAML the
# keys no longer resolve:
#
#     $ databricks bundle deployment unbind player_insights_lakebase -t example ...
#     Error: no such resource: player_insights_lakebase
#
# So the unbind has to run from a checkout that still declares them. Restoring
# just the three resource files is not enough: the variables they referenced
# (lakebase_owner_role_id, data_genie_tables, genie_parent_path and the
# autoscaling limits) were removed from databricks.yml in the same commit, so a
# partial restore fails to resolve. A worktree at the commit before the removal
# is internally consistent by construction, which is the whole reason to use one.
#
# Bundle state lives in the WORKSPACE, keyed by bundle name and target, so an
# unbind run from a worktree updates the same state the main checkout reads.
#
# Usage:
#   bundle/unbind-created-infra.sh              # print the plan, change nothing
#   bundle/unbind-created-infra.sh --verify     # read-only: prove the worktree resolves
#   bundle/unbind-created-infra.sh --apply      # unbind all five
#
# The pre-removal commit needs lakebase_owner_role_id, which this correction
# deleted from the overrides. Supply it for the duration:
#   BUNDLE_VAR_lakebase_owner_role_id=placeholder bundle/unbind-created-infra.sh --verify
#
# ANY value works, and a placeholder is the better choice. The variable only has
# to exist for the old configuration to parse; `unbind` resolves a resource KEY
# against that configuration and makes no API call carrying the value, so what it
# names is never read. Hunting for the real role id invites the opposite mistake:
# a run that looks like it is re-creating an owner role.
#
# Exit status: 0 ok, 1 a finding, 2 could not run (which is NOT success).

set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

TARGET="${TARGET:-example}"
PROFILE="${PROFILE:-<your profile>}"
MODE="${1:---print}"

# Short resource keys, which is what unbind takes (`bundle/adopt-example.sh` binds
# by the same names). Containers last: if the run stops partway, what is still
# bound is still internally consistent.
KEYS=(
  data_genie_space
  dictionary_genie_space
  player_insights_database
  player_insights_branch
  player_insights_lakebase
)

# The marker file whose deletion identifies the correction. Looked up rather than
# hardcoded as a hash so this keeps working after a rebase.
MARKER=resources/player_insights_lakebase.postgres.yml

find_restore_commit() {
  local deleted_in
  deleted_in="$(git -C "$BUNDLE_ROOT" log --diff-filter=D -1 --format=%H -- "$MARKER" || true)"
  if [[ -z "$deleted_in" ]]; then
    die "could not find the commit that removed $MARKER, so there is no known-good
     tree to unbind from. If the correction is not committed yet, commit it
     first: this script reads history, not the working tree."
  fi
  git -C "$BUNDLE_ROOT" rev-parse "${deleted_in}^"
}

WORKTREE=""
# Always remove the worktree, on every exit path including failure. A
# left-behind checkout that still declares the five resources is the dangerous
# artefact here: a stray deploy from it would re-adopt them and undo this.
# Registered through on_exit rather than as a bare `trap`, because _lib.sh owns
# the EXIT trap and a second one would replace its cache cleanup.
cleanup_worktree() {
  if [[ -n "$WORKTREE" && -d "$WORKTREE" ]]; then
    git -C "$BUNDLE_ROOT" worktree remove --force "$WORKTREE" 2>/dev/null || true
  fi
}
on_exit cleanup_worktree

make_worktree() {
  local commit="$1"
  WORKTREE="$(mktemp -d -t pia-unbind)"
  rmdir "$WORKTREE"
  git -C "$BUNDLE_ROOT" worktree add --detach "$WORKTREE" "$commit" >/dev/null
  # Overrides are git-ignored, so the worktree has none and every required
  # variable would be unset. Copy the target's overrides across.
  local from="$BUNDLE_ROOT/.databricks/bundle/$TARGET/variable-overrides.json"
  if [[ -f "$from" ]]; then
    mkdir -p "$WORKTREE/.databricks/bundle/$TARGET"
    cp "$from" "$WORKTREE/.databricks/bundle/$TARGET/variable-overrides.json"
  fi
}

resolves() {
  (cd "$WORKTREE" && databricks bundle validate -t "$TARGET" --profile "$PROFILE" >/dev/null 2>&1)
}

case "$MODE" in
--print)
  step "Unbind plan for target '$TARGET' (profile: '$PROFILE'): nothing will change"
  note "Five resources are in state and no longer in configuration, so a deploy"
  note "would DELETE them. These unbinds drop them from state instead."
  echo
  for key in "${KEYS[@]}"; do
    printf '  databricks bundle deployment unbind %-24s -t %s --profile %q\n' \
      "$key" "$TARGET" "$PROFILE"
  done
  cat <<'EOF'

Run them from a worktree at the commit before the removal; --apply does that for
you. Nothing was changed.

  bundle/unbind-created-infra.sh --verify   prove that worktree resolves (read-only)
  bundle/unbind-created-infra.sh --apply    unbind all five

Afterwards, `databricks bundle plan` must report 0 to delete. Until it does, do
not deploy this target.
EOF
  ;;

--verify)
  step "Read-only check: can the unbinds resolve, and is state still what we think?"
  require_cmd databricks
  commit="$(find_restore_commit)"
  note "restoring configuration from $commit (parent of the removal commit)"
  make_worktree "$commit"

  if ! resolves; then
    (cd "$WORKTREE" && databricks bundle validate -t "$TARGET" --profile "$PROFILE" 2>&1 | tail -20) || true
    die "the worktree at $commit does not resolve, so an unbind from it would fail
     before touching state. If it is asking for lakebase_owner_role_id, that
     value was removed from the overrides by this correction and the older
     commit still requires it. Any value will do -- unbind never sends it
     anywhere, it just has to parse:
       BUNDLE_VAR_lakebase_owner_role_id=placeholder $0 --verify"
  fi
  note "ok    the worktree resolves, so all five keys are declared there"

  step "What that worktree plans (expected: no deletes, because it still owns them)"
  (cd "$WORKTREE" && databricks bundle plan -t "$TARGET" --profile "$PROFILE" 2>&1 | tail -20)
  note ""
  note "A 'delete' line above means state has already moved. Stop and read it."
  note "A 'create' line for one of the five means it is ALREADY unbound: binding"
  note "it back is not what you want; re-read the plan in the main checkout."
  note ""
  note "Nothing was changed. --apply performs the unbinds."
  ;;

--apply)
  step "Unbinding five resources from target '$TARGET'"
  require_cmd databricks
  commit="$(find_restore_commit)"
  make_worktree "$commit"
  resolves || die "the worktree at $commit does not resolve; run --verify and read why."

  note "unbind takes the deployment lock. Make sure nobody is mid-deploy."
  for key in "${KEYS[@]}"; do
    step "unbind $key"
    (cd "$WORKTREE" && databricks bundle deployment unbind "$key" \
        -t "$TARGET" --profile "$PROFILE")
  done

  step "Verifying against the corrected configuration"
  (cd "$BUNDLE_ROOT" && databricks bundle plan -t "$TARGET" --profile "$PROFILE" 2>&1 | tail -20)
  note ""
  note "Expect '0 to delete' and no postgres_* or genie_spaces line at all."
  note "The five objects still exist and still serve traffic; the bundle has"
  note "simply stopped claiming them. To reverse this, bundle/adopt-example.sh"
  note "documents the bind that puts a resource back."
  ;;

*)
  die "unknown mode '$MODE' (expected --print, --verify or --apply)"
  ;;
esac
