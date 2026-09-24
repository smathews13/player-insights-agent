# Failure-point resolution status

The README, failure map, and JSON examples in this folder remain the byte-for-byte
sanitized handoff pinned to backend `07f6ad75` and app mirror `3bb6d87f`. This
file records how the app addresses each numbered point without rewriting that
historical evidence. Acme's latest ownership note is controlling: the
`agent/` folder in this app repository is not the backend served by `astrolabe`.

| #   | App status                                                                                                                                  | Backend status / boundary                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fixed: a declared answer that fails validation returns `OUTPUT_SCHEMA_VIOLATION`; duplicate prose cannot disguise lost structured evidence. | Backend still owns the emitted answer shape.                                                                                    |
| 2   | Fixed: an empty takeaway is valid, so figures, sources, SQL, and trace data survive.                                                        | Empty takeaway remains a valid backend presentation choice.                                                                     |
| 3   | Ready: the app renders `content` independently of narrative.                                                                                | Fixed in backend source by MIT-14735; not live until the backend owner logs and serves a new model version.                     |
| 4   | Fixed: a declared malformed or empty plan returns `OUTPUT_SCHEMA_VIOLATION`; it cannot become prose or an approval card.                    | Backend owns the plan shape.                                                                                                    |
| 5   | Fixed: `genie_spaces` and `resource_calls` survive client normalization and reload.                                                         | Backend owns whether those fields are emitted.                                                                                  |
| 6   | Guarded: a budget-capped answer remains usable and its caveat is rendered.                                                                  | Soft deadline-answer behavior remains backend-owned. Changes in this repo's `agent/` copy do not alter it.                      |
| 7   | Fixed: unknown empty shapes return `OUTPUT_SCHEMA_VIOLATION` with the observed shape and no fabricated answer.                              | None.                                                                                                                           |
| 8   | Fixed: interactive and benchmark transports use a 590-second deadline and abort cleanly with `RUN_DEADLINE_EXCEEDED`.                       | Backend work budget remains independent.                                                                                        |
| 9   | Fixed on the app: Settings cap work at 550 seconds and transport ends at 590, below Serving's roughly 597-second hard stop.                 | Backend already clamps `maxRunSeconds` to 550 per the handoff.                                                                  |
| 10  | Preserved: stream byte, event, and output-item limits remain security controls; a breach returns `STREAM_INTERRUPTED`.                      | None.                                                                                                                           |
| 11  | Fixed: a dropped stream is not automatically re-executed; completed stages remain in the run ledger.                                        | None.                                                                                                                           |
| 12  | Preserved: identity mismatch is translated into a structured unavailable response, never answer data.                                       | The fail-closed identity gate is backend-owned.                                                                                 |
| 13  | Fixed: backend exceptions become `DEPENDENCY_UNAVAILABLE` with redacted provider evidence and no substitute answer.                         | Backend still owns the exception.                                                                                               |
| 14  | Fixed: stage-less and plan streams are not retried on a blocking transport.                                                                 | None.                                                                                                                           |
| 15  | Documented: the app and runbook read the exact wire copy from root-span chunk events.                                                       | Root Outputs remain backend-owned. The instrumentation added to this repo's `agent/` copy is only a proposal, not a served fix. |
| 16  | Ready: legacy unversioned core payloads are accepted and unknown versions fail visibly.                                                     | Agreed strings are `pia.answer/1`, `pia.plan/1`, and `pia.clarification/1`; backend emission begins with MIT-14749.             |
| 17  | Fixed: a declared future response type cannot fall through to its text duplicate; unknown contracts fail visibly during rolling deploys.    | App support must ship before backend emission.                                                                                  |
| 18  | Fixed: unknown answer and plan fields are preserved and emit `PIA_CONTRACT_DRIFT` with field paths but no payload values.                   | Backend owns contract changes and updates `template.json` with them.                                                            |

The offline tests consume the real sanitized request and stream examples. Rich
charts, Markdown tables, reports, and dashboards remain covered by their own
fixtures because this recorded answer intentionally contains empty `charts` and
`content`.

## Deployment boundary

Deploy from Git updates only the app. It closes the app-owned parsing,
rendering, stream, deadline, and telemetry gaps above, but never changes the
model serving behind the configured endpoint.

Backend changes belong in `T2-Marketing-Technology/dbx-player-insights-agent`.
The backend owner must log and serve a new model version for MIT-14735,
MIT-14749, or any other backend fix to become live. Changes under `agent/` in
this repository do not do that. During a rolling update, the app accepts legacy
unversioned payloads, refuses unknown versions visibly, and must ship support
for a new version before the backend starts emitting it.
