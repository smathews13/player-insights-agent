/**
 * "App telemetry is off" must mean the variable is unset, and nothing else.
 *
 * WHAT WENT WRONG. The Ops health block reported telemetry off for a deployment
 * whose bundle sets a destination, on the grounds that "no target has opted into
 * the billed ingestion". That was a reading of the wrong thing. The variable
 * resolves through `bundle/app-release.sh`, which reads `catalog` and
 * `app_telemetry_schema` out of the bundle and passes them to the deploy build,
 * which writes them into the app's `app.yaml`; the container gets a real
 * `catalog.schema` and this module reads it. What produced "off" was not that
 * nothing was configured, it was that a code path with nothing to report reached
 * for `offMeasurement` as a convenient empty payload.
 *
 * That is not an empty payload. `telemetry: 'not-enabled'` is a claim, the page
 * renders it as "App telemetry is off", and the remedy it prints is to set a
 * variable that is already set. A configuration that is on and reads as off is
 * the same class of defect as a search index that was built and never queried:
 * the thing works, the surface says it does not, and everybody believes the
 * surface.
 *
 * So the property pinned here is narrow and worth stating plainly: OFF IS A
 * READING OF THE VARIABLE. Every other outcome -- unreadable, ungranted, thrown,
 * unchecked -- reports the destination it found and says what happened. On day
 * one of a deployment that has just switched telemetry on, the honest answer is
 * "no history yet", because the platform does not backfill and starts writing at
 * the deploy that enables it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  APP_LOG_SOURCE,
  AUTH_EVENT,
  SIGN_IN_REASON,
  TELEMETRY_SCHEMA_ENV,
  EXPORTER_TABLES,
  buildExporterStatement,
  buildTelemetryStatement,
  exporterCoverage,
  exporterFailure,
  forgetExporterReading,
  hasHistory,
  logsTable,
  readExporter,
  readExporterRows,
  noHistoryReason,
  offMeasurement,
  readTelemetryRows,
  telemetrySchema,
  uncheckedMeasurement,
} from './ops-telemetry';

const HREF = 'https://example.invalid/apps';

/** What `bundle/app-release.sh` composes for a target that sets both halves. */
const CONFIGURED = 'a_catalog.a_telemetry_schema';

afterEach(() => {
  delete process.env[TELEMETRY_SCHEMA_ENV];
});

describe('the destination is whatever the release put in the environment', () => {
  it('reads a catalog and schema straight through', () => {
    // The end of the chain the release builds: bundle variable, release script,
    // generated app.yaml, container environment, here. If this returns the value
    // it was given, everything upstream of it is a deployment question rather
    // than a code question.
    process.env[TELEMETRY_SCHEMA_ENV] = CONFIGURED;
    expect(telemetrySchema()).toEqual(CONFIGURED);
    expect(logsTable(telemetrySchema())).toEqual(`${CONFIGURED}.otel_logs`);
  });

  it('treats an unset variable as no destination, which is the customer case', () => {
    // Empty is correct and expected for a target that has not opted into billed
    // ingestion. There is deliberately no default: a default would point these
    // queries at a schema somebody else owns.
    expect(telemetrySchema()).toEqual('');
    expect(logsTable('')).toEqual('');
  });

  it('refuses to guess at a value that is not a catalog and a schema', () => {
    // A bare schema name and a fully qualified table are both plausible typos,
    // and repairing either would read from something nobody named.
    process.env[TELEMETRY_SCHEMA_ENV] = 'just_a_schema';
    expect(telemetrySchema()).toEqual('');
    process.env[TELEMETRY_SCHEMA_ENV] = 'a_catalog.a_schema.a_table';
    expect(telemetrySchema()).toEqual('');
  });
});

describe('off is reported only when the variable is genuinely unset', () => {
  it('says off, and names the variable to set, when nothing is configured', () => {
    const measurement = offMeasurement(HREF);
    expect(measurement.telemetry).toEqual('not-enabled');
    expect(measurement.variable).toEqual(TELEMETRY_SCHEMA_ENV);
    expect(measurement.table).toEqual('');
  });

  it('says off when a block fails and nothing is configured', () => {
    // The customer target, whose Ops page falls over for some unrelated reason.
    // Off is still the truth about telemetry, so it is still what is reported.
    expect(uncheckedMeasurement(HREF, 'the block failed.').telemetry).toEqual('not-enabled');
  });

  it('does NOT say off when a block fails and a destination IS configured', () => {
    // The bug, in one assertion. A deployment that had switched telemetry on was
    // told it had not, and offered the remedy of switching on what was already
    // on.
    //
    // It reports 'unreadable' rather than 'no-rows-yet', because a block that
    // fell over before it looked has not established that the table is empty.
    // Reporting an empty table here is the second half of the same mistake: it
    // trades a false claim about configuration for a false claim about data.
    process.env[TELEMETRY_SCHEMA_ENV] = CONFIGURED;
    const measurement = uncheckedMeasurement(HREF, 'the health block itself failed: boom.');

    expect(measurement.telemetry).toEqual('unreadable');
    expect(measurement.table).toEqual(`${CONFIGURED}.otel_logs`);
  });

  it('names the table and says what actually happened, rather than printing the off copy', () => {
    // The reason is what a reader acts on, and `offMeasurement`'s reason tells
    // them to set the variable. Carrying that text into a configured deployment
    // sends an administrator to change configuration that is already correct.
    process.env[TELEMETRY_SCHEMA_ENV] = CONFIGURED;
    const reason = uncheckedMeasurement(HREF, 'reading it threw: connection reset.').reason;

    expect(reason).toContain(`${CONFIGURED}.otel_logs`);
    expect(reason).toContain('connection reset');
    expect(reason).toContain('unchecked rather than empty');
    expect(reason).not.toContain('is not switched on');
  });
});

/* ── The statement has to plan against the real table ────────────────────── */

/**
 * WHAT WENT WRONG, AND WHY IT LOOKED LIKE A CONFIGURATION PROBLEM.
 *
 * The Ops health block showed no telemetry history on a deployment whose
 * `otel_logs` held thousands of rows. `attributes` in that table is a `VARIANT`,
 * and the sign-in branch subscripted it like a `MAP`. Databricks does not return
 * null for that, it refuses the query: `INVALID_EXTRACT_BASE_FIELD_TYPE ... Need
 * a complex type [STRUCT, ARRAY, MAP] but got "VARIANT"`. Everything in this
 * statement is one `UNION ALL`, so the one branch that would not plan took the
 * last-served time, the request counts and the error lines with it -- three
 * figures that are perfectly readable on their own and are the three the page
 * actually draws.
 *
 * These assertions are string assertions against generated SQL, which is a weak
 * form of test and is the strongest one available here: this repository cannot
 * reach a warehouse from a test. They pin the two things that were wrong, so the
 * next person to touch the extraction has to do it deliberately. The statement
 * itself was verified against the live table by hand.
 */
describe('the telemetry statement', () => {
  const TABLE = 'a_catalog.a_telemetry_schema.otel_logs';
  const statement = buildTelemetryStatement(TABLE);

  it('never subscripts attributes as a map, which is what failed to plan', () => {
    // The exact shape of the bug. A variant will not accept it and the whole
    // statement dies, so this is asserted as an absence rather than by checking
    // that the replacement is present.
    expect(statement).not.toContain("attributes['");
    expect(statement).not.toContain('attributes["');
  });

  it('extracts attributes with variant_get, bracketing keys that contain dots', () => {
    // `$.event.name` would look for an object named `event` holding a `name`.
    // Every key the platform writes here has dots in it, so the bracketed form
    // is the only one that finds anything.
    expect(statement).toContain(`variant_get(attributes, '$["event.name"]', 'string')`);
    expect(statement).toContain(`variant_get(attributes, '$["${AUTH_EVENT}.reason"]', 'string')`);
    expect(statement).not.toContain("'$.event.name'");
  });

  it('matches the event name the platform actually writes', () => {
    // The old predicate was `lower(...) LIKE '%sign%in%'`, a guess at what a
    // sign-in event might be called. It would not have matched `app.auth` even
    // once the extraction above was fixed, so the chart would have stayed empty
    // and read as nobody having signed in.
    expect(statement).toContain(`= '${AUTH_EVENT}'`);
    expect(statement).not.toMatch(/LIKE '%sign%in%'/);
  });

  it('counts a sign-in as a login, not as a refreshed session or an API call', () => {
    // `app.auth.reason` is one of user_login, refresh_session or api_access.
    // Counting the other two would report a figure several times the number of
    // people who signed in, under a heading saying sign-ins.
    expect(SIGN_IN_REASON).toEqual('user_login');
    expect(statement).toContain(`= '${SIGN_IN_REASON}'`);
    expect(statement).not.toContain('refresh_session');
    expect(statement).not.toContain('api_access');
  });

  it('still asks for the three figures the page draws, over the given table', () => {
    // The regression that matters is a branch going missing while the rest keeps
    // planning, which no assertion above would catch.
    expect(statement).toContain(TABLE);
    for (const kind of ['request-hour', 'last-served', 'sign-in-day', 'error-count', 'error-line']) {
      expect(statement).toContain(`'${kind}'`);
    }
  });

  it('bounds the read by the range parameters rather than scanning the table', () => {
    // A warehouse is charged by the second and this table grows without limit.
    expect(statement).toContain(':from_at');
    expect(statement).toContain(':to_at');
  });

  /**
   * A DEPLOY IS NOT TRAFFIC, and the unfiltered table cannot tell the difference.
   *
   * The platform tags each line with `app.log_source`, and `BUILD` -- the output
   * of `npm run build` during a deploy -- is most of the table: on the first day
   * telemetry was on, 1203 of 1319 lines, 608 of them inside one hour. Counting
   * the table as it stands therefore reported 661 requests in an hour when the
   * app had served nobody, and dated "most recent request" to a line of build
   * output. Fixing the extraction above without this would have replaced a blank
   * panel with a confident wrong one.
   */
  it('counts only what the app itself logged, not a deploy\u2019s build output', () => {
    expect(statement).toContain(`variant_get(attributes, '$["app.log_source"]', 'string') = '${APP_LOG_SOURCE}'`);
    // The figures about what the app did come from the filtered rows.
    expect(statement).toMatch(/SELECT 'last-served'[\s\S]*?FROM served/);
    expect(statement).toMatch(/'request-hour'[\s\S]*?FROM served/);
  });

  /**
   * ...EXCEPT SIGN-INS, which carry no `app.log_source` at all. Filtering them
   * the same way discards every one of them and reports a deployment somebody
   * has signed into as having had no sign-ins.
   */
  it('leaves the sign-in branch on the unfiltered rows, because auth lines carry no source', () => {
    const signIn = /SELECT 'sign-in-day',[\s\S]*?FROM (\w+)/.exec(statement);
    expect(signIn?.[1]).toEqual('scoped');
  });

  /**
   * The one branch that must NOT be bounded by the range. See the empty-state
   * tests below for what it is for.
   */
  it('reads the table\u2019s earliest row outside the range, so an empty window can explain itself', () => {
    expect(statement).toContain(`SELECT 'first-recorded', '', CAST(MIN(time) AS STRING), '' FROM ${TABLE}`);
  });
});

/* ── The three states an operator has to be able to tell apart ───────────── */

/**
 * TELEMETRY OFF, TELEMETRY EMPTY, AND A READ THAT FAILED.
 *
 * These are three different situations with three different people to go and
 * see, and the page has confused them in both directions: a failed read
 * reported as an empty table (so the platform looked like it was writing
 * nothing), and a configured deployment reported as unconfigured (so the remedy
 * on screen was to switch on what was already on). Nothing here may render as a
 * confident empty chart for a read that did not happen.
 *
 * The statement was verified against the live example table by hand rather than
 * from a test, because this repository cannot reach a warehouse: it planned, and
 * returned 26 app log lines, one sign-in, no errors, and a recorded start of
 * 2026-08-16 19:13:40 UTC.
 */
describe('the three telemetry states are told apart', () => {
  const RANGE = { from: '2026-08-10', to: '2026-08-16' };

  it('not enabled: off is the reading, and the remedy is the variable', () => {
    const measurement = offMeasurement(HREF);
    expect(measurement.telemetry).toEqual('not-enabled');
    expect(measurement.reason).toContain(TELEMETRY_SCHEMA_ENV);
    // Nothing about rows, because nothing was read.
    expect(measurement.recordingSince).toEqual('');
    expect(measurement.lastServedAt).toEqual('');
  });

  /**
   * ENABLED AND GENUINELY EMPTY. The only case the old single sentence described,
   * and the rarer of the two.
   */
  it('nothing recorded yet: says so plainly, and does not invent a start time', () => {
    const reason = noHistoryReason({ recordingSince: '', ...RANGE });
    expect(reason).toContain('nothing has been written to it at all yet');
    expect(reason).toContain('does not backfill');
    expect(reason).not.toContain('until');
  });

  /**
   * ENABLED, RECORDING, AND EMPTY FOR THE DAYS ON SCREEN -- which is what a
   * deployment reads as on the day telemetry is switched on, because this page
   * shows whole completed days and therefore cannot show today. Sam's Ops tab was
   * in exactly this state while the table filled behind it.
   */
  it('recording since after the window: names when it started and which days are shown', () => {
    const reason = noHistoryReason({ recordingSince: '2026-08-16 19:13:40', ...RANGE });
    expect(reason).toContain('2026-08-16 19:13:40');
    expect(reason).toContain('2026-08-10');
    expect(reason).toContain('2026-08-16');
    expect(reason).toContain('Nothing is broken and nothing was lost');
    // It must not claim the table is empty, because it is not.
    expect(reason).not.toContain('nothing has been written to it at all');
  });

  it('a failed read: names the error and refuses to call the table empty', () => {
    process.env[TELEMETRY_SCHEMA_ENV] = CONFIGURED;
    const measurement = uncheckedMeasurement(HREF, 'Databricks said: INVALID_EXTRACT_BASE_FIELD_TYPE.');

    expect(measurement.telemetry).toEqual('unreadable');
    expect(measurement.reason).toContain('INVALID_EXTRACT_BASE_FIELD_TYPE');
    expect(measurement.reason).toContain('unchecked rather than empty');
    // The three states must be distinct values, or the page cannot draw them apart.
    expect(measurement.telemetry).not.toEqual('no-rows-yet');
    expect(measurement.telemetry).not.toEqual('not-enabled');
  });

  /**
   * The recorded start is EVIDENCE ABOUT THE TABLE, not activity. Counting it as
   * history would put a "reading" heading over an empty window whose every row
   * predates it -- the confusion it exists to end, restated as a bug.
   */
  it('never counts the recorded start as history for a window with nothing in it', () => {
    const figures = readTelemetryRows([['first-recorded', '', '2026-08-16 19:13:40', '']]);
    expect(figures.recordingSince).toEqual('2026-08-16 19:13:40');
    expect(hasHistory(figures)).toBe(false);
  });

  it('reads the stacked rows back into their own figures', () => {
    const figures = readTelemetryRows([
      ['request-hour', '2026-08-16 19:00', '24', ''],
      ['last-served', '', '2026-08-17 02:01:41', ''],
      ['sign-in-day', '2026-08-17', '1', ''],
      ['error-count', '', '0', ''],
      ['first-recorded', '', '2026-08-16 19:13:40', ''],
    ]);

    expect(figures.requestsPerHour).toEqual([{ hour: '2026-08-16 19:00', count: 24 }]);
    expect(figures.signInsPerDay).toEqual([{ day: '2026-08-17', count: 1 }]);
    expect(figures.lastServedAt).toEqual('2026-08-17 02:01:41');
    expect(figures.recordingSince).toEqual('2026-08-16 19:13:40');
    expect(figures.errors.count).toEqual(0);
    expect(hasHistory(figures)).toBe(true);
  });
});

/**
 * The exporter count, which exists because this file used to assert the answer.
 *
 * `otel_spans` and `otel_metrics` were described here as "permanently empty on
 * every deployment", reasoned from the absence of an OpenTelemetry SDK in our
 * own dependencies rather than from a count. appkit bundles the SDK, so an
 * exporter runs anyway, and both tables have been filling since 2026-08-16.
 *
 * What these pin is not the counts -- those move every minute -- but the rule
 * the old claim broke: every state below is a reading, and a read that did not
 * complete is never reported as a table that holds nothing.
 */
describe('the exporter is counted, not asserted', () => {
  afterEach(() => forgetExporterReading());

  it('counts both tables the exporter writes, in one statement', () => {
    const sql = buildExporterStatement('a_catalog.a_schema');

    for (const table of EXPORTER_TABLES) {
      expect(sql).toContain(`a_catalog.a_schema.${table}`);
    }
    // ONE wake-up, not two. A warehouse charges for being awake.
    expect(sql.match(/FROM /g)).toHaveLength(EXPORTER_TABLES.length);
    // `time`, not `start_time`: the latter does not resolve on these tables and
    // would fail the whole statement.
    expect(sql).toContain('MIN(time)');
    expect(sql).not.toContain('start_time');
    // NO RANGE FILTER. The question is whether anything exports at all, and a
    // window that excluded the rows would answer it wrongly in exactly the
    // direction this change exists to stop.
    expect(sql).not.toContain('_at AS TIMESTAMP');
  });

  it('reads rows as exporting, and carries the span they cover', () => {
    const reading = readExporterRows(
      [
        ['otel_metrics', '923707', '2026-08-16 19:31:09', '2026-08-17 16:44:29'],
        ['otel_spans', '5469', '2026-08-16 19:30:59', '2026-08-17 16:43:41'],
      ],
      'a_catalog.a_schema'
    );

    expect(reading.state).toBe('exporting');
    expect(reading.tables.map((entry) => entry.rows)).toEqual([923707, 5469]);
    // Telemetry does not backfill, so the figures are only ever true of this
    // span. Reporting them without it invites reading them as a lifetime total.
    expect(exporterCoverage(reading)).toBe('2026-08-16 19:30:59 to 2026-08-17 16:44:29');
  });

  it('reads counted zeroes as silent, which is a finding and not a failure', () => {
    const reading = readExporterRows(
      [
        ['otel_spans', '0', null, null],
        ['otel_metrics', '0', null, null],
      ],
      'a_catalog.a_schema'
    );

    expect(reading.state).toBe('silent');
    expect(reading.error).toBe('');
    expect(exporterCoverage(reading)).toBe('');
  });

  /**
   * THE WHOLE POINT. A count that did not happen is not a count of zero, and
   * this app has shipped that substitution twice: a table reported empty while
   * its query was failing, and a badge reading OK on a deleted experiment.
   */
  it('never reports a failed count as an empty table', () => {
    const failed = exporterFailure('TABLE_OR_VIEW_NOT_FOUND', 'a_catalog.a_schema');

    expect(failed.state).toBe('unreadable');
    expect(failed.state).not.toBe('silent');
    expect(failed.error).toContain('TABLE_OR_VIEW_NOT_FOUND');
    expect(failed.tables).toEqual([]);

    // And a warehouse that answered with no rows at all is unreadable too:
    // nothing was established, which is not the same as nothing being there.
    expect(readExporterRows([], 'a_catalog.a_schema').state).toBe('unreadable');
  });

  it('takes one count per window and serves the rest from it', async () => {
    let counts = 0;
    const read = () => {
      counts += 1;
      return Promise.resolve(exporterFailure(`call ${counts}`, 'a_catalog.a_schema'));
    };

    const first = await readExporter({ read, now: 1_000, cacheMs: 60_000 });
    const second = await readExporter({ read, now: 30_000, cacheMs: 60_000 });
    // Cached, because `/api/settings` is consumer-visible and fetched on every
    // open of the tab. One warehouse wake-up, not one per reader.
    expect(counts).toBe(1);
    expect(second).toBe(first);

    await readExporter({ read, now: 90_000, cacheMs: 60_000 });
    expect(counts).toBe(2);
  });

  it('reports no reading rather than a false one where nothing is configured', async () => {
    delete process.env[TELEMETRY_SCHEMA_ENV];
    const reading = await readExporter({ now: 1_000, cacheMs: 0 });

    // Unmeasured, NOT empty. No destination means nobody looked.
    expect(reading.state).toBe('unmeasured');
    expect(reading.error).toBe('');
  });
});
