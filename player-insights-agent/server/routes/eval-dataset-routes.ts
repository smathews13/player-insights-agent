import { z } from 'zod';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import {
  alignGuidelinesFromLabels,
  EvalDatasetSchema,
  labeledRowCount,
  uniqueQuestionsToAdd,
} from '../../shared/eval-dataset';
import { LastSuiteSchema, PromotedAgentSchema, rememberAccuracy } from '../../shared/eval-flywheel';
import { recordAdminAction } from '../lib/admin-roles';
import { readBenchmarkSettings, writeBenchmarkSettings } from '../lib/benchmark-settings-store';
import { readEvalDataset, writeEvalDataset } from '../lib/eval-dataset-store';
import { patchFlywheelState, readFlywheelState } from '../lib/eval-flywheel-store';
import { createGenieAsker, runGenieAccuracy } from '../lib/genie-accuracy';
import { forwardedUserToken } from './access-verification';
import { userEmail, type InsightsAppKit } from './insights-routes';

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
        const guidelinesText = alignGuidelinesFromLabels(settings.guidelinesText, dataset.rows);
        const saved = await writeBenchmarkSettings(appkit, { ...settings, guidelinesText }, actor);
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'eval-guidelines-aligned',
          subject: 'benchmark-settings',
          detail: `Aligned guidelines from ${labeled} labelled row(s).`,
        });
        res.json({ guidelinesText: saved.guidelinesText, labeled });
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
        const flywheel = await patchFlywheelState(
          appkit,
          { promoted: { ...parsed.data, at: parsed.data.at || new Date().toISOString() } },
          actor
        );
        await recordAdminAction(appkit.lakebase, {
          actor,
          action: 'eval-agent-promoted',
          subject: 'eval-flywheel',
          detail: `Next Ask will use ${parsed.data.endpoint}.`,
        });
        res.json({ flywheel });
      } catch (error) {
        res.status(503).json({
          error: 'promote_unavailable',
          message: `The winner was not saved: ${(error as Error).message}`,
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
