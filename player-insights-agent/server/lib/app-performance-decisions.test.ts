import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BROWSE_PAGE_LIMIT, BROWSE_PAGE_SIZE } from './browse-assets';
import { DISCOVERY_CACHE_MAX_ENTRIES, DISCOVERY_CACHE_TTL_MS, DISCOVERY_MAX_CONCURRENCY } from './discovery-control';
import { GENIE_WARMUP_CACHE_MAX_ENTRIES } from './genie-warehouse-warmup';
import {
  MAX_QUERY_HISTORY_PAGES,
  MAX_QUERY_HISTORY_TOTAL_RANGE_MS,
  QUERY_HISTORY_DEADLINE_MS,
} from './ops-query-history';
import {
  MAX_CONCURRENT_PDF_EXTRACTIONS,
  MAX_PDF_BYTES,
  MAX_PDF_TEXT_CHARS,
  MAX_QUEUED_PDF_EXTRACTIONS,
  PDF_EXTRACTION_TIMEOUT_MS,
} from './pdf-text';
import { REQUEST_LATENCY_SHUTDOWN_TIMEOUT_MS } from './request-latency-shutdown';
import { MAX_SERVING_OUTPUT_ITEMS, MAX_SERVING_STREAM_BYTES, MAX_SERVING_STREAM_EVENTS } from './serving-stream';
import { STAGE_INPUT_LIMIT, STAGE_REPLAY_LIMIT } from './run-stage-events';
import {
  DELETE_BATCH_SIZE,
  MAX_DELETE_BATCHES_PER_RUN,
  MAX_ROLLUP_DAYS_PER_RUN,
  RAW_TELEMETRY_RETENTION_DAYS,
} from './telemetry-retention';
import {
  CANCELLATION_DEADLINE_MS,
  CANCELLATION_LOOKBACK_MS,
  MAX_CANCELLATION_HISTORY_PAGES,
} from './warehouse-cancellation';
import { EXPERIMENT_ID_CACHE_MAX_ENTRIES } from './app-settings';
import { SP_TOKEN_CACHE_MAX_ENTRIES } from './sp-token';
import { GRANT_CACHE_MAX_ENTRIES } from './monitoring-grants';
import { ACCESS_DECISION_CACHE_MAX_ENTRIES } from '../routes/execution-identity';
import { BROWSE_ROUTE_DEADLINE_MS } from '../routes/browse-routes';
import { MONITORING_TOP_TABLE_LIMIT, QUESTION_PAGE_SIZE, QUESTION_READ_LIMIT } from '../routes/monitoring-routes';

const DECISIONS = readFileSync(new URL('../../../docs/APP_PERFORMANCE_DECISIONS.md', import.meta.url), 'utf8');
const POLLING_SOURCE = readFileSync(new URL('../../client/src/active-run-polling.ts', import.meta.url), 'utf8');
const COMPOSER_SOURCE = readFileSync(new URL('../../client/src/composer-clearance.ts', import.meta.url), 'utf8');
const MONITORING_SOURCE = readFileSync(new URL('../../client/src/MonitoringPage.tsx', import.meta.url), 'utf8');

function expectDocumented(name: string, value: number | string): void {
  expect(DECISIONS, `${name} must stay aligned with its source constant`).toContain(`\`${name}=${value}\``);
}

describe('the app performance decision log', () => {
  it('stays aligned with critical production limits', () => {
    const limits: Record<string, number> = {
      RAW_TELEMETRY_RETENTION_DAYS,
      MAX_ROLLUP_DAYS_PER_RUN,
      DELETE_BATCH_SIZE,
      MAX_DELETE_BATCHES_PER_RUN,
      MAX_SERVING_STREAM_BYTES,
      MAX_SERVING_STREAM_EVENTS,
      MAX_SERVING_OUTPUT_ITEMS,
      STAGE_REPLAY_LIMIT,
      STAGE_INPUT_LIMIT,
      DISCOVERY_MAX_CONCURRENCY,
      DISCOVERY_CACHE_TTL_MS,
      DISCOVERY_CACHE_MAX_ENTRIES,
      BROWSE_PAGE_SIZE,
      BROWSE_PAGE_LIMIT,
      BROWSE_ROUTE_DEADLINE_MS,
      MAX_PDF_BYTES,
      MAX_PDF_TEXT_CHARS,
      PDF_EXTRACTION_TIMEOUT_MS,
      MAX_CONCURRENT_PDF_EXTRACTIONS,
      MAX_QUEUED_PDF_EXTRACTIONS,
      MAX_QUERY_HISTORY_PAGES,
      MAX_QUERY_HISTORY_TOTAL_RANGE_MS,
      QUERY_HISTORY_DEADLINE_MS,
      MAX_CANCELLATION_HISTORY_PAGES,
      CANCELLATION_LOOKBACK_MS,
      CANCELLATION_DEADLINE_MS,
      EXPERIMENT_ID_CACHE_MAX_ENTRIES,
      SP_TOKEN_CACHE_MAX_ENTRIES,
      GRANT_CACHE_MAX_ENTRIES,
      ACCESS_DECISION_CACHE_MAX_ENTRIES,
      GENIE_WARMUP_CACHE_MAX_ENTRIES,
      REQUEST_LATENCY_SHUTDOWN_TIMEOUT_MS,
      QUESTION_PAGE_SIZE,
      QUESTION_READ_LIMIT,
      MONITORING_TOP_TABLE_LIMIT,
    };
    for (const [name, value] of Object.entries(limits)) expectDocumented(name, value);
  });

  it('keeps adaptive polling constants aligned without importing client code into the server', () => {
    expect(POLLING_SOURCE).toContain('export const ACTIVE_RUN_INITIAL_POLL_MS = 1_500;');
    expect(POLLING_SOURCE).toContain(
      'export const ACTIVE_RUN_BACKOFF_MS = [2_000, 3_000, 5_000, 8_000, 10_000] as const;'
    );
    expect(POLLING_SOURCE).toContain('export const ACTIVE_RUN_JITTER_RATIO = 0.15;');
    expectDocumented('ACTIVE_RUN_INITIAL_POLL_MS', 1500);
    expectDocumented('ACTIVE_RUN_BACKOFF_MS', '2000,3000,5000,8000,10000');
    expectDocumented('ACTIVE_RUN_JITTER_RATIO', 0.15);
  });

  it('keeps documented responsive UI limits aligned with client source', () => {
    expect(COMPOSER_SOURCE).toContain('export const COMPOSER_CLEARANCE_BUFFER_PX = 16;');
    expect(MONITORING_SOURCE).toContain('export const MONITORING_COMPACT_MAX_WIDTH_PX = 799;');
    expectDocumented('COMPOSER_CLEARANCE_BUFFER_PX', 16);
    expectDocumented('MONITORING_COMPACT_MAX_WIDTH_PX', 799);
  });
});
