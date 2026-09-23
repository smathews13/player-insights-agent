# Handoff failure points

Pinned to backend `07f6ad75` and app mirror `3bb6d87f`, 2026-09-22.

- `IR` = `player-insights-agent/server/routes/insights-routes.ts` (app mirror).
- `SS` = `player-insights-agent/server/lib/serving-stream.ts` (app mirror).
- `agent.py` = `agent/agent.py` (this repo).

The numbers match the markers on the failure diagram in [README.md](README.md).

## Column meanings

- **Hop**: the arrow on the wiring diagram where it breaks.
- **User sees**: what reaches the screen.
- **Logged?**: where a person could find it afterwards.

## Silent: the user gets something that looks like an answer

| # | Hop | Trigger | User sees | Logged? | Where |
|---|---|---|---|---|---|
| 1 | App server: zod | `custom_outputs.answer` fails `LiveAnswerSchema`, for any reason | A prose-only card: the joined Markdown text, with no figures, charts, sources or SQL. Labelled `live`. | **No.** `if (!parsed.success) continue;` | IR:2477, IR:5584-5624 |
| 2 | Backend → zod | `runtime_settings.answer.takeaway = false`. The backend sends `takeaway: ""`. The app requires `min(1)`. | Always #1. The structured answer can never pass. | No | agent.py:8544-8545; IR:622 |
| 3 | Backend: assembly | `runtime_settings.answer.narrative = false` blanks **both** `narrative` and `content`. Tables are written into `content`. | The answer loses its table. On `tr-3ec6d1c0`, synthesis wrote a 7-row table and the wire carried `content: ""`. | No (the synthesis span has the original) | agent.py:8502-8506, 8546-8547 |
| 4 | App server: zod | Plan fails `AnalysisPlanSchema` | The plan's text is served as a prose answer (#1). There is nothing to approve. | **No.** Failure is not logged | IR:2592-2601 |
| 5 | Client: normalize | `trace.genie_spaces` and `trace.resource_calls` arrive | Not shown. The client drops them. | No | client/src/answer-shape.ts:259 |
| 6 | Backend: budget | The run budget is used up before synthesis (`remaining < 5.0`) | HTTP 200 answer. Takeaway: "This run reached its time limit before it could write the answer up." | A caveat in the answer and in the trace | agent.py:6424-6457 |

## Loud: the user sees an error

| # | Hop | Trigger | User sees | Logged? | Where |
|---|---|---|---|---|---|
| 7 | App server: shapes | None of the shapes match and there is no text | `OUTPUT_SCHEMA_VIOLATION` | Yes, the first 1,200 chars | IR:5639-5645 |
| 8 | App server: deadline | Past `SERVING_INVOKE_TIMEOUT_MS` (660s) or the route deadline | `RUN_DEADLINE_EXCEEDED` | Yes | IR:3253, IR:5681 |
| 9 | Model Serving | The request passes Serving's hard **597s** limit. The backend clamps `maxRunSeconds` to 550 (the app allows 600), so this needs the backend to overrun its own cap by more than 47s. | An error from Serving → `DEPENDENCY_UNAVAILABLE` | Yes | runtime-settings-browser.ts:37; agent/runtime_settings.py |
| 10 | SSE stream | Over 8 MiB, or more than `STAGE_REPLAY_LIMIT*3+8` events | `STREAM_INTERRUPTED` | Yes | SS:19-20 |
| 11 | SSE stream | The socket drops after at least one stage reported | `STREAM_INTERRUPTED`; the partial stages are kept | Yes | IR:3046-3070, IR:5745 |
| 12 | Backend: identity | `identity_mode` / `expected_user` mismatch | `type: unavailable`, sent as HTTP 200 by the backend and re-issued by the app with an error status | Yes | agent.py:4580-4604; IR:5358 |
| 13 | Model Serving | The backend raises (for example "A user question is required.") | `DEPENDENCY_UNAVAILABLE`, with the provider message passed through | Yes | IR:5814 |

## Slow: the time roughly doubles

| # | Hop | Trigger | Effect | Logged? | Where |
|---|---|---|---|---|---|
| 14 | SSE stream | The stream is cut before any stage reports, then the app retries **once** without streaming. The plan turn sends **zero** stage events (`tr-985bc824`: one event in total), so every plan turn qualifies. | The whole turn runs again as one blocking call | A warning only | IR:3046-3080 |

## Blind spots: where the evidence is hard to find

| # | Where | What is missing |
|---|---|---|
| 15 | MLflow trace, root span **Outputs** | The Outputs field shows only the joined text items, 43 on `tr-3ec6d1c0`. There is **no `custom_outputs`**. The full wire payload **is** in the trace, as root-span **events** `mlflow.chunk.item.0…N`: one per SSE event, with the answer in the last one. Read the events, not the Outputs field. |
| 16 | Between the two repos | Answer, plan and clarification have **no `schema_version`**. Nothing tells either side which contract the other is on. Report (`pia.report/1`) and dashboard (`pia.dashboard/1`) do have one. |
| 17 | Deploy order | A new response type ships on one side before the other. `dashboard` shipped at backend `6185d23f` (13:13 PT) and app `3bb6d87f` (18:01 MT) on 2026-09-22. In between, a dashboard response hit #1 or #7. See MIT-14732. |
| 18 | App server logs | Unknown answer keys produce only a `console.warn` (IR:2482). Nobody is alerted when the backend moves ahead of the app. |
