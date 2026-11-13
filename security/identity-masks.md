# Runbook: player identity masks

Player identity columns (player ID, platform account ID, CDP customer ID,
email, device ID, IP address) are masked in Unity Catalog. Anyone outside one
privileged account group sees a salted SHA-256 of each value, through PIA,
Genie, a notebook, a dashboard or any other client. Counts of distinct players
and joins on the column still give the right answer; the raw value never leaves
Unity Catalog.

`bundle/identity_masks.py` does the work. It needs a data governance owner, a
SQL warehouse and a Databricks secret scope.

## Why the salt sits in a table as well as a secret

The salt is kept in a Databricks secret. A mask cannot read it there: inside a
mask, `secret()` runs as the person querying, so it fails for every reader, or
works only once they can read the salt themselves. `--apply` therefore copies
the secret, as the operator, into a one-row table in the governance schema. The
mask reads that table with its owner's rights, so readers need no grant on it.
`--verify` fails if any reader group can select it.

Keep the secret as the source of truth. To rotate, put a new value in the
secret and re-run `--apply`. Every hash changes, so any saved list of hashed
IDs stops matching; agree a rotation date with the teams that keep such lists.

## Steps

1. **Pick the privileged group.** One account-level Entra ID group of people
   who must see raw IDs (support, fraud). Keep it small; PIA does not use it.
2. **Create the secret** (once):

   ```bash
   databricks secrets create-scope <governance-secret-scope>
   databricks secrets put-secret <governance-secret-scope> identity-mask-salt \
     --string-value "$(openssl rand -hex 32)"
   ```

   Grant READ on the scope to the operators who run `--apply` only.
3. **List the identity columns:**

   ```bash
   python3 bundle/identity_masks.py --inventory \
     --schemas <catalog>.<schema>,<catalog>.<schema> --warehouse <id> \
     --out identity_columns.csv
   ```

   The list matches column names, so data governance must review it: drop
   false matches, add identity columns with unusual names. A column marked
   `maskable=False` is not a string; convert it or mask it separately.
   Do not commit the list.
4. **Write the config** from `bundle/identity-masks.example.json`. The
   governance schema must be in a catalog that readers cannot browse, and
   `reader_groups` lists every PIA and Genie group.
5. **Preview, then apply:**

   ```bash
   python3 bundle/identity_masks.py --plan  --config masks.json
   python3 bundle/identity_masks.py --apply --config masks.json --profile <profile>
   ```

6. **Verify:**

   ```bash
   python3 bundle/identity_masks.py --verify --config masks.json --profile <profile>
   ```

   Every column must read "is masked"; no reader group may read the salt or be
   able to change or drop a mask (MANAGE, MODIFY or ownership on the table).
7. **Check as people.** A reader runs `SELECT player_id FROM <table> LIMIT 5`
   and sees 64-character hashes; a member of the privileged group sees raw IDs.

## The agent's own guard

Separately from the masks, the agent refuses SQL that returns an identity
column, and redacts those columns from its traces. It knows the built-in names;
list any others in the bundle variable `identity_columns` (comma-separated
column names, in the deployment's private target or
`.databricks/bundle/<target>/variable-overrides.json`). The value is baked into
the model, so a change takes effect at the next model release
(`bundle/agent-release.sh --apply`). It only adds names; it cannot remove the
built-in ones.

## Done when

- `--verify` exits 0 for every masked table.
- A reader's `COUNT(DISTINCT player_id)` matches the privileged group's.
- New identity columns are added to the config as part of each data release.

## Proven on the test workspace

`bundle/identity-e2e.sh run` applies the masks to a test table and proves that a
reader sees hashes, that NULL stays NULL, that distinct counts and joins still
work, that hashing a guessed ID does not match (the hash is salted), and that a
reader cannot read the secret. Two things could not be shown there and must be
checked on the customer workspace: raw values for the privileged group (no
account groups there) and a private salt table (every user holds all
privileges on that catalog).
