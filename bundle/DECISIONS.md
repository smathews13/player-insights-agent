# Standing decisions a release must not contradict

Product decisions that have been made, are not up for rediscovery, and that a
release is capable of silently reversing. Each one records what was decided,
when, and why in a sentence.

**Why this file exists.** A decision that lives only in a chat transcript cannot
be checked by anything. On 2026-08-16 the instruction "remove all synthetic-data
framing" had been given three times and survived all three, because it lives in
two independent places: a caveat baked into the model, and the `synthetic_data`
bundle variable. The variable's value was printed in the release script's own
configuration readout on every single run, in these words:

> `data provenance       synthetic: every answer will disclose that its figures are invented`

Nobody compared that line against the instruction, because there was nothing to
compare it against. It was caught scrolling past during a live model re-log,
which is the most expensive moment available, and it cost a release.

The fix is not "read more carefully". It is that the decisions now live in the
repository, so the release can hold its own configuration against them.

## How this file is used

`bundle/agent-release.sh` and `bundle/app-release.sh` read the machine-checkable
decisions below and compare them against the configuration they resolved, before
anything irreversible happens. A contradicted decision **stops the release** and
names the decision and its date.

Two things follow from that, and both are deliberate:

- **There is no bypass flag.** Every other gate in these scripts has one, because
  every other gate is answering a question about the world that can legitimately
  be answered "yes, I know, proceed". This one is answering a question about what
  we decided. If a decision needs to change, change it here, deliberately, in a
  commit somebody can read. That is the entire point.
- **Only some decisions are machine-checkable.** The rest are printed beside the
  configuration so that comparing them is one glance rather than a memory test.
  Which is which is stated per decision below, and the release readout says so
  too. A decision marked _displayed_ is not enforced by anything. Do not read the
  release passing as evidence that one was honoured.

## Changing a decision

Edit this file in its own commit, with the reason in the commit message. Update
the date. If the decision was recorded somewhere else as well, change it there in
the same commit, or the two records start disagreeing and this one stops being
worth reading.

---

## The decisions

### D1. No synthetic-data or demo-data framing anywhere a reader can reach

**Decided 2026-08-16.** Nothing in a deployment can look at a warehouse and tell
whether the figures in it are invented, so an app that volunteers the claim is
guessing, and a reader who is shown a figure computed from their own production
rows and told underneath that those rows are fabricated has been told something
false about their own data.

The framing lives in more than one place, and removing one place has already been
mistaken for removing it. All of these count:

- the `synthetic_data` bundle variable, which turns on a disclosure appended to
  every answer;
- `SYNTHETIC_DATA_CAVEAT` and `synthesis_provenance_rule` in `agent/agent.py`,
  which instruct the answer writer and append the caveat;
- any "Synthetic data" badge, source-strip label, or provenance chip on a surface
  a reader reaches;
- the Genie space instructions, which reach a reader through the model's answer
  and which no re-log removes, because they live on the space rather than baking
  into the artifact. These are now HARDER to reach, not easier: the bundle
  attaches to spaces it does not create, so a deploy no longer pushes this text
  and the live space is the only copy that matters. `genie/*.reference.yml` holds
  the bodies ours carry, and editing that file changes nothing by itself. The
  wording has to be fixed on the space, in the Genie UI;
- **Unity Catalog metadata**: table and column comments, schema and volume
  comments, and table properties, written when the tables are provisioned. These were
  omitted from this list until 2026-08-16 and deferred twice on the argument that
  they were documentation nobody reads. They are not. Asked to quote its table
  documentation, Dictionary Genie returned "Validated synthetic player profiles"
  and "the synthetic 180-day window" verbatim, and the `data_dictionary` rows are
  the corpus that space answers from. The semantic layer then copies both into
  entries behind a vector index, so one comment reaches a reader by three routes.

Two corollaries, because the first attempt at this got both wrong. **Removing a
comment is not complying with this**: an empty definition is a worse dictionary,
and the dictionary is a queryable table two spaces depend on; drop the provenance
clause and keep the description. And **the claim has softer forms**: "null by
design" and "deliberately visible" assert that someone constructed the rows.

**Enforced:** the bundle variable. A target that resolves `synthetic_data` to
`true` stops the release. Written against the mechanism rather than the value, so
it keeps passing once the variable is gone.

**Displayed only:** the model-side caveat and the client-side badges. They are
code and copy rather than release configuration, and the release cannot see them.

### D2. The app never reads governed data as itself

**Decided 2026-08-10 for the demo target, 2026-08-14 for the customer target.**
Unity Catalog is the boundary, and it is only the boundary if the question runs
as the person who asked it. A shared principal standing in for every user makes
row filters, column masks and per-label grants decorative.

Recorded in `databricks.yml` under `execution_identity`.

**Enforced:** a target must declare `execution_identity: user-authorization`.

This used to have a second half: the release also had to be run with
`--user-authorization`, because that flag was what baked the policy into the
artifact. On 2026-08-16 a release was run without it, version 31 was logged
without the policy, and every question refused with `IDENTITY_REQUIRED`. The
flag's only purpose had become to be forgotten. `bundle/agent-release.sh` now
logs the policy unconditionally, so there is nothing left here to check that
could ever differ. Certification remains the real check, because it reads what
the served artifact was logged with rather than any variable.

### D3. A figure a reader cannot trace does not reach a screen

**Decided 2026-08-15**, as `pia-ui-spec.md` section 9 item 1: no surface may fill
a gap with something plausible. `allow_unattributed_figures` relaxes exactly that
for Genie results, and is the one control in this bundle that can turn it off
from configuration.

**Enforced:** a target that resolves `allow_unattributed_figures` to `true` stops
the release. No target sets it today, which is the state this keeps.

Derived from the spec rather than stated separately. If the metric layer lands and
the relaxation stops being a relaxation, this is the decision to change.

### D4. Benchmark Lab is hidden pending completion

**Decided 2026-08-18 (hide), superseding the same-day "normal tab" decision and
the 2026-08-15 experimental-toggle decision.** Benchmark Lab is unfinished and
non-functional, so it is hidden from every signed-in role, including
administrators.

The single switch is `BENCHMARK_LAB_ENABLED` in `client/src/nav-reveal.ts`. Set
it to `true` to restore the previous behaviour: a normal nav tab for everyone,
and `/benchmarks` rendering the lab. While it is `false`, `/benchmarks`
redirects to Ask. Components, server routes and tests stay in the tree.

**Displayed only.** No release configuration governs it.

### D5. The role badge sits to the left of the signed-in name

**Decided 2026-08-15.** The header's right-hand cluster reads badge, then name,
then gear. The design handoff and anchor `#7e` put it on the right.

Stated once in `client/src/role.ts` so it cannot be flipped back by accident, and
recorded in `AS-COMMITTED.md`, "What the repository overrides", item 1.

**Displayed only.**

### D6. Refused and failed are never summed, on any surface

**Decided 2026-08-15.** A refusal is the app working correctly and telling
somebody they cannot read something. A failure is the app not working. Adding them
produces a number that describes neither, and the failure taxonomy already keeps
them apart by layer.

Recorded in `docs/admin-monitoring-ops-plan.md` section 5.3, and in the copy rules
in `docs/design-handoff-pia-dubois-revamp/monitoring-ops.md`.

**Displayed only.**

### D7. Every rate names its population, and every total names its coverage

**Decided 2026-08-15.** A bare percentage over a handful of ratings reads as a
quality score for the deployment. Most answers are never rated.

Three parts, all recorded in the same two places as D6:

- rated shares carry their denominator on screen;
- token totals name what they cover;
- below 20 runs in range, a 95th percentile is not a percentile. Show the slowest
  run and label it as the slowest run.

**Displayed only.**

### D8. "Not checked" always means not checked yet, never broken

**Decided 2026-08-15.** Three states, not two. A check that has not run is not a
pass and not a failure, and rendering it as either invents a result. The app is
already careful about this and nothing downstream may undo it.

Recorded in `docs/admin-monitoring-ops-plan.md` section 7.2, in
`architecture-tab.md`, and in the `monitoring-ops.md` copy rules. The Architecture
tab's info row carries the sentence verbatim and it must survive.

**Displayed only.**

### D9. No em dashes in user-facing copy

**Decided 2026-08-15.** Short declarative sentences instead. A house style rule,
recorded in the `monitoring-ops.md` copy rules.

Applies to copy a reader reaches. A missing metric still renders as an em dash
where `pia-ui-spec.md` and `architecture-tab.md` call for one, because that is a
typographic placeholder rather than a sentence.

**Displayed only.**

### D10. A cause the app states to a user is derived from evidence, or labelled unknown

**Decided 2026-08-16.** The Connections page showed a reader HTTP 403 on twenty-odd
Unity Catalog rows and explained them in two halves. The first half was real work:
it compared the scope Databricks named in its own refusal against the scope claim
on the forwarded token, and returned `undetermined` with no remedy where it could
not tell. Then a confident sentence about _why_ the scope was absent was appended,
and a four-step remedy built on it. Nothing in the code could know that why. Three
of the four steps were already done and verified working, and the reader did them
again.

The defect is not the wrong guess. It is that a guess and a determination reached
the screen looking identical, so no reader could tell which they were being given.
So:

- a diagnosis is a value with its evidence attached, not a sentence;
- a verdict of `undetermined` carries no causal prose **and no remedy**, because a
  remedy is a claim about a cause wearing an imperative;
- a named cause cites what was read, quoting the values rather than restating the
  verdict in longer words;
- a remedy states **one** action. A second action hung off the first with a
  condition ("if it persists, try...") is a remedy for a cause nobody
  established, and it reads to the person following it as though each step ruled
  something out. What to conclude if the action does not work is real and useful,
  and belongs in the note beside it, as a consequence rather than another step.

**Enforced, but not by this release.** `shared/stated-cause.ts` holds the rule and
`server/lib/diagnosis-audit.test.ts` applies it to every registered diagnosis on
every `npm test`. That is the register to add to when you write a new one. It is
not release configuration, so this gate cannot see it and does not claim to: a
producer nobody registers is a producer nobody audits.

### D11. Keep in mind shows three caveats and folds the rest

**Decided 2026-08-16; tightened 2026-08-23.** The first sources-module
specification said the caveats render with "no truncation, no Show all N collapse,
no merging". Sam overruled that after seeing a live answer arrive with nine
bullets and calling it far too much information. The answer-card specification
then set the final fold at three: the top three stay visible and the rest remain
behind "show more".

Keep in mind is now a separate compact box after the one-line provenance sentence,
not a footer inside a tall Sources card. One bullet per caveat, the scope tag
naming the single table a caveat is about, the mono tag on every entity name
inside it, and the bold numbers remain.

Nothing is dropped by the fold. `rankCaveats` returns both halves, the component
renders both, and the control says "show more" rather than counting them. A refusal or a coverage
gap is ranked to the top and cannot be what ends up hidden. The ranking is in
`client/src/caveat-priority.ts`; the rendering is `client/src/KeepInMind.tsx`, whose
header states this override so a reader of the file does not need this one.

The specification's other ordering rule goes the same way and for the same reason:
it asks for table-scoped caveats before run-level ones, which would put a note
about one table above a governance refusal saying the answer is not the answer to
the question that was asked.

**Displayed only.**

### D12. The header's OAuth badge claims authentication, and nothing more

**Decided 2026-08-16.** Green when a sign-in reached the app and the app could read
it, **including a session whose token is short of a scope this deployment
declares**. Red only when no OAuth sign-in arrived at all. Grey when nothing could
be established. Sam ruled on this after seeing all three options, and rejected
both alternatives explicitly: a third amber state on the badge, and going back to
red on a missing scope.

The badge shipped red on a missing scope, and that was wrong twice over. A token
short of a declared scope **authenticates perfectly well** -- the reader is who
they say they are and the app knows it -- so red beside somebody's name reads as
"you are not signed in", which is a more alarming statement than the evidence
supports. And a missing declared scope has two possible causes that one token
cannot separate: the session predates the declaration, or the app was never
restarted after it and the scope is inert for everybody. Red picked the first,
silently. See D10.

**The consequence is deliberate and looks like a bug.** Sam's own Unity Catalog
afternoon now shows a **green badge above an amber warning**, and he accepted that
reading: the strip beneath the header carries the shortfall, with the server's own
sentence and the one action that helps either way. The instinct to make the badge
louder is a natural one, so read this before acting on it. Two surfaces claiming
different things about one sign-in is the defect, not the quiet badge -- D13.

`client/src/oauth-badge.ts` decides the state and its header states this, from the
report `/api/identity` carries. `client/src/oauth-badge-render.test.tsx` pins it:
"stays green on a stale session, whose shortfall is not an authentication
failure", which also asserts that the amber strip still speaks for the same
identity, and "goes red when no OAuth sign-in reached the app at all". Restoring
red on a missing scope fails those two.

One thing the badge cannot yet say: on the deployed app, a request that forwarded
no sign-in and a request carrying an opaque token that works fine arrive
identically, because `SessionReport.tokenScopes` is null for both. Both are grey.
A boolean on that report saying whether a sign-in was presented at all would let
the first go red, where it belongs.

**Displayed only.**

### D13. Two surfaces never make different claims about the same fact

**Decided 2026-08-16.** One fact, one wording, in one place, quoted by whatever
else needs it. Where two surfaces must both speak, they divide the fact rather
than each summarising it.

Twice in one day, this was what a reader actually experienced:

- the OAuth badge asserted that a sign-in had failed while the amber strip
  directly beneath it asked for a permission on that same working sign-in (D12);
- the Connections page's 403 panel gave a four-step remedy for a cause nothing had
  established, three steps of which the reader had already done and verified, so
  the app told him to redo work its own screens showed as done (D10).

Neither surface was wrong on its own terms. Both were reasonable summaries of a
fact each had reached separately, which is exactly how this happens: the way to
get two claims is to derive one thing twice.

So a diagnosis is decided once, on the server, next to its evidence, and the
prose travels with it. `shared/session-contract.ts` and `shared/stated-cause.ts`
carry those reports; `client/src/stale-session.ts` and `client/src/oauth-badge.ts`
have no sentences of their own beyond the case where the server supplied none, and
say so in their headers. A reworded copy in a component is a sentence nothing
audits.

**Displayed only,** and not fully checkable by anything: `diagnosis-audit.test.ts`
holds prose against its evidence, but nothing can see that two surfaces are
talking about the same fact. This is the decision to reach for when a fix is
"make the other surface agree" -- fix which surface owns the claim instead.

### D14. A product mark is not a reason to build the row it was drawn for

**Decided 2026-08-17.** The brand-icon placement guide names three seatings this
app has nowhere to put, and they stay empty rather than being furnished so that a
logo has somewhere to sit. An icon is an identifier for something already on
screen. Where the thing is not on screen, the placement is a request for a
feature, and it should be argued for as one.

The three, so the next reader does not have to rediscover them:

- **Settings, "Deployment and resources": 16x16 per resource row.** That card has
  no resource rows. It holds one button to Connections, because deployment
  resources are Connections' subject, and repeating them here was refused when the
  pages were split -- see the header of `SettingsPage.tsx`. The lucide plug on the
  button is an action, which is what lucide is for.
- **Benchmark Lab, "Judge column: Mosaic AI before the judge endpoint name".**
  There is no judge column. The two tables are Run/Started/Status/Duration/Rating
  and Case/Outcome/Took. The judge endpoint IS named, inside the composed
  sentence of the qualification ledger's judge row -- and that row already
  carries a tone glyph, so a mark there would put two icons on one element, which
  the guide forbids in the same breath as it asks for the mark.
- **Benchmark Lab, "Unity Catalog before table-backed dataset rows".** The suite
  has cases, not datasets, and no case names a table.

Also, deliberately: the Sources rows carry no per-row mark, though the guide's
"source-table chips anywhere a table is named with a badge" reads as if they
should. The chip on those rows names what the table was read FOR, not the table;
the one mark for the list is on the header, and the module's own reason for
saying per-row facts once is in its header comment.

**Displayed only.** Nothing can check that a surface does not exist. What this
decision is for is the review comment "the guide asked for an icon here and there
isn't one" -- the answer is that the row it belongs to was never built, and
building one to hold a logo is the mistake this records.

### D15. App and workspace sessions are separate; Astrolabe adds an app-only idle control

**Revised 2026-08-28.** Native Databricks App sessions are separate from
workspace sessions, may persist or refresh for up to 24 hours, and do not
support federated logout. Workspace logout therefore does not invalidate or
prove the absence of an App session, and Astrolabe must not claim otherwise.

Astrolabe now adds a compensating application session. A random opaque
per-browser identifier is held in a Secure, HttpOnly, SameSite cookie; Lakebase
stores only its hash, normalized authenticated subject, deployment binding, and
activity/expiry timestamps. Every protected API request checks that shared row.
Only throttled physical interaction extends activity; background polling and
ordinary reads do not.

The account menu ends the stored app session and navigates the same origin to
`/.auth/sign_out`. This is explicitly partial: if the workspace or identity
provider session remains active, Databricks can authenticate the App again
without prompting. The app cannot see or revoke those upstream sessions.

The idle limit defaults to 30 minutes and is configurable with
`PLAYER_INSIGHTS_IDLE_TIMEOUT_MINUTES`; the only off switch is the literal
`disabled`. Expiry leaves a tombstone until explicit sign-out, so reload and the
next API request cannot silently create a replacement. `APP_IDLE_TIMEOUT`
unmounts the app and clears client caches.

Strict immediate coordinated logout remains outside the native Apps contract.
It requires a customer-controlled OIDC/gateway architecture that owns every
participating session and provides federated logout. The Astrolabe timeout
protects only Astrolabe's application layer.

### D16. Access boundaries fail closed and do not widen through a release

**Decided 2026-08-28.** A release must preserve four independent boundaries:
the human comes from the Apps proxy; governed work runs under the selected
user/persona credential and never falls back to the app service principal;
application roles do not widen data-plane grants; and conversation writes,
attachments, and execution context remain owner-scoped even where an explicitly
configured evaluation target shares conversation reads.

The exact administrator prefixes, identity-optional diagnostics, app-session
exemptions, and OAuth scope classifications live in source and are reproduced
for operators in `docs/Astrolabe_Access_Guide.md`. Their consistency tests fail
when the guide and source disagree. WAF, TLS, proxy CORS, proxy security
headers, and token issuance policy are platform dependencies, not facts this
repository certifies.

**Enforced by application/security contract tests and release gates.** The
external platform-control sentence is descriptive and requires separate
deployment evidence.

---

## Decisions recorded elsewhere, not repeated here

These are settled, and they live where the thing they govern lives. Linked rather
than copied, so there is one copy to keep true.

| Decision                                                                                                                                                                 | Where it is recorded                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| The ten constraints that outrank everything else on the ask and answer surfaces                                                                                          | `docs/design-handoff-pia-dubois-revamp/pia-ui-spec.md` section 9                          |
| An empty admin list means nobody, not everybody                                                                                                                          | `README.md`, "Who can administer it", and `docs/admin-monitoring-ops-plan.md` section 2.4 |
| The Architecture stat strip has four tiles, not five                                                                                                                     | `AS-COMMITTED.md`, "What was decided after the handoff"                                   |
| Every re-read control is labelled Refresh                                                                                                                                | `AS-COMMITTED.md`, same section                                                           |
| Monitoring's filter row departs from anchor `#7a` in three ways                                                                                                          | `AS-COMMITTED.md`, same section, and `monitoring-ops.md`                                  |
| Where the repository specification and the design handoff disagree, behaviour follows the specification and appearance follows the handoff                               | `AS-COMMITTED.md`, "What the repository overrides"                                        |
| No workspace-specific value is baked into the committed build tree                                                                                                       | `README.md`, "Deploy the app from the browser"                                            |
| `serving.serving-endpoints-data-plane` is not to be declared by any target                                                                                               | `databricks.yml`, under `app_user_api_scopes`                                             |
| Hard knobs (Genie / warehouse / catalogs) become live only via Apply → new model version; Connections and notebooks stage intent; soft knobs may stay live without Apply | `bundle/apply-declaration.sh`, Connections Apply card                                     |

## What this file is not

It is not a changelog, not a backlog, and not a style guide. A decision belongs
here when reversing it would be a product regression **and** a release could do so
without anybody noticing. Everything else belongs in the specification, in the
handoff, or in a commit message.
