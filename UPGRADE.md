# Upgrading an existing installation (November 2026 security release)

A one-time upgrade for an installation that is already running. Take the new
app code with **Deploy from Git** as usual, then run one script. No bundle
deploy is needed.

## What arrives with Deploy from Git

- The Lakebase upgrade runs on its own when the app starts. It records persona
  assignments and copies over the ones already in place. It cannot be undone.
- A banner while a persona is active, and the persona's name on its answers.
- The Identity screen lists groups, people and service principals separately.
- Conversation delete, user data erasure and an optional retention window
  (off unless you set `PLAYER_INSIGHTS_CONVERSATION_RETENTION_DAYS`).
- The AI Gateway route is on by default. An Admin can turn it off in
  Settings → Experimental.
- Group-based admin roles come only from each person's own directory record.

The app keeps working with your current model, so you can run the script below
when convenient.

## What the script does

`bundle/upgrade-after-git-deploy.sh` runs the steps a Git deploy cannot:

1. **Releases the model**, which brings trace redaction, prompt-injection
   protection, signing-key rotation and the protected-column settings below.
2. **Applies the access settings**: the app's access for your groups, warehouse
   and Genie access for your groups, a locked-down MLflow experiment, and the
   agent endpoint policy (the endpoint's request log is turned off; questions
   and answers stay in Lakebase).
3. **Prints a read-only security report** for your admins to review.

Every step is safe to repeat.

## Before you run it

Use the same machine, target and profile you deploy with. In
`.databricks/bundle/<target>/variable-overrides.json`, set:

- `cross_label_key_columns`: the column that links one player across labels.
  The agent refuses any query that joins on it or returns it. This repository
  uses a neutral name, so without this setting your real key column is not
  covered.
- `identity_columns` (optional): any other columns that identify a person. The
  agent may count them but never returns their values.

```json
{
  "cross_label_key_columns": "<your_cross_label_key_column>",
  "identity_columns": "<optional_extra_identity_column>"
}
```

## Run it

```bash
# Preview: shows the plan and the settings, changes nothing
TARGET=<target> PROFILE=<profile> bash bundle/upgrade-after-git-deploy.sh

# Apply
TARGET=<target> PROFILE=<profile> bash bundle/upgrade-after-git-deploy.sh --apply
```

To apply the access settings now and release the model later, add
`--skip-model`, then run `bundle/agent-release.sh --apply` when ready.

## Done when

- The script ends with "Upgrade complete".
- A question in the app returns an answer.
- Your admins have reviewed the security report.
