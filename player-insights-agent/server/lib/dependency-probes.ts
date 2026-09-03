/**
 * Whether the person reading the Connections page can reach the things this
 * deployment is wired to.
 *
 * WHY THE APP ASKS AND NOT THE AGENT. The orchestrator used to answer this from
 * inside the serving endpoint, and it stopped: every current model version
 * replies `preflight_retired` and carries its configuration instead of a health
 * report. `/api/preflight` reports that retirement correctly and says, in its own
 * assumption line, where the answer now lives -- "Unity Catalog and the
 * workspace, which hold the grants". Nothing then went and asked them. So the
 * page kept its promise to report "whether it can reach each one" while every
 * row but two read `Not checked`, which is the shape of an unkept promise rather
 * than of a limitation: a reader cannot tell a page that could not find out from
 * a page that never looked.
 *
 * WHAT A PASS HERE ACTUALLY MEANS, because this is the whole risk of adding it.
 * Each probe is a metadata GET against the control plane under the SIGNED-IN
 * USER's forwarded token. It establishes that this identity can see this object.
 * It does not establish that a query against it will succeed: row filters and
 * column masks are enforced at read time and are invisible to a metadata call,
 * `CAN_VIEW` on a serving endpoint is a different grant from `CAN_QUERY`, and a
 * Genie space a person can open can still be backed by tables they cannot read.
 * Every subject below therefore carries its own `proves` clause naming the gap,
 * and it is appended to the detail of a PASS rather than kept for the failures,
 * because an unqualified green tick is the reassuring lie this page exists to
 * refuse.
 *
 * THREE OUTCOMES, NOT TWO. A refusal (403) and an absence (404) are both
 * failures and are not the same failure: one is fixed with a GRANT and the other
 * cannot be, and reporting an absent table as forbidden sends a deployer to an
 * admin for a permission on an object that does not exist. Anything that did not
 * produce an answer at all -- a timeout, a 5xx, a rate limit, a missing token --
 * is `unverified`, which is this codebase's word for "nobody established it
 * either way" and is never rendered as health.
 *
 * A 403 IS NOT ONE FAILURE EITHER, and that is the correction this file most
 * recently needed. Three different things produce it, and they are fixed by
 * three different people:
 *
 *   the caller lacks a Unity Catalog grant   an admin runs a GRANT
 *   the caller's TOKEN lacks the API scope   the app declares it and is restarted
 *   the object is not there                  nobody grants anything (see 404)
 *
 * The middle one is the whole of `see {@link refusalCause}`. These probes run on
 * the signed-in user's FORWARDED token, which Databricks Apps downscopes to the
 * app's declared `user_api_scopes`. A scope the app never asked for makes every
 * call in that API family fail with a 403 that has nothing to do with the
 * reader's permissions, and this page reported all of them as missing grants and
 * printed a `GRANT SELECT` for each -- to a reader who could query every one of
 * those tables from a notebook. A confident wrong remedy is worse than none: it
 * is the one thing on this page a reader acts on.
 */
import type { PreflightCheck, PreflightConfiguration, PreflightRemedy } from '../routes/insights-routes';
import { looksLikeMissingScope, scopesFromToken } from '../routes/access-verification';
import { scopeRefusalDiagnosis } from './scope-refusal';
import { declaredUserApiScopes } from '../../shared/declared-scopes';
import { tokenScopeVerdict } from '../../shared/token-scopes';
import { derivedSemanticIndexName, resolveSemanticIndexValue } from './semantic-index-name';
export { tokenCarriesScope, tokenScopeVerdict } from '../../shared/token-scopes';

/**
 * How long one probe may take before it is reported as unanswered.
 *
 * A metadata read, so a second would usually do. Fifteen is chosen against the
 * control plane's cold paths rather than its warm ones, and the whole set runs
 * concurrently, so this bounds the page rather than being paid per resource.
 */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * The user API scope each workspace API family needs on a forwarded token.
 *
 * DERIVED FROM THE PATH RATHER THAN DECLARED PER SUBJECT, so a probe cannot be
 * added without one. A subject whose path matches nothing here reports an empty
 * scope, and `user-api-scopes.test.ts` fails on it: that is the whole mechanism
 * stopping this recurring, because the failure it is guarding against is
 * somebody adding a probe against a new API and nobody noticing the app never
 * asked for the scope until a customer sees twenty red rows.
 *
 * THE NAMES ARE THE APPS ONES, NOT THE OAUTH SERVER'S. Two namespaces overlap
 * here and only one governs `user_api_scopes`. The workspace's OAuth metadata
 * (`/oidc/.well-known/oauth-authorization-server`) advertises coarse families --
 * `unity-catalog`, `vector-search`, `genie` -- and the Apps update API rejects
 * `unity-catalog` outright while accepting `dashboards.genie`, which that
 * metadata does not list at all. The two lists disagree in BOTH directions, so
 * neither can be read off the other. Declaring `unity-catalog` here failed the
 * whole bundle deploy: "The specified scope unity-catalog is not a valid scope."
 *
 * Every name below was checked against the Apps API itself. See
 * `user-api-scopes.test.ts` for the one-line check, which needs no deploy.
 *
 * NO COARSE FALLBACK, DELIBERATELY. A probe against, say,
 * `/api/2.1/unity-catalog/volumes/` matches nothing here and reports '', which
 * fails `user-api-scopes.test.ts` on the commit that adds it. A general
 * `/api/2.1/unity-catalog/` entry would instead hand it a plausible scope that
 * does not cover the call, and the failure would surface on a customer's screen.
 *
 * Longest prefix wins, so a more specific family can be added above a general
 * one without the general one swallowing it.
 */
export const SCOPE_BY_API_PREFIX: Readonly<Record<string, string>> = {
  '/api/2.1/unity-catalog/catalogs/': 'catalog.catalogs:read',
  '/api/2.1/unity-catalog/schemas/': 'catalog.schemas:read',
  '/api/2.1/unity-catalog/tables/': 'catalog.tables:read',
  '/api/2.0/vector-search/indexes/': 'vectorsearch.vector-search-indexes:read',
  '/api/2.0/vector-search/endpoints/': 'vectorsearch.vector-search-endpoints:read',
  '/api/2.0/serving-endpoints/': 'serving.serving-endpoints',
  '/api/2.0/genie/': 'dashboards.genie',
  '/api/2.0/sql/': 'sql',
};

/**
 * The scope this path needs, or '' when no family claims it.
 *
 * '' is a finding rather than a default. See {@link SCOPE_BY_API_PREFIX}.
 */
export function scopeForPath(path: string): string {
  let best = '';
  let longest = 0;
  for (const [prefix, scope] of Object.entries(SCOPE_BY_API_PREFIX)) {
    if (path.startsWith(prefix) && prefix.length > longest) {
      best = scope;
      longest = prefix.length;
    }
  }
  return best;
}

/** Every scope the probes in this module need, for the bundle to declare. */
export function scopesProbesNeed(subjects: readonly ProbeSubject[]): string[] {
  return [...new Set(subjects.map((subject) => scopeForPath(subject.path)))].sort();
}

/** One thing to ask the workspace about. */
export interface ProbeSubject {
  /**
   * The check id.
   *
   * Equal to the connection's registry id wherever there is a row for it, which
   * is what lets `connection-model.ts` find this check without a second mapping
   * table that could disagree with the registry.
   */
  id: string;
  kind: string;
  /** The configured identifier being asked about. Never invented. */
  name: string;
  label: string;
  /** The workspace API path, already encoded. */
  path: string;
  /** What a pass does NOT prove, in this object's own terms. */
  proves: string;
  /** The statement that would fix a refusal, when there is one. */
  grant?: (principal: string) => PreflightRemedy;
  /** The one or two fields of a success payload worth reporting back. */
  observe?: (body: Record<string, unknown>) => string;
  /** Human-readable object name, kept separately from the configured identifier. */
  displayName?: (body: Record<string, unknown>) => string;
  /** Type-specific scalar facts that a concise Connections row can render. */
  facts?: (body: Record<string, unknown>) => Record<string, string | number | boolean>;
  /**
   * When the content this object serves was last written, off the same payload.
   *
   * Only for objects that hold content somebody rebuilds. AN OBJECT THAT
   * ANSWERS IS NOT AN OBJECT THAT IS CURRENT, and every check above this line
   * asks only the first question: the semantic index answered every probe for
   * five days while serving vocabulary from before the rebuild job started
   * failing, and both pages read that as healthy because reachability was all
   * either of them had ever asked for.
   *
   * Returns '' where the payload carries no usable timestamp. Never a
   * substitute -- not the time of this call, not the deployment time. A reader
   * given one of those reads freshness into a field that measured nothing,
   * which is the exact fault this is here to catch.
   */
  contentAt?: (body: Record<string, unknown>) => string;
}

/** What came back, in the three shapes a caller can be in. */
export type ProbeOutcome =
  | { kind: 'answered'; status: number; body: Record<string, unknown> }
  | { kind: 'timeout'; afterMs: number }
  | { kind: 'unreachable'; message: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function compactFacts(
  entries: Record<string, string | number | boolean | null | undefined>
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([, value]) => value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length > 0)
    )
  ) as Record<string, string | number | boolean>;
}

function servingFacts(body: Record<string, unknown>): Record<string, string | number | boolean> {
  const state = record(body.state);
  const entities = Array.isArray(body.served_entities) ? body.served_entities.map(record) : [];
  const routes = Array.isArray(record(body.traffic_config).routes)
    ? (record(body.traffic_config).routes as unknown[]).map(record)
    : [];
  const servedModel = entities
    .map((entity) => {
      const name = text(entity.entity_name) || text(entity.name);
      const version = text(entity.entity_version);
      return [name, version && `v${version}`].filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join(', ');
  const traffic = routes
    .map((route) => {
      const name = text(route.served_model_name);
      const percentage =
        typeof route.traffic_percentage === 'number' && Number.isFinite(route.traffic_percentage)
          ? `${route.traffic_percentage}%`
          : '';
      return [name, percentage].filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join(', ');
  return compactFacts({ readiness: text(state.ready), served_model: servedModel, traffic });
}

/** The configuration entry the orchestrator reported for one of its settings. */
function setting(configuration: readonly PreflightConfiguration[], key: string): unknown {
  return configuration.find((entry) => entry.key === key)?.value;
}

/**
 * A remedy, with guidance only where the statement is not enough on its own.
 *
 * `guidance` DEFAULTS TO NOTHING, which is the answer for most of these. See
 * `DiagnosisRemedy.guidance` for the test it has to pass; the short version is
 * that a sentence saying what kind of object the statement acts on does not
 * change whether the statement works, and five of these grants carried one.
 */
function sql(statement: string, guidance = ''): PreflightRemedy {
  return { kind: 'sql', statement, guidance };
}

function cli(statement: string, guidance = ''): PreflightRemedy {
  return { kind: 'cli', statement, guidance };
}

/**
 * A principal in the form a GRANT accepts.
 *
 * Backticks rather than quotes, and the value is the identity the probe ran as,
 * so a remedy always names the person who was refused rather than a placeholder
 * they have to substitute themselves.
 */
function granteeFor(principal: string): string {
  return principal ? `\`${principal}\`` : '`<the signed-in user>`';
}

const READS_METADATA = 'GET, as the signed-in user';

/** The tables the served model version declared as resources, if it said. */
export function declaredTables(configuration: readonly PreflightConfiguration[]): string[] {
  return list(setting(configuration, 'declared_manifest'));
}

/** The kind every serving-endpoint probe is stamped with. Never one of their ids. */
export const SERVING_ENDPOINT_KIND = 'serving-endpoint';

/**
 * Every serving endpoint this deployment can be asked about, and which of them
 * an answer has to travel through.
 *
 * ONE TABLE, BECAUSE TWO SURFACES READ IT. The probes are built from it here and
 * the Ops health pill resolves itself from `ANSWER_PATH_ENDPOINT_IDS` below, so
 * renaming an entry moves both at once. They used to be a loop here and a
 * literal there, and the literal was the KIND rather than any id: the pill
 * reported "Not checked" on every check of a deployment whose endpoint was
 * answering, because the id it asked for was not one any row carried.
 *
 * `onAnswerPath` is the property that decides which endpoints may speak for the
 * pill, and it is a property rather than an order because the reason is not
 * preference. The judge is reached only from the Benchmark Lab, and a gateway
 * route is unset on most deployments; neither says anything about whether a
 * question could be answered, so neither may report that one could.
 */
const SERVING_ENDPOINTS = [
  {
    id: 'agent-endpoint',
    label: 'Orchestrator serving endpoint',
    onAnswerPath: true,
    note: 'Every question the app asks goes through this endpoint.',
  },
  {
    id: 'llm-endpoint',
    label: 'Foundation model',
    onAnswerPath: true,
    note: 'The orchestrator reasons and writes with this endpoint.',
  },
  {
    id: 'llm-gateway',
    label: 'AI Gateway',
    onAnswerPath: false,
    note: 'Model calls are routed through this gateway when one is configured.',
  },
  {
    id: 'judge-endpoint',
    label: 'Benchmark judge model',
    onAnswerPath: false,
    note: 'The Benchmark Lab scores answers with this endpoint. It is never on the answer path.',
  },
] as const;

/** The endpoints whose state the Ops health pill is allowed to report. */
export const ANSWER_PATH_ENDPOINT_IDS: readonly string[] = SERVING_ENDPOINTS.filter(
  (endpoint) => endpoint.onAnswerPath
).map((endpoint) => endpoint.id);

/**
 * Every subject this deployment has a configured value for.
 *
 * `configured` is keyed by registry id and holds THE VALUE THE ROW SHOWS, which
 * is the resolved one: the artifact's for everything the orchestrator owns, and
 * for the two the app owns, a saved override ahead of the variable ahead of the
 * compiled default. Probing anything else would answer a question about a value
 * the reader cannot see, which on this page of all pages is worse than not
 * answering.
 *
 * A resource with nothing configured produces NO subject and therefore no check,
 * which leaves its row saying what it said before rather than inventing a
 * failure for a value nobody set. `llm_gateway` is the case that makes this
 * load-bearing: unset is its correct and default state on every target, and a
 * deployment in exactly the shape its bundle asked for must not read as broken.
 */
export function connectionSubjects(input: {
  /** Registry id to the configured value the page shows for it. */
  configured: Readonly<Record<string, string>>;
  /** Fully-qualified names from the model version's declared manifest. */
  tables: readonly string[];
}): ProbeSubject[] {
  const value = (id: string) => (input.configured[id] ?? '').trim();
  const subjects: ProbeSubject[] = [];

  const warehouse = value('sql-warehouse');
  if (warehouse) {
    subjects.push({
      id: 'sql-warehouse',
      kind: 'sql-warehouse',
      name: warehouse,
      label: `SQL warehouse \u00b7 ${warehouse}`,
      path: `/api/2.0/sql/warehouses/${encodeURIComponent(warehouse)}`,
      proves:
        'It does not prove a statement would run: CAN_USE on the warehouse and SELECT on the tables ' +
        'are separate grants, and a stopped warehouse still answers this call.',
      observe: (body) => {
        const state = text(body.state);
        const name = text(body.name);
        return [name && `named \u201c${name}\u201d`, state && `state ${state}`].filter(Boolean).join(', ');
      },
      displayName: (body) => text(body.name),
      facts: (body) =>
        compactFacts({
          display_name: text(body.name),
          state: text(body.state),
          warehouse_type: text(body.warehouse_type),
          cluster_size: text(body.cluster_size),
        }),
      grant: (principal) =>
        // No guidance. What stood here said a warehouse is a workspace object
        // rather than a Unity Catalog one, which is why the fix is an API call
        // rather than a GRANT. True, and it explains the statement the reader
        // has already been given rather than telling them anything they need in
        // order to run it.
        cli(
          `databricks permissions update warehouses ${warehouse} --json '` +
            `{"access_control_list":[{"user_name":"${principal || '<the signed-in user>'}",` +
            `"permission_level":"CAN_USE"}]}'`
        ),
    });
  }

  for (const [id, label] of [
    ['genie-data', 'Data Genie space'],
    ['genie-dictionary', 'Dictionary Genie space'],
  ] as const) {
    const space = value(id);
    if (!space) continue;
    subjects.push({
      id,
      kind: 'genie-space',
      name: space,
      label: `${label} \u00b7 ${space}`,
      path: `/api/2.0/genie/spaces/${encodeURIComponent(space)}`,
      proves:
        'It does not prove a question would be answered: a space someone can open can still be ' +
        'backed by tables they cannot read, and CAN RUN is a separate grant from CAN VIEW.',
      observe: (body) => {
        const title = text(body.title);
        return title ? `titled \u201c${title}\u201d` : '';
      },
      displayName: (body) => text(body.title),
      facts: (body) => {
        const dataSources = record(body.data_sources);
        const tables = Array.isArray(dataSources.tables)
          ? dataSources.tables.length
          : Array.isArray(body.tables)
            ? body.tables.length
            : null;
        return compactFacts({
          display_name: text(body.title),
          warehouse_id: text(body.warehouse_id),
          table_count: tables,
        });
      },
      grant: (principal) =>
        // No guidance. The dropped sentence said the tables behind a space are
        // granted separately in Unity Catalog, which is a real fact and one this
        // page states better elsewhere: those tables are probed in their own
        // right and get their own rows, so a reader who needs it is told by the
        // report rather than by an aside on a different row.
        cli(
          `databricks permissions update genie ${space} --json '` +
            `{"access_control_list":[{"user_name":"${principal || '<the signed-in user>'}",` +
            `"permission_level":"CAN_RUN"}]}'`
        ),
    });
  }

  const catalog = value('catalog');
  if (catalog) {
    subjects.push({
      id: 'catalog',
      kind: 'catalog',
      name: catalog,
      label: `Catalog \u00b7 ${catalog}`,
      path: `/api/2.1/unity-catalog/catalogs/${encodeURIComponent(catalog)}`,
      proves: 'Every schema and table inside it is granted separately, so this covers the container only.',
      observe: (body) => {
        const owner = text(body.owner);
        return owner ? `owned by ${owner}` : '';
      },
      grant: (principal) =>
        // No guidance. "It grants nothing on the schemas or tables inside it" is
        // the `proves` line above, said again beside the statement.
        sql(`GRANT USE CATALOG ON CATALOG ${catalog} TO ${granteeFor(principal)};`),
    });
  }

  const schema = value('schema');
  if (catalog && schema) {
    const full = `${catalog}.${schema}`;
    subjects.push({
      id: 'schema',
      kind: 'schema',
      name: full,
      label: `Schema \u00b7 ${full}`,
      path: `/api/2.1/unity-catalog/schemas/${encodeURIComponent(full)}`,
      proves: 'Each table inside it is granted separately, so this covers the container only.',
      observe: (body) => {
        const owner = text(body.owner);
        return owner ? `owned by ${owner}` : '';
      },
      grant: (principal) =>
        // No guidance, on the same reasoning as the catalog above.
        sql(`GRANT USE SCHEMA ON SCHEMA ${full} TO ${granteeFor(principal)};`),
    });
  }

  // Every table the model version declared as a resource. These are what the
  // page's Unity Catalog matrix has always listed, and they went blank with the
  // rest when the endpoint stopped reporting: the matrix is driven by checks of
  // kind `table`, so answering for them here fills it again.
  for (const table of input.tables) {
    subjects.push({
      id: `table:${table}`,
      kind: 'table',
      name: table,
      label: table,
      path: `/api/2.1/unity-catalog/tables/${encodeURIComponent(table)}`,
      proves:
        'It reads the table\u2019s definition, not its rows. Row filters and column masks are applied ' +
        'when data is read and are invisible to this call.',
      observe: (body) => {
        const columns = Array.isArray(body.columns) ? body.columns.length : 0;
        return columns ? `${columns} columns` : '';
      },
      grant: (principal) =>
        // KEPT. This is the one probe grant whose statement is not sufficient on
        // its own: Unity Catalog hides an object the caller cannot traverse, so
        // a SELECT granted without USE CATALOG and USE SCHEMA leaves the table
        // reading as missing and the row still red. A reader who runs the one
        // statement has every reason to believe they are done, and finds out
        // otherwise only by coming back. Two further grants is a real cost.
        sql(
          `GRANT SELECT ON TABLE ${table} TO ${granteeFor(principal)};`,
          'This is not enough on its own: the holder also needs USE CATALOG and USE SCHEMA on the ' +
            'two containers above it.'
        ),
    });
  }

  for (const { id, label, note } of SERVING_ENDPOINTS) {
    const endpoint = value(id);
    // A gateway route is a URL on some deployments and an endpoint name on
    // others. Only a bare name can be asked about here, and guessing at the
    // endpoint behind a URL would produce a verdict about something this call
    // never reached.
    if (!endpoint || endpoint.includes('/')) continue;
    subjects.push(servingEndpointSubject(id, label, endpoint, note));
  }

  const index = resolveSemanticIndexValue(value('semantic-index'), value('catalog'), value('schema'));
  // `true` with no catalog/schema is still a decision rather than a name, and
  // is left to withSemanticFollowUps. When catalog and schema are known, the
  // derived three-level name is asked about here — the same spelling the agent
  // logged.
  if (index && index.includes('.')) {
    subjects.push({
      id: 'semantic-index',
      kind: 'vector-index',
      name: index,
      label: `Vector Search index \u00b7 ${index}`,
      path: `/api/2.0/vector-search/indexes/${encodeURIComponent(index)}`,
      proves:
        'It does not prove a search would return anything: an index that exists can still be empty ' +
        'or behind on its sync.',
      observe: (body) => {
        const endpoint = text(body.endpoint_name);
        const state = text((body.status as Record<string, unknown> | undefined)?.detailed_state);
        return [endpoint && `served by ${endpoint}`, state && `state ${state}`].filter(Boolean).join(', ');
      },
      displayName: (body) => text(body.name),
      facts: (body) => {
        const status = record(body.status);
        const delta = record(body.delta_sync_index_spec);
        return compactFacts({
          display_name: text(body.name),
          endpoint: text(body.endpoint_name),
          state: text(status.detailed_state),
          index_type: text(body.index_type) || text(delta.pipeline_type),
          source_table: text(delta.source_table),
        });
      },
      contentAt: (body) => indexContentAt(body),
      // NOW A GRANT, which is what this row always claimed to be offering. What
      // stood here was a `databricks api get` against the index -- the same call
      // that had just been refused -- with a sentence underneath admitting it
      // granted nothing and telling the reader to grant SELECT themselves. It
      // was left that way because "what the right grant is for an index" was
      // called a question about the platform rather than about this copy.
      //
      // The platform has now answered it, on the live index: an index is a Unity
      // Catalog securable whose `securable_type` is TABLE and whose
      // `securable_kind` is TABLE_ONLINE_VECTOR_INDEX_REPLICA, and
      // effective-permissions resolves SELECT on it under the `table` securable
      // path. So the statement is the ordinary table grant, against the index's
      // own three-level name, and the guidance is the same one the declared
      // tables carry -- for the same reason, which is that Unity Catalog hides
      // an object the caller cannot traverse and a SELECT on its own leaves the
      // row red.
      grant: (principal) =>
        sql(
          `GRANT SELECT ON TABLE ${index} TO ${granteeFor(principal)};`,
          'This is not enough on its own: the holder also needs USE CATALOG and USE SCHEMA on the ' +
            'catalog and schema the index sits in.'
        ),
    });
  }

  return subjects;
}

/**
 * When the index last took content from the table behind it.
 *
 * The Vector Search payload reports this as the source commit the sync last
 * processed, under whichever of the two update blocks matches the pipeline
 * type, so both are read and neither is preferred: a TRIGGERED index has the
 * first and a CONTINUOUS one has the second.
 *
 * IT IS THE AGE OF THE CONTENT AND NOT OF THE OBJECT, which is what makes it
 * worth reading. The rebuild job writes the source table and then asks for a
 * sync; a job that fails writes no commit, so this timestamp stops moving while
 * the index goes on answering every probe perfectly.
 *
 * '' unless the value parses as a date. A string the workspace sent that is not
 * a time is not a time, and passing it on would put whatever it is into a field
 * every reader treats as one.
 */
function indexContentAt(body: Record<string, unknown>): string {
  const status = (body.status as Record<string, unknown> | undefined) ?? {};
  for (const key of ['triggered_update_status', 'continuous_update_status'] as const) {
    const stamp = text((status[key] as Record<string, unknown> | undefined)?.last_processed_commit_timestamp);
    if (stamp && !Number.isNaN(new Date(stamp).getTime())) return stamp;
  }
  return '';
}

function servingEndpointSubject(id: string, label: string, name: string, note: string): ProbeSubject {
  return {
    id,
    kind: SERVING_ENDPOINT_KIND,
    name,
    label: `${label} \u00b7 ${name}`,
    path: `/api/2.0/serving-endpoints/${encodeURIComponent(name)}`,
    proves:
      `${note} Seeing an endpoint is not being allowed to call it: CAN_VIEW and CAN_QUERY are ` +
      'separate grants, and this call needs only the first.',
    observe: (body) => {
      const state = (body.state as Record<string, unknown> | undefined) ?? {};
      const ready = text(state.ready);
      return ready ? `state ${ready}` : '';
    },
    facts: servingFacts,
    // No guidance. The dropped sentence classified the object to explain why the
    // fix is an API call; the reader is holding the API call.
    grant: (principal) =>
      cli(
        `databricks permissions update serving-endpoints ${name} --json '` +
          `{"access_control_list":[{"user_name":"${principal || '<the signed-in user>'}",` +
          `"permission_level":"CAN_QUERY"}]}'`
      ),
  };
}

/**
 * The Vector Search endpoint the index says it is served by.
 *
 * Derived from the index payload rather than from configuration, because
 * nothing this deployment is given names it: the bundle creates the endpoint and
 * the artifact records only the index. So it is asked about after the index
 * answers, and when the index does not answer there is no name to ask about and
 * the check says exactly that instead of guessing one.
 *
 * AN ENDPOINT IS NOT A UNITY CATALOG SECURABLE, and the remedy below is the only
 * thing on this row that says so. Every refusal branch in {@link probeVerdict}
 * ends by asserting that an access change fixes it -- "a grant fixes this", or
 * "leaves a grant on the object itself, which an admin adds" -- and this was the
 * one subject with no `grant` of its own, so the row asserted a fix and then
 * named none. A reader who went looking for the GRANT that sentence implies
 * would not find one: an endpoint takes CAN_USE or CAN_MANAGE through the
 * permissions API, and no `GRANT ... ON ...` statement acts on it at all.
 *
 * The id rather than the name, because that API rejects the name outright
 * ("Invalid endpoint id ... Must be a valid UUID"). It is read from the INDEX
 * payload, which carries `endpoint_id` beside `endpoint_name` -- the endpoint's
 * own payload would have it too, but a refused call returns no payload, and the
 * refusal is the only case this remedy is for. A payload that names the endpoint
 * without identifying it yields no remedy rather than a statement that cannot
 * run.
 */
export function vectorEndpointSubject(indexBody: Record<string, unknown>): ProbeSubject | null {
  const endpoint = text(indexBody.endpoint_name);
  if (!endpoint) return null;
  const endpointId = text(indexBody.endpoint_id);
  return {
    id: 'semantic-index-endpoint',
    kind: 'vector-endpoint',
    name: endpoint,
    label: `Vector Search endpoint \u00b7 ${endpoint}`,
    path: `/api/2.0/vector-search/endpoints/${encodeURIComponent(endpoint)}`,
    proves: 'It does not prove a search would return anything; it says the endpoint serving the index exists.',
    observe: (body) => {
      const status = (body.endpoint_status as Record<string, unknown> | undefined) ?? {};
      const state = text(status.state);
      return state ? `state ${state}` : '';
    },
    facts: (body) => {
      const status = record(body.endpoint_status);
      return compactFacts({
        state: text(status.state),
        endpoint_type: text(body.endpoint_type),
      });
    },
    grant: endpointId
      ? (principal) =>
          cli(
            `databricks permissions update vector-search-endpoints ${endpointId} --json '` +
              `{"access_control_list":[{"user_name":"${principal || '<the signed-in user>'}",` +
              `"permission_level":"CAN_USE"}]}'`,
            'This endpoint is not a Unity Catalog securable, so no GRANT reaches it.'
          )
      : undefined,
  };
}

/** Whether the workspace's own error code says this was a refusal. */
function refused(status: number, code: string): boolean {
  return status === 403 || code === 'PERMISSION_DENIED';
}

/** Whether the workspace's own error code says the object is not there. */
function absent(status: number, code: string): boolean {
  return status === 404 || code.endsWith('_DOES_NOT_EXIST') || code === 'NOT_FOUND';
}

/**
 * Wording that means the refusal was about the READER, not about the token.
 *
 * Same list as `PERMISSION_MARKERS` in `access-verification.ts` and for the same
 * reason: `SQLSTATE: 42501` is the standard's insufficient-privilege class and
 * the prose beside it is what has been observed on the same responses. Kept
 * separate from that module's copy because these are control-plane REST
 * responses rather than SQL statement failures, and the two lists have already
 * diverged once.
 */
const GRANT_MARKERS = [
  'permission_denied',
  'does not have permission',
  'is not accessible',
  'not authorized',
  'insufficient privileges',
  'insufficient_permissions',
] as const;

/** Why one 403 happened, in the three answers that need three different people. */
export type RefusalCause =
  /** The reader lacks a grant on the object. A GRANT fixes it. */
  | { kind: 'grant'; evidence: string }
  /** The forwarded token lacks the API scope. No grant fixes it. */
  | { kind: 'scope'; scope: string; evidence: string }
  /** Neither could be established. Deliberately not resolved to the likelier one. */
  | { kind: 'undetermined' };

/**
 * The scopes a refusal names, when it names any.
 *
 * Databricks answers a scope-limited call with `Provided OAuth token does not
 * have required scopes: vector-search [Reqid: ...]`, which is the only place in
 * the whole exchange the distinction is visible, so it is read rather than
 * flattened into "denied". The reqid tail is dropped; a comma-separated list is
 * kept whole.
 */
export function scopesFromRefusal(message: string): string[] {
  const named = /required scopes?:\s*([^[\]\n]+)/i.exec(message);
  if (!named) return [];
  return named[1]
    .split(/[,\s]+/)
    .map((entry) => entry.trim().replace(/[.;]+$/, ''))
    .filter(Boolean);
}

/**
 * Which of the three a 403 was, from the response and from the token itself.
 *
 * TWO INDEPENDENT WITNESSES, because either can be silent. The response is the
 * better one where it speaks: the Vector Search index refusal said "does not
 * have required scopes" in as many words. But the Unity Catalog refusals on the
 * same page arrived as a bare `HTTP 403` with no code and no body, which is why
 * every one of them was read as a missing grant. The forwarded token answers
 * that case: it is a JWT carrying its own `scope` claim, so a call refused for a
 * scope the token demonstrably does not hold is a scope problem WITH EVIDENCE,
 * not a guess.
 *
 * `scopeHeld` is three-valued on purpose. `null` means the token did not
 * enumerate its scopes (a PAT, an opaque token, a claim shape this does not
 * recognise), and reading that silence as "the scope is absent" would replace
 * one confident wrong remedy with another, pointed the other way.
 */
export function refusalCause(input: {
  message: string;
  code: string;
  /** The scope this call's API family needs, from {@link scopeForPath}. */
  scope: string;
  /** Whether the token holds it: `null` when the token did not say. */
  scopeHeld: boolean | null;
}): RefusalCause {
  const named = scopesFromRefusal(input.message);
  if (named.length > 0 || looksLikeMissingScope(input.message)) {
    return {
      kind: 'scope',
      scope: named[0] || input.scope,
      evidence: `the workspace said so: ${input.message}`,
    };
  }
  if (input.scope && input.scopeHeld === false) {
    return {
      kind: 'scope',
      scope: input.scope,
      evidence:
        'the response did not say why, but the forwarded token lists its own scopes and ' +
        `\`${input.scope}\` is not among them`,
    };
  }
  const wording = input.message.toLowerCase();
  const saysPermission = input.code === 'PERMISSION_DENIED' || GRANT_MARKERS.some((marker) => wording.includes(marker));
  if (saysPermission) {
    return {
      kind: 'grant',
      evidence: input.scopeHeld
        ? `the workspace named a permission, and the forwarded token does carry \`${input.scope}\`, ` +
          'so the scope is not what was missing'
        : 'the workspace answered in terms of a permission rather than of a scope',
    };
  }
  if (input.scopeHeld === true) {
    return {
      kind: 'grant',
      evidence:
        `the workspace gave no reason, but the forwarded token carries \`${input.scope}\`, so the ` +
        'scope is ruled out and a grant is what is left',
    };
  }
  return { kind: 'undetermined' };
}

function check(subject: ProbeSubject, over: Partial<PreflightCheck>): PreflightCheck {
  const built: PreflightCheck = {
    id: subject.id,
    kind: subject.kind,
    name: subject.name,
    label: subject.label,
    status: 'unverified',
    // NOBODY ASKED, unless the branch says otherwise. Every `unverified` return
    // in this file states which of the three ways it got there, because "we were
    // told no", "the call broke" and "we never ran it" need three different next
    // moves and the status cannot tell them apart. See
    // `shared/check-verdict.ts`.
    stopped: 'unasked',
    detail: '',
    checked_with: `${READS_METADATA}: ${subject.path}`,
    duration_ms: 0,
    error: '',
    remedy: null,
    ...over,
  };
  // A check that reached a verdict has nothing to say about how it stopped, and
  // shipping the default beside `ok` would be a claim about a call that answered.
  if (built.status !== 'unverified') delete built.stopped;
  return built;
}

/**
 * One outcome, turned into the verdict a reader sees. No IO, so every rule about
 * what counts as reachable is testable without a workspace.
 *
 * `principal` is who the call was made as. It is named in the detail rather than
 * left implied, because the answer is about that person's grants and a reader
 * comparing two accounts has to be able to tell which one they are looking at.
 */
export function probeVerdict(input: {
  subject: ProbeSubject;
  outcome: ProbeOutcome;
  principal: string;
  durationMs?: number;
  /**
   * The scopes the forwarded token carries, or `null` when it did not say.
   *
   * The second witness in {@link refusalCause}, and the one that rescues the
   * refusals that arrive bare. Omitted by callers that have no token to read,
   * which is the same as `null`: unknown, not empty.
   */
  tokenScopes?: string[] | null;
  /**
   * The `user_api_scopes` this deployment declares, or `null` when unknown.
   *
   * The fact that separates a sign-in behind the app from a permission the app
   * never asked for. Those two need different people and the old code picked
   * between them with nothing to go on. Omitted is `null`, which is honest and
   * costs the row its remedy; see `scope-refusal.ts`.
   */
  declaredScopes?: string[] | null;
}): PreflightCheck {
  const { subject, outcome, principal } = input;
  const durationMs = input.durationMs ?? 0;
  const who = principal ? ` as ${principal}` : '';

  if (outcome.kind === 'timeout') {
    return check(subject, {
      status: 'unverified',
      stopped: 'unreachable',
      duration_ms: durationMs,
      detail:
        `The workspace did not answer within ${outcome.afterMs} ms, so whether this identity can ` +
        'reach it is unknown rather than settled. A slow answer is not a refusal.',
      error: `no answer within ${outcome.afterMs} ms`,
    });
  }

  if (outcome.kind === 'unreachable') {
    return check(subject, {
      status: 'unverified',
      stopped: 'unreachable',
      duration_ms: durationMs,
      detail:
        'The workspace could not be asked about this one, so nothing was established either way. ' +
        'This says nothing about the object and everything about the call.',
      error: outcome.message,
    });
  }

  const { status, body } = outcome;
  const code = text(body.error_code);
  const message = text(body.message);

  if (status >= 200 && status < 300) {
    const observed = subject.observe?.(body) ?? '';
    // The content's age, for the subjects that have content. Said in the detail
    // as well as carried in the field, so the Connections row states it in the
    // same words the Architecture card is drawn from -- one reading, two
    // surfaces, rather than two readings that agree on the day they are written.
    const contentAt = subject.contentAt ? subject.contentAt(body) : '';
    const freshness = !subject.contentAt
      ? ''
      : contentAt
        ? `It last took content from its source at ${contentAt}. `
        : 'The workspace reported no time for when it last took content from its source, so the ' +
          'age of what it serves is not established here. ';
    return check(subject, {
      status: 'ok',
      display_name: subject.displayName?.(body) || undefined,
      facts: subject.facts?.(body),
      duration_ms: durationMs,
      content_at: contentAt,
      detail:
        `The workspace answered${who}${observed ? `: ${observed}` : ''}. ${freshness}That is a ` +
        `metadata read. ${subject.proves}`,
    });
  }

  if (refused(status, code)) {
    const scope = scopeForPath(subject.path);
    const tokenScopes = input.tokenScopes ?? null;
    // Three-valued, so a scope claim written in a vocabulary this module does
    // not recognise stands the inference down instead of being read as proof of
    // absence. See `tokenScopeVerdict`.
    const scopeHeld = tokenScopes === null ? null : tokenScopeVerdict(tokenScopes, scope);
    const cause = refusalCause({ message, code, scope, scopeHeld });
    const refusal = `HTTP ${status}${code ? ` ${code}` : ''}`;

    // A SCOPE REFUSAL IS NOT THE READER'S PROBLEM, and it is reported as
    // `unverified` rather than `failed` for that reason: the call never got far
    // enough to establish anything about whether this identity can reach the
    // object, so a red row saying they cannot is an assertion nobody made.
    if (cause.kind === 'scope') {
      // WHICH OF THESE IT IS COMES FROM TWO LISTS, NOT FROM A GUESS. The
      // sentence that used to stand here said "it is the app that is short of a
      // scope, not the reader of a grant" and had read nothing that could know
      // it. The deployment's own `user_api_scopes` says whether the app asks for
      // the permission at all, and the presented token says whether this sign-in
      // carries it; between them they separate a stale sign-in, an undeclared
      // scope and a missing grant. Everything about the wording, the remedy and
      // the evidence lives in `scope-refusal.ts`, next to the audit that holds
      // the prose against the values behind it.
      const declarable = scope || cause.scope;
      // The token verdict computed above, handed over rather than recomputed.
      // Without it this diagnosis decided which scope problem it was from the
      // declared list alone, so a reader whose sign-in plainly listed the scope
      // was told it did not carry one and sent to a private window that could
      // not help. Two readers of one 403 disagreeing is the defect; one reading,
      // passed along, is the fix.
      const diagnosis = scopeRefusalDiagnosis({
        declarable,
        namedByWorkspace: cause.scope,
        declared: input.declaredScopes ?? null,
        tokenScopes,
        scopeHeld,
      });
      // A HELD SCOPE TURNS THIS BACK INTO A GRANT, and with it the status. The
      // scope branch is `unverified` because a call refused before it reached
      // the object establishes nothing about whether this identity can reach it;
      // once the token itself rules the scope out, the refusal does establish
      // that, so the row is a failure with the grant behind it. The statement
      // comes from the subject, which is the only thing here that knows the
      // object and the principal to name.
      if (diagnosis.grantIsMissing) {
        return check(subject, {
          status: 'failed',
          duration_ms: durationMs,
          detail: `${refusal}. ${diagnosis.explanation}`,
          error: message || refusal,
          remedy: subject.grant?.(principal) ?? null,
        });
      }
      return check(subject, {
        status: 'unverified',
        // WE ASKED AND WERE TOLD NO, which is not the same as nobody having
        // asked, and the row said the second for as long as the two shared a
        // word. Still `unverified`, because the refusal landed on the scope
        // rather than on the object and so settled nothing about whether this
        // identity can reach it.
        stopped: 'refused',
        // WHICH PERMISSION, carried as a value so a surface does not have to
        // read the sentence back to find out. This is the one branch that
        // established a scope was implicated, so it is the only one that sets
        // it: the grant branch above has ruled the scope OUT, and the
        // undetermined branch below established nothing. The Connections panel
        // reads it against `shared/optional-user-api-scopes.ts` to keep a
        // shortfall in an optional catalog read out of "What to fix".
        scope: declarable,
        duration_ms: durationMs,
        // The workspace's own words first, because that is the evidence, then
        // the verdict reached from it. A reader who disagrees with the second
        // can still see the first.
        detail: `${refusal}. ${diagnosis.explanation}`,
        error: message || refusal,
        remedy: diagnosis.remedy,
      });
    }

    if (cause.kind === 'undetermined') {
      return check(subject, {
        status: 'unverified',
        // Refused, whichever of the two reasons it was. Which one is undetermined;
        // that the workspace answered no is not.
        stopped: 'refused',
        duration_ms: durationMs,
        // NAMED AS UNDETERMINED RATHER THAN RESOLVED TO THE LIKELIER ONE. The
        // page has just spent an evening proving what a confident wrong remedy
        // costs, and the two candidates here are fixed by different people. A
        // row that says which two they are is worth more than one that picks.
        detail:
          `The workspace refused the call${who} and did not say why: ${refusal}, with no message and ` +
          'no scopes readable off the token. That is one of two things and this cannot tell which: ' +
          `either ${principal || 'the signed-in user'} lacks a grant on the object, or the app's ` +
          `forwarded token lacks the \`${scope || 'required'}\` scope. Check the token's scopes first ` +
          '-- it is the cheaper of the two to rule out, and it is the one that would make every other ' +
          'row on this page wrong in the same way.',
        error: message || refusal,
        // No remedy on purpose. Either candidate printed here would be a guess
        // wearing the clothes of an instruction.
        remedy: null,
      });
    }

    return check(subject, {
      status: 'failed',
      duration_ms: durationMs,
      // Said in as many words, because the two failures have different remedies
      // and this is the one a GRANT fixes. A reader who takes a refusal for an
      // absence goes looking for a resource that is sitting right there.
      detail:
        `The workspace refused this identity${who}: ${refusal}. The object ` +
        'exists as far as this call can tell; what was established is that this identity cannot ' +
        `reach it -- ${cause.evidence}. A grant fixes this.`,
      error: message || refusal,
      remedy: subject.grant?.(principal) ?? null,
    });
  }

  if (absent(status, code)) {
    return check(subject, {
      status: 'failed',
      duration_ms: durationMs,
      detail:
        `The workspace has no such object: HTTP ${status}${code ? ` ${code}` : ''}. This is missing ` +
        'rather than forbidden, so no grant repairs it: either the value this deployment was ' +
        'configured with is wrong, or the object was removed.',
      error: message || `HTTP ${status}${code ? ` ${code}` : ''}`,
      // Deliberately none. Offering a GRANT for an object that does not exist
      // sends a deployer to an admin for a permission on nothing, and a remedy
      // that cannot work is how remedies stop being read.
      remedy: null,
    });
  }

  if (status === 401) {
    return check(subject, {
      status: 'unverified',
      // The workspace said no, about the sign-in rather than about the object.
      // A retry with the same token gets the same answer, which is what puts
      // this with the refusals rather than with the broken calls.
      stopped: 'refused',
      duration_ms: durationMs,
      detail:
        'The workspace rejected the token this call was made with, so nothing was established about ' +
        'this object. That is a problem with the sign-in rather than with the resource.',
      error: message || `HTTP ${status}`,
    });
  }

  if (status === 429 || status >= 500) {
    return check(subject, {
      status: 'unverified',
      // Answered, but not about this object. A later run may well answer, which
      // is the difference between this and a refusal.
      stopped: 'unreachable',
      duration_ms: durationMs,
      detail:
        `The workspace answered HTTP ${status}, which is about the workspace rather than about this ` +
        'object. Nothing was established either way.',
      error: message || `HTTP ${status}`,
    });
  }

  return check(subject, {
    status: 'failed',
    duration_ms: durationMs,
    detail:
      `The workspace refused the request: HTTP ${status}${code ? ` ${code}` : ''}. A malformed ` +
      'identifier answers this way, so the configured value is the first thing to read.',
    error: message || `HTTP ${status}`,
  });
}

/** The verdict for every subject when the app cannot ask anything at all. */
export function unaskedChecks(subjects: readonly ProbeSubject[], reason: string): PreflightCheck[] {
  return subjects.map((subject) =>
    check(subject, {
      status: 'unverified',
      stopped: 'unasked',
      detail: `${reason} So this is unchecked rather than unreachable: nobody asked.`,
      error: '',
    })
  );
}

export interface ProbeOptions {
  /** The workspace, normalised, or '' when the container was given none. */
  host: string;
  /** The signed-in user's forwarded token, or null when the request carried none. */
  token: string | null;
  /** Who that token belongs to, for the detail and the remedy. */
  principal: string;
  /**
   * The `user_api_scopes` this deployment declares, for a scope refusal.
   *
   * Defaults to the container's own declaration. Overridable so a test can put
   * a deployment in either state without an environment, and so a caller that
   * knows better can say so.
   */
  declaredScopes?: string[] | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Optional deadline shared by a whole manual probe run. */
  signal?: AbortSignal;
  /** Maximum probes in flight. Omitted preserves the normal fully-concurrent read. */
  concurrency?: number;
}

/**
 * Ask the workspace about one subject. Never throws.
 *
 * A probe that threw would take down the settings route, and the settings route
 * is what somebody opens to find out why the rest of the app is misbehaving. So
 * the failure of a probe is a verdict like any other, and it is `unverified`,
 * because a call that did not complete established nothing.
 */
export async function runProbe(subject: ProbeSubject, options: ProbeOptions): Promise<PreflightCheck> {
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const started = Date.now();
  const tokenScopes = options.token ? scopesFromToken(options.token) : null;
  const declaredScopes = options.declaredScopes === undefined ? declaredUserApiScopes() : options.declaredScopes;
  const finish = (outcome: ProbeOutcome) =>
    probeVerdict({
      subject,
      outcome,
      principal: options.principal,
      durationMs: Date.now() - started,
      tokenScopes,
      declaredScopes,
    });

  try {
    const probeTimeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, probeTimeout]) : probeTimeout;
    const response = await call(`${options.host}${subject.path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.token ?? ''}` },
      signal,
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return finish({ kind: 'answered', status: response.status, body: body ?? {} });
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return finish({ kind: 'timeout', afterMs: timeoutMs });
    return finish({ kind: 'unreachable', message: (error as Error)?.message ?? String(error) });
  }
}

/**
 * Every probe, at once.
 *
 * CONCURRENT ON PURPOSE, and it is the difference between a page and a wait: run
 * one after another, a deployment with twelve declared tables pays twelve round
 * trips before anything renders, and one warehouse waking up holds all of them.
 * `allSettled` rather than `all` for the same reason `runProbe` swallows: one
 * subject cannot be allowed to decide whether the other twenty are reported.
 */
export async function runProbes(subjects: readonly ProbeSubject[], options: ProbeOptions): Promise<PreflightCheck[]> {
  if (subjects.length === 0) return [];
  const limit = Math.max(1, Math.min(subjects.length, Math.floor(options.concurrency ?? subjects.length)));
  const results: Array<PreflightCheck | undefined> = Array.from({ length: subjects.length });
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (next < subjects.length) {
      const index = next;
      next += 1;
      results[index] = await runProbe(subjects[index], options);
    }
  });
  await Promise.allSettled(workers);
  return results.map(
    (result, index) =>
      result ??
      probeVerdict({
        subject: subjects[index],
        outcome: { kind: 'unreachable', message: 'The bounded probe worker stopped before this check ran.' },
        principal: options.principal,
        tokenScopes: options.token ? scopesFromToken(options.token) : null,
        declaredScopes: options.declaredScopes === undefined ? declaredUserApiScopes() : options.declaredScopes,
      })
  );
}

/**
 * A configured index of `true` (or an empty value when catalog+schema are
 * known) turned into the three-level name the agent would derive.
 *
 * Empty is a CANDIDATE: many releases search an index the app container was
 * never told about. It is probed, and a miss is dropped rather than shown as
 * Blocked, so a deployment that genuinely has no semantic layer stays unset.
 * `true` is a decision to use that name, so a miss stays a miss.
 */
function withDerivedSemanticIndex(configured: Readonly<Record<string, string>>): {
  configured: Record<string, string>;
  indexIsCandidate: boolean;
} {
  const next = { ...configured };
  const raw = (next['semantic-index'] ?? '').trim();
  const derived = derivedSemanticIndexName(next.catalog ?? '', next.schema ?? '');
  if (!raw) {
    if (!derived) return { configured: next, indexIsCandidate: false };
    next['semantic-index'] = derived;
    return { configured: next, indexIsCandidate: true };
  }
  const resolved = resolveSemanticIndexValue(raw, next.catalog ?? '', next.schema ?? '');
  if (resolved.includes('.')) next['semantic-index'] = resolved;
  return { configured: next, indexIsCandidate: false };
}

/**
 * The whole answer for one request: which subjects this deployment has, and what
 * the workspace said about each of them to this person.
 *
 * The two "cannot ask" cases are reported rather than skipped. A page that
 * silently omits a check it could not run is indistinguishable from one where
 * the check passed, and the missing-token case in particular is a real
 * deployment state -- the app runs on behalf of the signed-in user, and a token
 * that never arrived is the explanation for a page full of unknowns.
 */
export async function probeConnections(input: {
  configured: Readonly<Record<string, string>>;
  tables: readonly string[];
  host: string;
  token: string | null;
  principal: string;
  /** See {@link ProbeOptions}. Defaults to what the container was told. */
  declaredScopes?: string[] | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  concurrency?: number;
}): Promise<PreflightCheck[]> {
  const resolved = withDerivedSemanticIndex(input.configured);
  const configured = resolved.configured;
  const subjects = connectionSubjects({ ...input, configured });
  if (subjects.length === 0) return [];
  const settle = (checks: PreflightCheck[]) => {
    let next = checks;
    if (resolved.indexIsCandidate) {
      const indexCheck = next.find((entry) => entry.id === 'semantic-index');
      if (indexCheck?.status !== 'ok') {
        next = next.filter((entry) => entry.id !== 'semantic-index' && entry.id !== 'semantic-index-endpoint');
        return withSemanticFollowUps(withManifestRollup(next), input.configured);
      }
    }
    return withSemanticFollowUps(withManifestRollup(next), configured);
  };
  if (!input.host) {
    return settle(
      unaskedChecks(
        subjects,
        'The app container was given no DATABRICKS_HOST, so it does not know which workspace to ask.'
      )
    );
  }
  if (!input.token) {
    return settle(
      unaskedChecks(
        subjects,
        'This request carried no signed-in user token, and these answers are about the signed-in ' +
          'user\u2019s own grants rather than the app\u2019s.'
      )
    );
  }

  const options: ProbeOptions = {
    host: input.host,
    token: input.token,
    principal: input.principal,
    declaredScopes: input.declaredScopes,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    concurrency: input.concurrency,
  };
  const checks = await runProbes(subjects, options);

  // The Vector Search endpoint, which only the index payload can name. Asked
  // second because there is nothing to ask until the index answers, and skipped
  // rather than guessed when it did not.
  const indexCheck = checks.find((entry) => entry.id === 'semantic-index');
  if (indexCheck?.status === 'ok') {
    const indexSubject = subjects.find((subject) => subject.id === 'semantic-index');
    if (indexSubject) {
      const body = await readIndexBody(indexSubject, options);
      const endpointSubject = body ? vectorEndpointSubject(body) : null;
      if (endpointSubject) checks.push(await runProbe(endpointSubject, options));
    }
  }

  return settle(checks);
}

/**
 * The two semantic rows that no probe reaches, told why rather than left blank.
 *
 * BOTH USED TO READ `Not checked` WITH THE GENERIC NOTE, which says nobody has
 * looked yet -- and on this deployment nobody ever would, so the row promised a
 * verdict that was never coming. There is a reason in each case and the app
 * holds it, so it is stated as a check that ran and could not decide, which is
 * what happened.
 *
 * Neither is a probe. They make no call, they cannot contradict one, and they
 * are only added where nothing else answered for the row: a real refusal or a
 * real pass always wins, because those were measured.
 */
export function withSemanticFollowUps(
  checks: PreflightCheck[],
  configured: Readonly<Record<string, string>>
): PreflightCheck[] {
  const index = (configured['semantic-index'] ?? '').trim();
  if (!index) return checks;
  const answered = (id: string) => checks.some((check) => check.id === id);
  const added: PreflightCheck[] = [];

  // `true` is a decision to derive the name from the catalog and schema, taken
  // inside the orchestrator. The app is not told the result, so it has no
  // three-level name to GET -- which is a different fact from nobody having
  // looked, and re-logging the model reports the resolved name.
  if (!index.includes('.') && !answered('semantic-index')) {
    added.push({
      id: 'semantic-index',
      kind: 'vector-index',
      name: '',
      label: 'Vector Search index',
      status: 'unverified',
      // No call was made, because there was no three-level name to make one
      // against. Nobody asked, which is exactly what the word says.
      stopped: 'unasked',
      detail:
        `This release searches an index, but the served model version reports the setting as ` +
        `\u201c${index}\u201d rather than as the resolved three-level name, so there is no object ` +
        'to ask about. Re-logging the model reports the name it resolved.',
      checked_with: 'the orchestrator\u2019s reported configuration',
      duration_ms: 0,
      error: '',
      remedy: null,
    });
  }

  // Only the index payload names its endpoint, so an index that did not answer
  // takes its endpoint's name with it. Recorded as the reason rather than left
  // to the generic note, which would say nobody looked when somebody did.
  const indexVerdict = checks.find((check) => check.id === 'semantic-index');
  if (!answered('semantic-index-endpoint') && indexVerdict?.status !== 'ok') {
    added.push({
      id: 'semantic-index-endpoint',
      kind: 'vector-endpoint',
      name: '',
      label: 'Vector Search endpoint',
      status: 'unverified',
      // Whatever stopped the index stopped this, so it says what the index says
      // rather than inventing a reason of its own. `unasked` where the index
      // never reported one, which is the honest reading of a derivation.
      stopped: indexVerdict?.stopped ?? 'unasked',
      detail:
        'Only the index names the endpoint serving it, and the index did not answer, so there was ' +
        'nothing to ask about. Whichever statement clears the index above clears this one with it.',
      checked_with: 'derived from the index check above',
      duration_ms: 0,
      error: '',
      remedy: null,
    });
  }

  return added.length > 0 ? [...checks, ...added] : checks;
}

/**
 * One line for the Declared tables row, off the table checks already taken.
 *
 * The registry has a row for the manifest as a whole and there is no single
 * object to GET for it, so without this the one row that stands for twelve
 * answered checks is the row that still says nothing was checked. Derived rather
 * than probed: it makes no call of its own and cannot disagree with the rows it
 * summarises.
 */
export function withManifestRollup(checks: PreflightCheck[]): PreflightCheck[] {
  const tables = checks.filter((entry) => entry.kind === 'table');
  if (tables.length === 0) return checks;
  const failed = tables.filter((entry) => entry.status === 'failed');
  const unverified = tables.filter((entry) => entry.status === 'unverified');
  const status = failed.length > 0 ? 'failed' : unverified.length > 0 ? 'unverified' : 'ok';
  // TAKEN FROM THE ROWS IT SUMMARISES, not defaulted. This row read "Not checked"
  // over twelve tables the workspace had refused, which is the summary strip half
  // of the contradiction the word `stopped` exists to end. A refusal anywhere in
  // the list is what stopped the manifest; otherwise whatever the first unverified
  // table reported.
  const stopped = unverified.some((entry) => entry.stopped === 'refused')
    ? 'refused'
    : (unverified.find((entry) => entry.stopped)?.stopped ?? 'unasked');
  // THE PERMISSION THE ROLLUP INHERITED, and only where every table it is
  // summarising named the same one. This row states one thing about twelve, so
  // it may only carry a scope the whole twelve agree on: a mixed list would have
  // this row implicating a permission most of its members were not refused over.
  // Empty where anything FAILED as well, because a failure is established about
  // the object and no scope shortfall explains it away.
  const refusedScopes = new Set(unverified.map((entry) => (entry.scope ?? '').trim()));
  const scope =
    failed.length === 0 && refusedScopes.size === 1 && unverified.length === tables.length ? [...refusedScopes][0] : '';
  return [
    ...checks,
    {
      id: 'declared-manifest',
      kind: 'manifest',
      // Empty on purpose. This check summarises a list rather than reaching one
      // object, so there is no value it could report as being in use, and a
      // name here would be read as one by everything downstream.
      name: '',
      label: `Declared tables \u00b7 ${tables.length}`,
      status,
      ...(status === 'unverified' ? { stopped } : {}),
      ...(scope ? { scope } : {}),
      detail:
        failed.length > 0
          ? `${failed.length} of ${tables.length} declared tables could not be read by this identity. ` +
            'Each one is listed under Unity Catalog tables with what the workspace said about it.'
          : unverified.length > 0
            ? `${tables.length - unverified.length} of ${tables.length} declared tables answered, and ` +
              `${unverified.length} did not, so the manifest as a whole is unconfirmed rather than clear.`
            : `All ${tables.length} declared tables answered a metadata read by this identity. Row ` +
              'filters and column masks are applied when data is read and are not covered.',
      checked_with: 'derived from the table checks above',
      duration_ms: 0,
      error: '',
      remedy: null,
    },
  ];
}

/**
 * The index payload again, for its `endpoint_name` alone.
 *
 * A second GET rather than threading the body out of `runProbe`, which would
 * make every probe carry a payload for the benefit of one of them. Null on
 * anything at all, because this is a lookup for a follow-up question and not a
 * verdict: the index's own verdict has already been recorded from the first
 * call, and a failure here must not restate it as a second problem.
 */
async function readIndexBody(subject: ProbeSubject, options: ProbeOptions): Promise<Record<string, unknown> | null> {
  try {
    const call = options.fetchImpl ?? fetch;
    const response = await call(`${options.host}${subject.path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.token ?? ''}` },
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS)])
        : AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
