# Upgrading an existing installation (November 2026 security release)

A one-time upgrade for an installation that is already running. Take the new
app code with **Deploy from Git** as usual, then run one notebook in your
workspace. No bundle deploy, and nothing to install on a laptop.

## What arrives with Deploy from Git

- The Lakebase upgrade runs on its own when the app starts. It records persona
  assignments and copies over the ones already in place. It cannot be undone.
- A banner while a persona is active, and the persona's name on its answers.
- The Identity screen lists groups, people and service principals separately.
- Conversation delete, user data erasure and an optional retention window
  (off unless you set `PLAYER_INSIGHTS_CONVERSATION_RETENTION_DAYS`).
- The AI Gateway route is on by default. An Admin can turn it off in
  Settings → Experimental. The app keeps working with your current model.
- Group-based admin roles come only from each person's own directory record.

## Run the upgrade notebook

1. In your workspace, choose **Workspace → Import**, then **URL**, and enter:

   ```
   https://raw.githubusercontent.com/<your-username>/player-insights-agent/main/upgrade/Player_Insights_Agent_Upgrade_2026_11.py
   ```

   Or download that file and import it.

2. Attach it to serverless compute.
3. Fill in the widgets: the app name, your Player Insights Agent engineer, executive and admin
   groups, and the IDs of the app's Genie spaces (from each space's URL).
4. **Run all** with **Apply changes** set to `no`. It finds the app's SQL
   warehouse, serving endpoint and MLflow experiment itself and shows what it
   would change.
5. Set **Apply changes** to `yes` and **Run all** again. It ends with
   "Upgrade complete".

Run it as someone with `CAN_MANAGE` on the app, the SQL warehouse, the Genie
spaces, the MLflow experiment and the serving endpoint, typically a workspace
admin. Every step is safe to repeat.

## What the notebook changes

- The app's own service principal gets `CAN_MANAGE` on the app, so the Identity
  screen can read the live member list.
- Your app groups get `CAN_USE` on the app and the SQL warehouse, and `CAN_RUN`
  on the Genie spaces. Existing grants are kept.
- The MLflow experiment is limited to the app, the endpoint's owner and the
  admin group, and the workspace-wide `users` grant is removed. Traces hold
  each person's questions.
- The serving endpoint stops writing its request log; questions and answers
  stay in Lakebase. Usage tracking and rate limits are added where the
  workspace supports them on this endpoint type. If the endpoint also uses the
  older inference table setting, the notebook says so; turn that off on the
  endpoint's page, because changing it redeploys the endpoint.

It finishes with a read-only report of who can reach each object. Review any
line marked `CHECK` with your admins.

## The model, at your next model release

The agent-side protections (trace redaction, prompt-injection protection,
signing-key rotation and protected columns) arrive with your next model release
(`bundle/agent-release.sh --apply`). Before it, set these in
`.databricks/bundle/<target>/variable-overrides.json`:

- `cross_label_key_columns`: the column that links one player across labels.
  The agent refuses any query that joins on it or returns it. This repository
  uses a neutral name, so without this setting your real key column is not
  covered.
- `identity_columns` (optional): any other columns that identify a person. The
  agent may count them but never returns their values.
