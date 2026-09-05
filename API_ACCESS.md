# Databricks App and Agent API Access

**Classification:** Public / reference

**Document date:** 29 August 2026

**Last verified:** 4 September 2026

This guide separates the supported Databricks access patterns that are often
grouped together as “OpenAI-compatible.” OpenAI compatibility describes a
request and response protocol. It does not require OpenAI-hosted models,
OpenAI infrastructure, or an OpenAI SDK. A plain HTTP client can use the
protocol.

## Choose a method

| Caller or workload                                           | Method                   | Target                                                                                               |
| ------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Python application or notebook                               | Databricks OpenAI Client | A deployed agent; an Apps-hosted `ResponsesAgent` uses model `apps/<app-name>`                       |
| Any HTTP-capable application                                 | OpenAI-compatible REST   | `POST /responses`, but only when an Apps-hosted `ResponsesAgent` or `AgentServer` exposes that route |
| Any HTTP-capable application calling a custom Databricks App | App-defined REST         | `GET` or `POST /api/<endpoint>` using the request and response contract defined by that app          |
| SQL pipeline, batch enrichment, or table query               | SQL `ai_query()`         | A model or agent hosted on a Model Serving endpoint in the same workspace                            |

These are three broad programmatic patterns: the Databricks client, REST, and
SQL `ai_query()`. REST has two distinct surfaces. An Apps agent's `/responses`
route follows the Responses protocol; a custom app's `/api/<endpoint>` route is
whatever its author implemented. A custom `/api` route is not automatically
OpenAI-compatible.

## Player Insights Agent today

> **Player Insights Agent does not currently publish a stable programmatic API.**

- The Player Insights Agent Databricks App is a custom application and user interface. It
  serves authenticated `/api/*` routes and adds its own Lakebase-backed,
  per-browser session controls. It is not an Apps-hosted `AgentServer` and does
  not expose a `/responses` route.
- The browser currently asks through `POST /api/insights/ask`. That route is an
  internal browser-to-app contract, not a stable public integration surface. It
  coordinates application sessions, conversation ownership, persistence,
  approvals, cancellation, streaming progress, and response projection.
- The Player Insights Agent model is an MLflow `ResponsesAgent` hosted on Model Serving. Its
  model contract accepts Responses input plus app-supplied `custom_inputs`.
  Current authorization requires a caller identity mode and expected principal,
  then verifies that principal against the identity observed by Model Serving.
  The app also supplies request, run, conversation, deadline, approval, and
  runtime context where applicable.
- Because that identity and orchestration contract is app-issued and is not
  established as a versioned public contract, direct Model Serving invocation
  is not a supported public Player Insights Agent access path today. The simple
  `ai_query('<model-serving-endpoint>', question)` pattern does not provide the
  required Player Insights Agent identity and application context and must not be used to
  bypass the app.

For a supported future integration, expose and test a versioned custom
`/api/<endpoint>` contract, or host an agent application with `AgentServer` and
its `/responses` surface.

## Authentication and access requirements

For an agent hosted on Databricks Apps:

- Use a Databricks OAuth token. Personal access tokens (PATs) are not supported.
- The caller needs **CAN USE** permission on the app.

For a custom Databricks App API:

- The app must define the requested `/api/<endpoint>` route.
- The caller needs **CAN USE** permission on the app and an OAuth Bearer token.
- Local development should use OAuth user-to-machine (U2M) authentication.
- An external application should use OAuth machine-to-machine (M2M)
  authentication with a service principal.
- App-to-app calls use the calling app's assigned service principal.
- A Databricks notebook must exchange its notebook token for an OAuth token
  whose audience is the target app.
- If the app uses user authorization, the token scopes must include every
  configured user-authorization scope, or a superset such as `all-apis`.

For `ai_query()`:

- The target is a Model Serving endpoint in the same workspace, not a
  Databricks App.
- The SQL function definer needs **CAN QUERY** on the endpoint.
- Use a supported serverless or Pro SQL warehouse, or a supported Databricks
  Runtime. `ai_query()` is not available on Classic SQL warehouses.

## Databricks OpenAI Client example

This example is specifically for an Apps-hosted `ResponsesAgent`. The
`WorkspaceClient` must be configured with OAuth authentication.

```python
from databricks.sdk import WorkspaceClient
from databricks_openai import DatabricksOpenAI

workspace = WorkspaceClient()  # Configure Databricks unified auth for OAuth.
client = DatabricksOpenAI(workspace_client=workspace)

response = client.responses.create(
    model="apps/<app-name>",
    input=[{"role": "user", "content": "Summarize the latest approved metrics."}],
)
print(response)
```

Use `stream=True` for streaming and iterate over the returned events. The
client is optional; OpenAI compatibility does not require this SDK.

## Conditional Apps `/responses` example

Use this only when the deployed Databricks App hosts a `ResponsesAgent` through
`AgentServer` (or otherwise explicitly exposes `/responses`). It does not apply
to an arbitrary custom Databricks App.

```bash
curl --request POST \
  --url "https://<app-url>/responses" \
  --header "Authorization: Bearer <oauth-token>" \
  --header "Content-Type: application/json" \
  --data '{
    "input": [{"role": "user", "content": "Summarize the latest approved metrics."}],
    "stream": true
  }'
```

## Custom Databricks App `/api` example

The route, HTTP method, request body, and response body are defined by the app.
Confirm that contract before integrating.

```bash
curl --request GET \
  --url "https://<app-url>/api/<endpoint>" \
  --header "Authorization: Bearer <oauth-token>"

curl --request POST \
  --url "https://<app-url>/api/<endpoint>" \
  --header "Authorization: Bearer <oauth-token>" \
  --header "Content-Type: application/json" \
  --data '{"question": "Summarize the latest approved metrics."}'
```

For local U2M setup, authenticate against the workspace and let the CLI mint
the OAuth token:

```bash
databricks auth login --host "https://<workspace-url>"
databricks auth token
```

For external automation, use Databricks unified authentication with an M2M
service principal instead of storing a long-lived token. For notebook calls,
perform the documented audience-scoped token exchange for `<app-name>` before
calling the app API.

## Model Serving and `ai_query()` example

`ai_query()` invokes an existing Model Serving endpoint. It is suitable for
SQL-native inference, batch enrichment, and table-oriented workloads. It is not
the access path for an Apps-hosted agent.

```sql
SELECT
  question,
  ai_query('<model-serving-endpoint>', question) AS response
FROM VALUES
  ('Summarize the latest approved metrics.'),
  ('List the main changes.')
AS requests(question);
```

The endpoint's model signature determines whether the request is a string or a
structured value and how the return type is inferred. Inspect and honor that
signature. For custom models without an inferable schema, supply `returnType`;
for row-oriented production workloads, consider `failOnError => false`.

This platform pattern is not a Player Insights Agent integration example. Player Insights Agent's
current agent refuses requests that omit its required, verified identity
context.

## Streaming, custom inputs, and trace IDs

For an Apps-hosted `ResponsesAgent`:

- Set `stream=True` in the client or `"stream": true` in the REST body.
- Pass `custom_inputs` through the client's `extra_body`, or as a top-level
  `custom_inputs` object in the REST body. These fields are agent-defined; do
  not invent them.
- Request a trace ID with the `x-mlflow-return-trace-id: true` header. A
  non-streaming response returns it in `metadata.trace_id`. A streaming
  response sends a separate Server-Sent Events payload containing `trace_id`
  near the end of the stream.

Client example:

```python
response = client.responses.create(
    model="apps/<app-name>",
    input=[{"role": "user", "content": "Summarize the latest approved metrics."}],
    stream=True,
    extra_body={"custom_inputs": {"client_type": "batch-review"}},
    extra_headers={"x-mlflow-return-trace-id": "true"},
)

for event in response:
    print(event)
```

A custom `/api/<endpoint>` has no automatic Responses streaming,
`custom_inputs`, or trace-ID contract. The app must define and document any such
behavior itself.

## Common 401, 403, and 404 causes

| Status | Common causes                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401`  | Missing, invalid, or expired OAuth token; token does not include the app's configured user-authorization scopes                                                       |
| `403`  | Caller lacks **CAN USE** on the app or **CAN QUERY** on the Model Serving endpoint; token scopes are insufficient; the app's own authorization rejected the operation |
| `404`  | Wrong app URL or workspace; app is not deployed or running; `/responses` was sent to a custom app that does not expose it; `/api/<endpoint>` is not implemented       |

Using a PAT against an Apps-hosted agent can produce a redirect rather than a
successful API response. Replace it with an OAuth token; do not follow the
redirect as an authentication workaround.

## Security practices

- Never hardcode, commit, print, or log OAuth tokens, client secrets, cookies,
  or raw authorization headers.
- Use Databricks unified authentication so SDKs refresh OAuth credentials.
- Give service principals and users only the app, endpoint, data, and scope
  permissions they need.
- Keep app-defined authorization and session checks server-side.
- Treat `custom_inputs` as untrusted input. Validate fields, lengths, and
  identity claims; do not let a request body select a more privileged actor.
- Preserve Unity Catalog permissions, row filters, and column masks behind
  every access method.
- Record correlation or trace IDs for troubleshooting, but do not record
  credentials or sensitive request content.

## Official sources

- [Query an agent deployed on Databricks](https://docs.databricks.com/aws/en/agents/custom-agents/query-agent)
  — last updated 28 July 2026.
- [Connect to an API Databricks app using token authentication](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/connect-local)
  — last updated 14 July 2026.
- [Author an agent and deploy it on Databricks Apps](https://docs.databricks.com/aws/en/agents/custom-agents/author-agent)
  — last updated 25 August 2026.
- [`ai_query` function](https://docs.databricks.com/aws/en/sql/language-manual/functions/ai_query)
  — last updated 27 August 2026.
- [Use `ai_query`](https://docs.databricks.com/aws/en/large-language-models/ai-query)
  — last updated 27 August 2026.
