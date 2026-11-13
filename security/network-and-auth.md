# Network and sign-in posture

Settings outside this repository that decide who can reach the workspace and
for how long. Each item is either in place or recorded as an accepted risk with
a named owner. Record the decision for each workspace in the table at the end,
or in the deployment's own records if this repository is public.

## Checklist

### IP access lists

The workspace accepts requests only from the customer's own network ranges.

- Check: `databricks api get "/api/2.0/workspace-conf?keys=enableIpAccessLists"`
  shows `true`, and `databricks ip-access-lists list` shows one enabled
  `ALLOW` list per known range, with no `0.0.0.0/0`.
- The app is reached through the workspace, so the same lists apply to it.
- Owner: the customer's platform team, who confirm the ranges.

### Front-end Private Link

Users reach the workspace over a private connection rather than the internet.

- Needed only if the customer's policy requires it. With it, the IP access
  lists still apply to whatever public access is left.
- Check: the account console, under the workspace's **Network** settings
  (account administrator).
- Owner: the customer's platform and network teams.

### Single sign-on with conditional access and MFA

Every person signs in through the customer's identity provider, which requires
MFA and enforces its conditional-access rules on the Databricks application.

- PIA never sees a password. Each request carries the person's own forwarded
  token, and the app refuses a request without one rather than answering as
  itself (`execution_identity`).
- Check: the identity provider's policy on the Databricks enterprise
  application, and **Settings → Security → Single sign-on** in the account
  console.
- Owner: the customer's identity team.

### Customer-managed keys

Workspace storage, managed services (notebooks, queries) and Lakebase are
encrypted with keys the customer controls.

- Needed only if the customer's policy requires it.
- Check: the account console, under the workspace's **Encryption** settings
  (account administrator).
- Owner: the customer's security team.

### Token and session lifetime

- **People.** Each question runs on the token the Apps proxy forwards with that
  request. A question is capped at 550 seconds (Model Serving stops requests at
  about 600), which is well inside that token's lifetime, so there is nothing to
  refresh mid-run. If a token expires or is revoked during a run, the next call
  is refused and the question reports an identity failure. It never falls back
  to the app's own identity.
- **Benchmark runs.** A suite does not start if the person's token says it will
  expire before the suite's time budget runs out. If the workspace stops
  accepting the token mid-suite, the suite stops at that case.
- **Personal access tokens.** PIA does not use them. Set the workspace maximum
  (`maxTokenLifetimeDays`) to the customer's policy, and review
  `/api/2.0/token-management/tokens` for tokens nobody owns any more.
- **The app's service principal.** Uses OAuth machine-to-machine tokens that
  the platform issues and rotates. There is no long-lived secret for it in the
  app (`secrets-and-rotation.md`).

## Record

| Item | Status | Accepted risk, if not in place | Owner | Checked on |
|---|---|---|---|---|
| IP access lists | | | | |
| Front-end Private Link | | | | |
| SSO with conditional access and MFA | | | | |
| Customer-managed keys | | | | |
| Token lifetime | | | | |
