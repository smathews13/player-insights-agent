# AI Gateway

Two separate gateways sit in front of the agent's model traffic. Both are on by
default, and an administrator can turn the first one off.

| What | Where it applies | Default | Who changes it |
|---|---|---|---|
| Unity Catalog AI Gateway route | The agent's own model calls (planning, tool choice, charts, the final answer) | On | An administrator, in **Settings → Experimental → AI Gateway** |
| Agent endpoint policy | Every question sent to the agent serving endpoint | No request log; usage tracking on, 60 questions a minute per person and 2,000 a minute in total where the workspace supports them | The release, through `bundle/ai_gateway_policy.py` |

## The model route

With the switch on, the agent sends its model calls to the Unity Catalog AI
Gateway model service named in the deployment (`llm_gateway_endpoint`, with
`llm_gateway` set to `mlflow` or `openai`). The model service's own policies
then apply: guardrails, its rate limits and its usage logging. Calls run as the
person asking, so the model service's `EXECUTE` grant decides who may use it.

With the switch off, the same calls go straight to the foundation-model
endpoint in `llm_direct_endpoint`.

### Turning it off

Open **Settings → Experimental**, clear **AI Gateway**, and save. New questions
take the direct route at once; no redeploy is needed. The choice is stored in
Lakebase and is the same for everyone. Turn it back on the same way.

Saving the setting before this default existed stored an implicit "off". The
app ignores that old value, so a deployment that never chose "off" reads as on.
Only an explicit "off" saved from this version keeps the route direct.

### A deployment with no model service

The switch being on does not make the model service mandatory. If the
deployment names no model service, the agent answers through the direct route
and records `player_insights.llm_route=direct` on the trace. An administrator
does not need to turn the switch off first.

Once a model service is configured, the gateway's decisions are final. A
refusal, a rate limit, an authentication failure or an outage on the gateway
route is reported as such; the agent never retries the question on the direct
route, because that would step around the policy.

### Guardrails

PII and safety guardrails apply to foundation-model and external-model routes.
They are therefore set on the Unity Catalog AI Gateway model service, not on
the agent endpoint, which serves a custom model. Configure them there and test
them with a synthetic prompt (see Verification).

## The agent endpoint policy

`app-release.sh` applies this on every release, after the experiment ACL:

- **Usage tracking** on, so calls per person show in the serving system tables.
- **A per-person limit** of 60 questions a minute. Above it, the person sees
  "You have asked more questions in the last minute than this deployment
  allows. Wait a minute, then ask again." It is not shown as an outage and is
  not retried.
- **An endpoint limit** of 2,000 questions a minute, which caps the cost of a
  runaway client.

Change the numbers with `--user-calls` and `--endpoint-calls`. A failure to
apply is a release warning, not a stop; the previous policy stays in place.

Some workspaces do not support usage tracking or rate limits on a custom-model
endpoint, and refuse them with "... is not currently supported for this
endpoint type in this workspace". The script then applies the rest, so the
request log still goes off, and names what was refused. Set the per-person limit
and usage logging on the AI Gateway model service instead, and record the
endpoint gap as accepted until the workspace supports it.

```bash
# Show the difference; changes nothing.
python3 bundle/ai_gateway_policy.py --endpoint <agent-endpoint> --profile <profile>
# Apply it.
python3 bundle/ai_gateway_policy.py --endpoint <agent-endpoint> --profile <profile> --apply
```

`bundle/security_posture.py` fails a deployment whose endpoint has no usage
tracking or no per-person limit.

### No request log on the endpoint

Questions and answers are stored in Lakebase by the app, where the retention,
deletion and erasure rules in `lakebase-isolation.md` apply to them. The
endpoint's own inference table would be a second copy in a Lakehouse table
that those rules do not reach, so the policy turns it off. A table an earlier
version wrote is left in place; drop it once nothing needs it.

`bundle/security_posture.py` and `bundle/drift-check.py` both fail an endpoint
that still writes a request log.

## Verification

With a synthetic prompt and the normal app:

1. With the switch on, ask a question and confirm the trace route is
   `ai_gateway` (or `direct` on a deployment with no model service).
2. Turn the switch off, ask again, and confirm the route is `direct`.
3. With the switch on, send a prompt the model service's guardrail refuses and
   confirm the answer is a refusal with no direct-route attempt.
4. Run `bundle/security_posture.py` and confirm the gateway checks pass.
