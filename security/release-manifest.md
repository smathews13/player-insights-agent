# Runbook: the release manifest

The release manifest is the reviewed list of tables PIA may answer from. PIA's
own checks keep the agent to it, but Unity Catalog grants are what actually
limit a person. `bundle/manifest-drift.sh` proves the two agree, in both
directions, and that the Genie spaces stay inside the manifest.

## Where the manifest lives

In the deployment's private config repository, beside the label access config,
as a file shaped like `bundle/release-manifest.example.json`. Protect it with a
CODEOWNERS entry so data governance must approve every change:

```text
/pia/release-manifest.json  @<data-governance-team>
```

It is deployment data, so it does not belong in this repository.

## Check it

```bash
RELEASE_MANIFEST=<file> TARGET=<target> PROFILE=<profile> bash bundle/manifest-drift.sh
```

It fails when:

- a group can read a table in the agent's data scope that the manifest does not
  name. Either add the table after review, or revoke the grant;
- a manifest table does not exist, sits outside the agent's data scope, or no
  group can read it;
- a Genie space the release uses names a table outside the manifest.

The groups checked are the target's access groups unless the manifest lists its
own (label data groups, for example). Run it before each release and after any
grant change; the release does not run it automatically, because it needs the
manifest from the private repository.

## Keep the scope small

Point the agent's data scope (`data_catalogs`) at a schema that holds only the
curated tables and views the release answers from, and build the Genie spaces on
those. Raw tables, inference logs and working tables then sit outside the scope,
and the drift check has nothing to report. On the test workspace it reports
raw player tables, the serving inference logs and two working tables that every
reader of the demo schema can query.

## Done when

- `manifest-drift.sh` exits 0 for the release target.
- The manifest file has a CODEOWNERS rule naming data governance.
