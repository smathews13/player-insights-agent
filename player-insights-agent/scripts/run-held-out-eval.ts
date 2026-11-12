/**
 * Runs the held-out evaluation set and writes the scorecard the Benchmark Lab
 * renders.
 *
 * WHY THIS IS A SCRIPT AND NOT A ROUTE. The suite takes minutes and the result
 * is published rather than live: a committed scorecard carries the date and the
 * model version it was produced against, which is what stops a number on that
 * pane being read as current. A button would produce a figure with no such
 * anchor. `POST /api/benchmarks/run` can run this suite too -- the runner
 * resolves `held-out-eval` like any other id -- and that path is the right one
 * for looking, but the scorecard on the pane comes from here.
 *
 * WHAT IS INJECTED AND WHAT IS REAL. The scoring, the case list, the judging,
 * the identity handling and the suite control flow are all the real
 * `startBenchmarkRun`, imported unmodified. Two things are supplied by this
 * script because the app supplies them in production: the transport, and the
 * store.
 *
 *   The transport is the same POST to the same serving endpoint with the same
 *   body `buildAskServingBody` produces, carrying the caller's OAuth token in
 *   `Authorization`. That is what makes this the signed-in path in the sense
 *   that matters: the agent's identity gate reads the forwarded token, resolves
 *   it to a person, and the run reads governed data under that person's grants.
 *   NOTHING HERE FALLS BACK TO A SERVICE PRINCIPAL. If the token is missing or
 *   rejected the run is refused and the refusal is the result.
 *
 *   The store is in-memory. Lakebase is where a run belongs when the app records
 *   it for a user to find later; this run's product is a committed file, and
 *   writing a benchmark row into the customer's demo database for an evaluation
 *   nobody will look up there would be litter.
 *
 * RUN IT WITH:
 *   DATABRICKS_CONFIG_PROFILE="<profile>" \
 *   PLAYER_INSIGHTS_SERVING_ENDPOINT=<agent endpoint> \
 *   npx tsx scripts/run-held-out-eval.ts
 *
 * Nothing here is deployed, restarted or re-logged by running it. It invokes an
 * endpoint that is already serving, twelve times.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_JUDGE_ENDPOINT } from '../shared/benchmark-contract';
import {
  HELD_OUT_CASES,
  HELD_OUT_FROM,
  HELD_OUT_SUITE_ID,
  LABEL_PROVENANCE,
  LABELS_UNREVIEWED_CONSEQUENCE,
  LABELS_UNREVIEWED_HEADLINE,
  labelSourceCounts,
} from '../shared/held-out-suite';
import type { Scorecard, ScorecardCase, ScorecardValue } from '../shared/scorecard-contract';
import {
  aggregateScores,
  startBenchmarkRun,
  type AgentTurn,
  type BenchmarkAnswer,
  type ScoredCase,
} from '../server/lib/benchmark-runner';

const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE ?? '';
const AGENT_ENDPOINT = process.env.PLAYER_INSIGHTS_SERVING_ENDPOINT ?? '';
const JUDGE_ENDPOINT = process.env.PLAYER_INSIGHTS_JUDGE_ENDPOINT?.trim() || DEFAULT_JUDGE_ENDPOINT;
const OUTPUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../client/src/eval-scorecard.generated.json'
);

/** One turn's ceiling. Above the app's, because nobody is waiting on this one. */
const TURN_TIMEOUT_MS = 300_000;

/** The most this script will ever ask for, however long the session has left. */
const MAX_SUITE_BUDGET_MS = 45 * 60_000;

/**
 * Held back from the credential's expiry, so the budget the runner is asked to
 * cover is one the session can actually cover.
 *
 * The runner refuses a suite whose budget outlives the credential -- correctly,
 * because a run that expires halfway leaves a scorecard over half a set. Asking
 * for a fixed hour therefore fails on a session with fifty minutes left, having
 * measured nothing. The budget is sized to the session instead, which is the
 * fact that actually constrains it.
 */
const BUDGET_SAFETY_MS = 3 * 60_000;

function suiteBudget(expiresAtMs: number | null): number {
  if (expiresAtMs === null) return MAX_SUITE_BUDGET_MS;
  const remaining = expiresAtMs - Date.now() - BUDGET_SAFETY_MS;
  if (remaining < 5 * 60_000) {
    throw new Error(
      `This session has ${Math.max(0, Math.round((expiresAtMs - Date.now()) / 60_000))} minute(s) left, which is ` +
        'not enough to run twelve cases. Refresh the credential and run it again rather than starting a suite ' +
        'that will be cut off partway.'
    );
  }
  return Math.min(MAX_SUITE_BUDGET_MS, remaining);
}

function cli(args: string[]): string {
  return execFileSync('databricks', PROFILE ? [...args, '--profile', PROFILE] : args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

interface Caller {
  host: string;
  token: string;
  email: string;
  expiresAtMs: number | null;
}

/**
 * Who is running this, proven rather than asserted.
 *
 * The email comes from `current-user me`, which resolves the SAME token that is
 * about to be forwarded -- so the address in the scorecard's provenance is the
 * account whose grants produced the numbers, not a name typed into a variable.
 */
function resolveCaller(): Caller {
  const host = cli(['auth', 'env']).match(/"DATABRICKS_HOST"\s*:\s*"([^"]+)"/)?.[1] ?? '';
  const token = JSON.parse(cli(['auth', 'token'])) as { access_token?: string; expiry?: string };
  const me = JSON.parse(cli(['current-user', 'me', '-o', 'json'])) as { userName?: string };
  if (!host || !token.access_token || !me.userName) {
    throw new Error(
      'Could not resolve a host, an OAuth token and a signed-in user from the Databricks CLI. This run needs ' +
        'all three: without a token there is no caller to execute as, and this script does not have a fallback ' +
        'that runs as anything else.'
    );
  }
  const expiry = token.expiry ? Date.parse(token.expiry) : NaN;
  return {
    host: host.replace(/\/+$/, ''),
    token: token.access_token,
    email: me.userName,
    expiresAtMs: Number.isFinite(expiry) ? expiry : null,
  };
}

async function invoke(caller: Caller, endpoint: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${caller.host}/serving-endpoints/${encodeURIComponent(endpoint)}/invocations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${caller.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The body the app sends, rebuilt rather than imported.
 *
 * `buildAskServingBody` lives in `server/routes/insights-routes.ts`, which this
 * script must not import: that module builds an AppKit application at load.
 * Rebuilt here to the same shape, and `held-out-eval.test.ts` compares the two
 * key-by-key so a change to the app's body fails this script rather than
 * silently evaluating a different contract.
 */
function askBody(
  request: { prompt: string; conversationId: string; approvedPlanId?: string; executePlan?: boolean },
  email: string
) {
  const custom_inputs: Record<string, unknown> = { conversation_id: request.conversationId };
  if (request.approvedPlanId) custom_inputs.approved_plan_id = request.approvedPlanId;
  if (request.executePlan !== undefined) custom_inputs.execute_plan = request.executePlan;
  custom_inputs.identity_mode = 'signed_in_user';
  custom_inputs.expected_user = email;
  return { input: [{ role: 'user', content: request.prompt }], custom_inputs };
}

function readTurn(raw: unknown): AgentTurn {
  const outputs = (raw as { custom_outputs?: Record<string, unknown> })?.custom_outputs ?? {};
  const kind = String(outputs.type ?? '');
  if (kind === 'answer') return { type: 'answer', answer: outputs.answer as BenchmarkAnswer };
  if (kind === 'plan') return { type: 'plan', planId: String((outputs.plan as { id?: unknown })?.id ?? '') };
  if (kind === 'clarification') {
    const clarification = (outputs.clarification ?? {}) as { question?: unknown; trace_id?: unknown };
    return { type: 'clarification', question: String(clarification.question ?? ''), traceId: null };
  }
  if (kind === 'unavailable') {
    return {
      type: 'refused',
      code: String(outputs.code ?? 'UNAVAILABLE') as AgentTurn extends { code: infer C } ? C : never,
      message: String(outputs.message ?? ''),
      detail: String(outputs.code ?? ''),
    } as AgentTurn;
  }
  return { type: 'unrecognized', detail: `The endpoint returned custom_outputs.type="${kind}".` };
}

async function main(): Promise<void> {
  if (!AGENT_ENDPOINT)
    throw new Error('PLAYER_INSIGHTS_SERVING_ENDPOINT is not set, so there is no endpoint to evaluate.');
  const caller = resolveCaller();
  console.log(`[eval] Running ${HELD_OUT_CASES.length} held-out case(s) against ${AGENT_ENDPOINT} as ${caller.email}.`);

  const stored: Record<string, unknown>[] = [];
  const store = {
    async query(text: string, params: unknown[] = []) {
      // Only the run insert and update carry results worth keeping; the stale
      // sweep and the suite lookup have nothing to return to an in-memory store.
      if (text.includes('INSERT') || text.includes('UPDATE')) stored.push({ metrics: params[params.length - 1] });
      return { rows: [] as Record<string, unknown>[] };
    },
  };

  const started = await startBenchmarkRun({
    store,
    requestedSuiteId: HELD_OUT_SUITE_ID,
    identity: {
      email: caller.email,
      mode: 'signed_in_user',
      verified: true,
      lifetime: {
        expiresAtMs: caller.expiresAtMs,
        unknownReason: caller.expiresAtMs === null ? 'The CLI did not report an expiry for this OAuth token.' : '',
      },
    },
    judge: {
      judgeEndpoint: JUDGE_ENDPOINT,
      invoke: async (payload: Record<string, unknown>) => invoke(caller, JUDGE_ENDPOINT, payload, 120_000),
    },
    askAgent: async (request) =>
      readTurn(await invoke(caller, AGENT_ENDPOINT, askBody(request, caller.email), TURN_TIMEOUT_MS)),
    describeServedModel: async () => {
      const endpoint = JSON.parse(cli(['serving-endpoints', 'get', AGENT_ENDPOINT, '-o', 'json'])) as unknown;
      const { parseServedModel } = await import('../server/lib/benchmark-runner');
      return parseServedModel(AGENT_ENDPOINT, endpoint);
    },
    turnTimeoutMs: TURN_TIMEOUT_MS,
    suiteBudgetMs: suiteBudget(caller.expiresAtMs),
  });

  if (started.status !== 202) {
    throw new Error(`The run was refused before it began (${started.status}): ${started.body.message}`);
  }
  await started.completed;

  const metrics = JSON.parse(String(stored[stored.length - 1]?.metrics ?? '{}')) as {
    cases?: ScoredCase[];
    servedModel?: { determinate?: boolean; version?: string; entityName?: string; note?: string };
    executedAs?: { mode?: string; verified?: boolean };
  };
  const cases = metrics.cases ?? [];
  // The whole run, kept outside the repository. A suite costs twelve endpoint
  // invocations and a quarter of an hour, and the first real run had to be
  // repeated only because the answers behind a surprising score had not been
  // kept. The scorecard is deliberately thin -- no answer text, no question text
  // -- so this is where the evidence for a finding lives, on the machine that
  // produced it and nowhere else.
  const debug = process.env.PLAYER_INSIGHTS_EVAL_DEBUG_PATH;
  if (debug) {
    writeFileSync(debug, `${JSON.stringify(metrics, null, 2)}\n`);
    console.log(`[eval] Wrote the full run to ${debug}`);
  }
  writeScorecard(cases, caller, metrics);
}

/**
 * The published artifact.
 *
 * REFUSES TO WRITE A SCORECARD OF ALL-REFUSED CASES, which is the guard the
 * offline harness needed and this path should keep. A run that was stopped at
 * the identity gate produced no measurement of the agent, and a file of zeroes
 * and abstentions would be read as one. The failure is loud and the previous
 * scorecard, if any, is left alone.
 */
function writeScorecard(
  cases: ScoredCase[],
  caller: Caller,
  metrics: { servedModel?: { determinate?: boolean; version?: string; entityName?: string; note?: string } }
): void {
  const answered = cases.filter((entry) => entry.outcome !== 'unresolved' && entry.errorStage !== 'identity');
  if (answered.length === 0) {
    throw new Error(
      `Refusing to publish: all ${cases.length} case(s) ended at the identity gate or never ran, so nothing was ` +
        'measured about the agent. A scorecard drawn from this run would be a page of zeroes presented as ' +
        'evidence. Fix the credential and run it again.'
    );
  }

  const rows: ScorecardCase[] = cases.map((entry) => {
    const held = HELD_OUT_CASES.find((candidate) => candidate.caseId === entry.caseId);
    return {
      caseId: entry.caseId,
      group: held?.group ?? 'unknown',
      outcome: entry.errorStage === 'identity' ? 'unavailable' : entry.outcome,
      labelSource: held?.labelSource ?? 'unknown',
      verification: held?.verification ?? '',
      scores: entry.scores ?? [],
    };
  });

  const served = metrics.servedModel;
  const scorecard: Scorecard = {
    provenance: {
      evaluatedAt: new Date().toISOString(),
      agentCommit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
      executedAs: caller.email,
      executedAsNote:
        'The run executed as this signed-in account, with its own OAuth token forwarded to the endpoint. ' +
        'This account is an administrator of the deployment, which is the single biggest qualifier on the ' +
        'governed-access scorers below: an administrator passes a row filter by not being subject to one.',
      judgeEndpoint: JUDGE_ENDPOINT,
      labelProvenance: LABEL_PROVENANCE,
      labelsReviewed: false,
      labelReviewHeadline: LABELS_UNREVIEWED_HEADLINE,
      labelReviewConsequence: LABELS_UNREVIEWED_CONSEQUENCE,
      labelSourceCounts: labelSourceCounts(),
      heldOutFrom: HELD_OUT_FROM,
      producedBy: 'benchmark-runner',
      servedModel: served?.determinate
        ? `${served.entityName ?? 'the served model'} version ${served.version}`
        : (served?.note ?? 'The served model version could not be read.'),
      mlflowRunId: '',
      caseCount: cases.length,
    },
    aggregates: aggregateScores(cases.map((entry) => entry.scores ?? [])) as ScorecardValue[],
    cases: rows,
  };

  writeFileSync(OUTPUT, `${JSON.stringify(scorecard, null, 2)}\n`);
  console.log(`[eval] Wrote ${OUTPUT}`);
  for (const aggregate of scorecard.aggregates) {
    const value = aggregate.state === 'scored' ? String(aggregate.value) : aggregate.state;
    console.log(`[eval]   ${aggregate.scorerId.padEnd(26)} ${value.padStart(10)}  (n=${aggregate.scored})`);
  }
}

main().catch((error: Error) => {
  console.error(`[eval] ${error.message}`);
  process.exitCode = 1;
});
