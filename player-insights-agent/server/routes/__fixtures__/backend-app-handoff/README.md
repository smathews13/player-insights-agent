# Backend → app handoff contract

MIT-14733. Pinned to backend `07f6ad75` (endpoint `astrolabe` v31, 100% of traffic) and the app mirror `3bb6d87f`. Written 2026-09-22.

Files in this folder:

1. [template.json](template.json): every key, its type, and how the app validates it.
2. [example-request-plan.json](example-request-plan.json) and [example-request-execute.json](example-request-execute.json): the real request bodies.
3. [example-plan-response.json](example-plan-response.json) and [example-answer-response.json](example-answer-response.json): the real streamed responses.
4. [failure-points.md](failure-points.md): 18 places the handoff breaks, numbered to match the diagram below.

The examples come from one conversation, `conv-8b7b0c70`. Its two MLflow traces are in experiment `1321085950225033`:

- `tr-985bc824ddfccc91acd2beeb011b753b`: the plan turn
- `tr-3ec6d1c0bd80fc70c384701d26eca547`: the execute turn

## What the backend hands off

1. **Transport.** The app sends one HTTP POST per turn and gets back a **stream of JSON events (SSE)**. It is not one JSON document.
2. **Envelope.** Every event is JSON. The last one carries the payload in `custom_outputs = {type, <payload>}`.
3. **Markdown inside JSON.** `takeaway`, `narrative`, `content`, plan `summary` and report `body` are Markdown strings. There is also a plain-text copy: `item.content[0].text` holds takeaway + narrative + content joined.
4. **Seven payload types**: `answer`, `plan`, `clarification`, `report`, `dashboard`, `unavailable`, `preflight_retired`. Every one comes back as HTTP 200.
   - The app read five shapes until today: plan, clarification, report, answer, and live text.
   - `dashboard` is the sixth. It was added to the backend in `6185d23f` and to the app in `3bb6d87f`, both on 2026-09-22.
5. **Key counts**:

   | Object | Keys | Backend model | App validator |
   |---|---|---|---|
   | answer | 13 | `AnswerContract` | `LiveAnswerSchema`, loose |
   | answer.trace | 9 | `TraceSummary` | `TraceSchema`, loose |
   | trace.stages[] | 11 | `TraceStage` | `StageSchema`, loose |
   | plan | 8 | `AnalysisPlan` | `AnalysisPlanSchema`, loose |
   | clarification | 5 | `Clarification` | `ClarificationSchema`, loose |
   | report | 10 | `Report` | hand-written normalizer |
   | dashboard | 6 | `Dashboard` | hand-written normalizer |

   The backend models are in `agent/contracts.py`. "Loose" means the app keeps keys it does not know about and logs them.

6. **No version on the core three.**
   - `answer`, `plan` and `clarification` have no `schema_version`.
   - `report` (`pia.report/1`) and `dashboard` (`pia.dashboard/1`) do.
7. **Size, from the real execute turn:** 85 events and 81 KB in total, 35 KB of it in the final answer event. The turn took 88.0s.

## What the real answer looked like on the wire

This is `tr-3ec6d1c0`, the final event, shortened. The full version is in [example-answer-response.json](example-answer-response.json).

**The examples are sanitized.** Every key, list length, type, id, timing and token count is real. Every string that carried query content (question, table and column names, figures, SQL, caveats, stage input/output) has been replaced with fictional values. The plan id `plan-b89925d339d0f590` is kept from the real trace, so it will not match what the backend would recompute from the fictional plan.

```json
{
  "type": "response.output_item.done",
  "item": { "type": "message", "id": "response-993b…", "role": "assistant",
            "content": [{ "type": "output_text", "text": "**120 players** sit in all three groups…" }] },
  "custom_outputs": {
    "type": "answer",
    "answer": {
      "id": "msg-…", "takeaway": "**120 players** sit in…", "narrative": "", "content": "",
      "figures": [4 items], "charts": [], "chart_evidence": [2], "sources": [4],
      "document_snippets": [], "caveats": [5], "derivation": [2], "sql": "WITH members AS (…",
      "trace": { "id": "tr-…", "totalMs": 87981, "toolCalls": 19, "stages": [21],
                 "genie_spaces": [], "resource_calls": [],
                 "prompt_tokens": …, "completion_tokens": …, "total_tokens": 106381 }
    }
  }
}
```

`narrative` and `content` are empty because the app sent `answer.narrative: false`. That setting also blanks `content`, so the 7-row table that synthesis wrote never left the backend. See failure point #3.

## Wiring

```mermaid
flowchart TB
  subgraph APP["App (Databricks team) — mirror 3bb6d87f"]
    B["Browser<br/>client/src/ask-stream.ts"]
    S["App server<br/>POST /api/insights/ask<br/>insights-routes.ts:4796"]
    P["SSE parser<br/>serving-stream.ts:267"]
    Z["Shape extractors + zod<br/>insights-routes.ts:5358-5639"]
    N["Client normalize<br/>answer-shape.ts:490"]
    R["AnswerCard / ReportCard /<br/>DashboardCard"]
  end
  subgraph DBX["Databricks Model Serving"]
    E["Endpoint astrolabe v31<br/>hard limit 597s"]
  end
  subgraph BE["Backend (this repo) — 07f6ad75"]
    A["ResponsesAgent.predict_stream<br/>agent.py:8617"]
    O["Orchestrator: plan / loop / synthesis"]
    F["Data Source Finder"]
    T["UC metadata, SQL warehouse, Genie"]
    M[("MLflow trace<br/>root-span events = wire copy")]
  end
  B -- "SSE request" --> S
  S -- "POST /serving-endpoints/astrolabe/invocations<br/>{input, custom_inputs, stream:true}" --> E
  E --> A --> O --> F --> T
  A -. "each yielded event" .-> M
  A -- "SSE: stage events, then one final event" --> E --> P
  P -- "stages forwarded live" --> B
  P -- "assembled {output, custom_outputs}" --> Z
  Z -- "event: result {type, …}" --> N --> R
```

## One conversation, two turns (real timings)

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant App as App server
  participant EP as astrolabe v31
  participant Orc as Orchestrator
  participant DSF as Data Source Finder
  U->>App: question
  App->>EP: execute_plan:false (tr-985bc824)
  EP->>Orc: plan: 3 describe_table calls
  Orc-->>App: 1 event: custom_outputs.type = plan (12.1s)
  App-->>U: plan card: "Review and approve this plan"
  Note over U: about 64s to approve
  U->>App: approve
  App->>EP: approved_plan_id + approved_plan + execute_plan:true (tr-3ec6d1c0)
  EP->>Orc: loop
  Orc->>DSF: one request (0.3s → 73.8s)
  DSF->>DSF: 8 steps: describe, resolve, search, list tables
  DSF->>DSF: run_sql 18.4s, run_sql 11.6s
  Orc-->>App: 42 stage events + 42 flush events, streamed live
  Orc->>Orc: synthesis (73.8s → 88.0s)
  Orc-->>App: final event: custom_outputs.type = answer (35 KB)
  App-->>U: answer card
```

## Where it breaks

The numbers match [failure-points.md](failure-points.md). A red node means silent: the user gets something that looks like an answer.

```mermaid
flowchart LR
  A["Backend assembly"] --> E["Model Serving"] --> P["SSE parser"] --> Z["zod / shape order"] --> N["Client normalize"] --> R["Render"]
  A --- f2(("2")) & f3(("3")) & f6(("6")) & f12(("12"))
  E --- f9(("9")) & f13(("13"))
  P --- f10(("10")) & f11(("11")) & f14(("14"))
  Z --- f1(("1")) & f4(("4")) & f7(("7")) & f8(("8")) & f17(("17")) & f18(("18"))
  N --- f5(("5"))
  A -.- f15(("15 MLflow"))
  Z -.- f16(("16 no version"))
  classDef silent fill:#c0392b,color:#fff,stroke:#c0392b
  classDef loud fill:#e67e22,color:#fff,stroke:#e67e22
  classDef blind fill:#7f8c8d,color:#fff,stroke:#7f8c8d
  class f1,f2,f3,f4,f5,f6 silent
  class f7,f8,f9,f10,f11,f12,f13,f14 loud
  class f15,f16,f17,f18 blind
```

Colors:

- **Red**: silent.
- **Orange**: loud (an error), or slow (#14).
- **Grey**: evidence is hard to find.

## The three findings that matter most

1. **The app's own validator failing is silent** (#1).
   - Any answer that fails `LiveAnswerSchema` becomes a prose card, with no log line.
   - The first thing to ask the app team for is a log line at `insights-routes.ts:2477`.
2. **One Settings toggle breaks every answer** (#2).
   - Turning off `takeaway` makes the backend send `""`.
   - The app requires at least 1 character, so every structured answer fails #1.
3. **The MLflow trace does hold the full payload, but not where you would look** (#15).
   - The root span's Outputs field has no `custom_outputs`.
   - The exact wire copy is in the root span's events, `mlflow.chunk.item.0…N`. To read it:

```bash
databricks api get "/api/2.0/mlflow/get-trace-artifact?request_id=<trace id>"
```

Then read `spans[name=predict_stream].events[*].attributes["mlflow.chunk.value"]`.

The last event is exactly what the app's SSE parser received.
