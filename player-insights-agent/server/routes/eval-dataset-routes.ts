import { z } from 'zod';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { EvalDatasetSchema, labeledRowCount, uniqueQuestionsToAdd } from '../../shared/eval-dataset';
import { alignGuidelinesToHumans, loadCasesForAlignment } from '../lib/judge-alignment';
import { LastSuiteSchema, PromotedAgentSchema, rememberAccuracy } from '../../shared/eval-flywheel';
import { promotePromptAlias, promptTemplateFromPromote } from '../lib/prompt-registry';
import { startLabelingSession } from '../lib/review-app';
import { findLatestAnsweredConversation, loadConversationTurns } from '../lib/eval-conversation';
import { scoreSampledAskTurn } from '../lib/live-ask-scoring';
import { formatConversationTurns } from '../../shared/eval-conversation';
import { DEFAULT_LIVE_SAMPLE_RATE } from '../../shared/eval-live-scoring';
import { recordAdminAction } from '../lib/admin-roles';
import { readBenchmarkSettings, writeBenchmarkSettings } from '../lib/benchmark-settings-store';
import { readEvalDataset, writeEvalDataset } from '../lib/eval-dataset-store';
import { patchFlywheelState, readFlywheelState } from '../lib/eval-flywheel-store';
import { listLiveScores } from '../lib/eval-live-score-store';
import { createGenieAsker, runGenieAccuracy } from '../lib/genie-accuracy';
import { probeWorkspaceMonitoring } from '../lib/live-monitoring';
import { forwardedUserToken } from './access-verification';
import { servingInvocationPath, userEmail, type InsightsAppKit } from './insights-routes';

const GenieAccuracyBody = z.object({
  spaceId: z.string().trim().min(1).max(200),
  spaceLabel: z.string().trim().max(200).optional(),
});

const CurateBody = z.object({
  questions: z.array(z.string().trim().max(2000)).max(100),
});

const LastSuiteBody = LastSuiteSchema.extend({
  runIds: z.array(z.string().trim().min(1).max(80)).max(4).default([]),
  sides: z.array(z.string().trim().max(200)).max(4).default([]),
});

function workspaceHost(): string {
  return normalizeWorkspaceHost(process.env.DATABRICKS_HOST);
}

export function setupEvalDatasetRoutes(appkit: InsightsAppKit): void {
  appkit.server.extend((app) => {
    app.get('/api/benchmarks/dataset', async (_req, res) => {
      const dataset = await readEvalDataset(appkit, { maxAgeMs: 0 });
      res.json({ dataset });
    });

    app.get('/api/benchmarks/flywheel', async (_req, res) => {
      const flywheel = await readFlywheelState(appkit, { maxAgeMs: 0 });
      res.json({ flywheel });
    });

    app.get('/api/benchmarks/live-scores', async (_req, res) => {
      const [scores, settings] = await Promise.all([
        listLiveScores(appkit),
        readBenchmarkSettings(appkit, { maxAgeMs: 0 }),
      ]);
      res.json({
        scores,
        sampleRate: DEFAULT_LIVE_SAMPLE_RATE,
        alwaysOnTraces: settings.alwaysOnTraces,
        workspace: {
          status: 'unknown',
          note: 'Open “Check workspace monitoring” to list scorers already registered on the experiment. This list is the in-app hook, not a fabricated MLflow monitor.',
          scorers: [],
        },
      });
    });

    app.post('/api/admin/benchmarks/live-monitoring', async (req, res) => {
      const actor = userEmail(req);
      const settings = await readBenchmarkSettings(appkit, { maxAgeMs: 0 });
      const experimentId = settings.experimentId.trim();
      let workspace;
      try {
        const { WorkspaceClient } = await import('@databricks/sdk-experimental');
        const client = new WorkspaceClient({});
        workspace = await probeWorkspaceMonitoring(client, experimentId);
      } catch (error) {
        workspace = {
          status: 'blocked' as const,
          note: `Workspace monitoring could not be reached: ${(error as Error).message} Sampled Ask turns are still scored in this app.`,
          scorers: [],
        };
      }
      await recordAdminAction(appkit.lakebase, {
        actor,
        action: 'eval-live-monitoring-probed',
        subject: 'eval-live-scores',
        detail: workspace.note,
      });
      res.json({
        workspace,
        sampleRate: DEFAULT_LIVE_SAMPLE_RATE,
        alwaysOnTraces: settings.alwaysOnTraces,
      });
    });

    app.put('/api/admin/benchmarks/dataset', async (req, res) => {
      const parsed = EvalDatasetSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_eval_dataset', detail: parsed.error.message });
        return;
      }
      const actor = userEmail(req);
      try {
        const dataset = await writeEvalDataset(appkit, parsed.data, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'eval-dataset-updated',
          subject: 'eval-dataset',
          detail: `Updated evaluation dataset (${dataset.rows.length} row(s)).`,
        });
        res.json({ dataset });
      } catch (error) {
        res.status(503).json({
          error: 'eval_dataset_store_unavailable',
          detail: `The dataset was not saved: ${(error as Error).message}`,
        });
      }
    });

    app.post('/api/admin/benchmarks/dataset/curate', async (req, res) => {
      const parsed = CurateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_curate', detail: 'Send the questions to add.' });
        return;
      }
      const actor = userEmail(req);
      try {
        const current = await readEvalDataset(appkit, { maxAgeMs: 0 });
        const added = uniqueQuestionsToAdd(current.rows, parsed.data.questions);
        const dataset = await writeEvalDataset(appkit, { rows: [...current.rows, ...added] }, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'eval-dataset-curated',
          subject: 'eval-dataset',
          detail: `Added ${added.length} question(s) from traces.`,
        });
        res.json({ dataset, added: added.length });
      } catch (error) {
        res.status(503).json({
          error: 'eval_dataset_store_unavailable',
          detail: `Those questions were not added: ${(error as Error).message}`,
        });
      }
    });

    app.post('/api/admin/benchmarks/align-guidelines', async (req, res) => {
      const actor = userEmail(req);
      try {
        const dataset = await readEvalDataset(appkit, { maxAgeMs: 0 });
        const labeled = labeledRowCount(dataset.rows);
        if (labeled === 0) {
          res.status(400).json({
            error: 'no_labels',
            message: 'Label at least one row (thumbs or SQL correct?) before aligning the guidelines.',
          });
          return;
        }
        const settings = await readBenchmarkSettings(appkit, { maxAgeMs: 0 });
        const flywheel = await readFlywheelState(appkit, { maxAgeMs: 0 });
        const cases = await loadCasesForAlignment(appkit, flywheel.lastAgentRunIds);
        let alignClient;
        let invokeJudge;
        try {
          const { WorkspaceClient } = await import('@databricks/sdk-experimental');
          const client = new WorkspaceClient({});
          alignClient = {
            request: ({ method, path, payload }: { method: string; path: string; payload?: Record<string, unknown> }) =>
              client.apiClient.request({ method, path, payload, raw: false }),
          };
          const judgeEndpoint = settings.judgeEndpoint.trim();
          if (judgeEndpoint) {
            invokeJudge = (payload: Record<string, unknown>) =>
              client.apiClient.request({
                path: servingInvocationPath(judgeEndpoint),
                method: 'POST',
                payload,
                raw: false,
              });
          }
        } catch {
          // Apps without a workspace client still distill a replacement rubric.
        }
        const aligned = await alignGuidelinesToHumans({
          base: settings.guidelinesText,
          rows: dataset.rows,
          cases,
          experimentId: settings.experimentId,
          alignClient,
          invokeJudge,
        });
        const saved = await writeBenchmarkSettings(appkit, { ...settings, guidelinesText: aligned.guidelinesText }, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'eval-guidelines-aligned',
          subject: 'benchmark-settings',
          detail: aligned.note,
        });
        res.json({
          guidelinesText: saved.guidelinesText,
          labeled,
          agreement: aligned.agreement,
          method: aligned.method,
          note: aligned.note,
        });
      } catch (error) {
        res.status(503).json({
          error: 'align_guidelines_unavailable',
          message: `Guidelines were not updated: ${(error as Error).message}`,
        });
      }
    });

    app.post('/api/admin/benchmarks/promote', async (req, res) => {
      const parsed = PromotedAgentSchema.safeParse(req.body);
      if (!parsed.success || !parsed.data.endpoint.trim()) {
        res.status(400).json({
          error: 'invalid_promote',
          message: 'Pick a baseline or candidate endpoint to use for the next Ask.',
        });
        return;
      }
      const actor = userEmail(req);
      try {
        const current = await readFlywheelState(appkit, { maxAgeMs: 0 });
        const settings = await readBenchmarkSettings(appkit, { maxAgeMs: 0 });
        const promptName = current.promptRegistryName.trim();
        const template = promptTemplateFromPromote({
          side: parsed.data.side,
          endpoint: parsed.data.endpoint,
          guidelines: settings.guidelinesText,
        });
        let promotedPrompt = current.promotedPrompt;
        try {
          const { WorkspaceClient } = await import('@databricks/sdk-experimental');
          const client = new WorkspaceClient({});
          promotedPrompt = await promotePromptAlias(
            {
              request: ({ method, path, payload }) =>
                client.apiClient.request({ method, path, payload, raw: false }),
            },
            { name: promptName, template }
          );
        } catch (error) {
          promotedPrompt = {
            name: promptName,
            alias: 'production',
            version: '',
            uri: promptName ? `prompts:/${promptName}@production` : '',
            template,
            status: promptName ? 'blocked' : 'skipped',
            note: promptName
              ? `The production alias was not moved: ${(error as Error).message} The next Ask still uses the guidance saved from this promote.`
              : 'No Prompt Registry name is set. Next Ask still uses the saved guidance from this promote.',
          };
        }
        const flywheel = await patchFlywheelState(
          appkit,
          {
            promoted: { ...parsed.data, at: parsed.data.at || new Date().toISOString() },
            promotedPrompt,
          },
          actor
        );
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'eval-agent-promoted',
          subject: 'eval-flywheel',
          detail: `Next Ask will use ${parsed.data.endpoint}. ${promotedPrompt?.note ?? ''}`.trim(),
        });
        res.json({ flywheel, promotedPrompt });
      } catch (error) {
        res.status(503).json({
          error: 'promote_unavailable',
          message: `The winner was not saved: ${(error as Error).message}`,
        });
      }
    });

    app.post('/api/admin/benchmarks/review-app', async (req, res) => {
      const actor = userEmail(req);
      const settings = await readBenchmarkSettings(appkit, { maxAgeMs: 0 });
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      let session;
      try {
        const { WorkspaceClient } = await import('@databricks/sdk-experimental');
        const client = new WorkspaceClient({});
        session = await startLabelingSession(
          {
            request: ({ method, path, payload }) =>
              client.apiClient.request({ method, path, payload, raw: false }),
          },
          { name, experimentId: settings.experimentId }
        );
      } catch (error) {
        session = {
          name: name || 'PIA SME review',
          sessionId: '',
          runId: '',
          url: '',
          status: 'blocked' as const,
          note: `Review App could not be started: ${(error as Error).message} SMEs can still label thumbs and SQL correct on this tab.`,
          at: new Date().toISOString(),
        };
      }
      try {
        const flywheel = await patchFlywheelState(appkit, { labelingSession: session }, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'eval-review-app-started',
          subject: 'eval-flywheel',
          detail: session.note,
        });
        res.status(session.status === 'open' ? 200 : 503).json({ session, flywheel });
      } catch (error) {
        res.status(session.status === 'open' ? 200 : 503).json({
          session,
          message: session.note || (error as Error).message,
        });
      }
    });

    app.post('/api/admin/benchmarks/score-thread', async (req, res) => {
      const actor = userEmail(req);
      const requested = typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : '';
      try {
        const conversationId = requested || (await findLatestAnsweredConversation(appkit));
        if (!conversationId) {
          res.status(404).json({
            error: 'no_thread',
            message: 'No Ask thread to score yet. Ask a question first, then score the whole conversation.',
          });
          return;
        }
        const turns = await loadConversationTurns(appkit, conversationId);
        if (turns.length < 2) {
          res.status(400).json({
            error: 'short_thread',
            message: 'That thread does not have a full conversation yet.',
          });
          return;
        }
        const settings = await readBenchmarkSettings(appkit, { maxAgeMs: 0 });
        const lastUser = [...turns].reverse().find((turn) => !/assistant|agent/i.test(turn.role));
        const lastAssistant = [...turns].reverse().find((turn) => /assistant|agent/i.test(turn.role));
        let invokeJudge;
        const judgeEndpoint = settings.judgeEndpoint.trim();
        if (judgeEndpoint) {
          try {
            const { WorkspaceClient } = await import('@databricks/sdk-experimental');
            const client = new WorkspaceClient({});
            invokeJudge = (payload: Record<string, unknown>) =>
              client.apiClient.request({
                path: servingInvocationPath(judgeEndpoint),
                method: 'POST',
                payload,
                raw: false,
              });
          } catch {
            invokeJudge = undefined;
          }
        }
        const score = await scoreSampledAskTurn({
          client: appkit,
          settings: { ...settings, alwaysOnTraces: true },
          sampleRate: 1,
          invokeJudge,
          turn: {
            conversationId,
            messageId: `thread-${conversationId}`.slice(0, 80),
            question: lastUser?.content ?? '',
            response: lastAssistant?.content ?? '',
            sql: '',
            note: `${turns.length} turns`,
            turns,
          },
        });
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'eval-thread-scored',
          subject: conversationId,
          detail: `Scored ${turns.length} turns in the Ask thread.`,
        });
        res.json({
          conversationId,
          turnCount: turns.length,
          score,
          transcript: formatConversationTurns(turns).slice(0, 4000),
        });
      } catch (error) {
        res.status(503).json({
          error: 'score_thread_unavailable',
          message: `That thread was not scored: ${(error as Error).message}`,
        });
      }
    });

    app.put('/api/admin/benchmarks/prompt-registry', async (req, res) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (name && !/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+){2}$/.test(name)) {
        res.status(400).json({
          error: 'invalid_prompt_name',
          message: 'Use a Unity Catalog name: catalog.schema.prompt',
        });
        return;
      }
      const actor = userEmail(req);
      try {
        const flywheel = await patchFlywheelState(appkit, { promptRegistryName: name }, actor);
        res.json({ flywheel });
      } catch (error) {
        res.status(503).json({
          error: 'prompt_registry_unavailable',
          message: `The Prompt Registry name was not saved: ${(error as Error).message}`,
        });
      }
    });

    app.post('/api/admin/benchmarks/last-suite', async (req, res) => {
      const parsed = LastSuiteBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_last_suite', message: 'The last suite could not be remembered.' });
        return;
      }
      const actor = userEmail(req);
      try {
        const flywheel = await patchFlywheelState(
          appkit,
          {
            lastSuite: {
              kind: parsed.data.kind,
              spaceId: parsed.data.spaceId,
              spaceLabel: parsed.data.spaceLabel,
              at: parsed.data.at || new Date().toISOString(),
            },
            lastAgentRunIds: parsed.data.runIds,
            lastAgentSides: parsed.data.sides,
          },
          actor
        );
        res.json({ flywheel });
      } catch (error) {
        res.status(503).json({
          error: 'last_suite_unavailable',
          message: `The last suite was not saved: ${(error as Error).message}`,
        });
      }
    });

    app.post('/api/benchmarks/genie-accuracy', async (req, res) => {
      const parsed = GenieAccuracyBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'invalid_genie_accuracy',
          message: 'Pick a connected Genie space before running accuracy.',
        });
        return;
      }
      const host = workspaceHost();
      const token = forwardedUserToken(req);
      if (!host || !token) {
        res.status(503).json({
          error: 'genie_accuracy_unavailable',
          message:
            'This app cannot ask the Genie space as you. Sign in to the workspace and try again. No score was invented.',
        });
        return;
      }
      const dataset = await readEvalDataset(appkit, { maxAgeMs: 0 });
      if (dataset.rows.every((row) => !row.question.trim() || !row.groundTruthSql.trim())) {
        res.status(400).json({
          error: 'no_sql_backed_questions',
          message: 'Add questions with ground-truth SQL first. Accuracy is passed over those rows only.',
        });
        return;
      }
      const run = await runGenieAccuracy({
        spaceId: parsed.data.spaceId,
        spaceLabel: parsed.data.spaceLabel,
        rows: dataset.rows,
        asker: createGenieAsker({ host, token }),
      });
      const actor = userEmail(req);
      try {
        const current = await readFlywheelState(appkit, { maxAgeMs: 0 });
        await patchFlywheelState(
          appkit,
          {
            lastSuite: {
              kind: 'genie',
              spaceId: run.spaceId,
              spaceLabel: run.spaceLabel,
              at: run.finishedAt,
            },
            history: rememberAccuracy(current.history, {
              at: run.finishedAt,
              spaceId: run.spaceId,
              spaceLabel: run.spaceLabel,
              passed: run.score.passed,
              scored: run.score.total,
              excluded: run.score.excluded,
              percent: run.score.percent,
              label: run.score.label,
              note: run.score.excluded > 0 ? `${run.score.excluded} not scored (warehouse or timeout)` : '',
            }),
          },
          actor
        );
      } catch (error) {
        console.warn('[eval-flywheel] Accuracy history was not saved:', (error as Error).message);
      }
      res.json({ run });
    });
  });
}
