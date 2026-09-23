# Failure-point resolution status

The README, failure map, and JSON examples in this folder remain the byte-for-byte
sanitized handoff pinned to backend `07f6ad75` and app mirror `3bb6d87f`. This
file records how the current source addresses each numbered point without
rewriting that historical evidence.

| # | Resolution |
|---|---|
| 1 | A declared answer that fails validation now returns `OUTPUT_SCHEMA_VIOLATION`; duplicate prose can no longer disguise the lost structured evidence. Validation paths are logged. |
| 2 | An empty takeaway is valid. Figures, sources, SQL, and trace data remain structured and renderable. |
| 3 | The narrative switch now hides prose only. `content`, including result tables, remains on the wire. |
| 4 | A declared malformed or empty plan now returns `OUTPUT_SCHEMA_VIOLATION`; it cannot become prose or an approval card. |
| 5 | `genie_spaces` and `resource_calls` survive client normalization and reload. |
| 6 | A budget-capped answer remains usable, but its incompleteness is marked as a degraded-answer warning rather than an ordinary caveat. |
| 7 | Unknown empty shapes return `OUTPUT_SCHEMA_VIOLATION` with the observed shape and no fabricated answer. |
| 8 | Interactive and benchmark transports have a 590-second deadline and abort cleanly with `RUN_DEADLINE_EXCEEDED`; the agent's supported work budget is lower. |
| 9 | The agent and Settings contract both cap work at 550 seconds. The app deadline is 590 seconds, below Model Serving's roughly 597-second hard stop. |
| 10 | Stream byte, event, and output-item limits remain security controls. Crossing one terminates with `STREAM_INTERRUPTED`, stores no partial answer, and preserves durable run evidence. |
| 11 | A dropped stream is never automatically re-executed. Completed stages remain in the run ledger and the user gets an explicit interruption. |
| 12 | Identity mismatch remains fail-closed by design and returns a structured unavailable response, never answer data. |
| 13 | Backend exceptions return `DEPENDENCY_UNAVAILABLE` with redacted provider evidence and no substitute answer. |
| 14 | Stage-less and plan streams are no longer retried on a blocking transport, removing the hidden second execution. |
| 15 | The exact final response, including `custom_outputs`, is written to a named `response.contract` span and a named `pia.final_contract` root event; the trace preview carries its type/version and chunk events remain the stream-level copy. |
| 16 | Answer, plan, and clarification now carry `pia.answer/1`, `pia.plan/1`, and `pia.clarification/1`. Legacy unversioned payloads remain readable; unknown versions fail visibly. |
| 17 | A declared future response type cannot fall through to its text duplicate. Report/dashboard versions are checked, and unknown contracts fail visibly during rolling deploys. |
| 18 | Unknown answer and plan fields are preserved and emit the stable `PIA_CONTRACT_DRIFT` event in app telemetry, with field paths but no payload values. |

The offline tests consume the real sanitized request and stream examples. Rich
charts, Markdown tables, reports, and dashboards remain covered by their own
fixtures because this recorded answer intentionally contains empty `charts` and
`content`.

## Deployment boundary

Deploy from Git updates the app and therefore closes the parsing, rendering,
stream, deadline, and telemetry gaps above. It cannot replace the model already
serving behind the configured endpoint. The endpoint owner must re-log and
promote the matching backend source to activate the independent-content fix,
550-second budget, core schema versions, grouped-source plan contract, degraded
budget marker, and named MLflow contract evidence. During that rolling update,
the app continues accepting legacy unversioned payloads and refuses unknown
future versions visibly.
