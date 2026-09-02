
import{appTable}from"./chunk-YKLXTEAM.mjs";var DAY_MS=864e5;var ADMIN_EMAILS_TABLE=appTable("admin_emails");var SP_ASSIGNMENTS_TABLE=appTable("sp_assignments");var SP_PERSONAS_TABLE=appTable("sp_personas");var SP_PERSONA_DEFINITIONS_TABLE=appTable("sp_persona_definitions");var USER_SPEND_CALCULATION_VERSION=1;var USER_SPEND_OVERLAP_DAYS=7;var USER_SPEND_REFRESH_INTERVAL_MS=60*60*1e3;var USER_SPEND_STALE_MS=2*60*60*1e3;var USER_SPEND_REFRESH_BATCH_DAYS=31;var USER_SPEND_LEASE_MS=10*60*1e3;var USER_SPEND_DAILY_TABLE=appTable("user_spend_daily");var USER_SPEND_REFRESH_TABLE=appTable("user_spend_refresh_state");var USER_SPEND_READ_MODEL_DDL=[`CREATE TABLE IF NOT EXISTS ${USER_SPEND_DAILY_TABLE} (
     app_scope TEXT NOT NULL,
     user_key TEXT NOT NULL,
     display_email TEXT NOT NULL,
     activity_date DATE NOT NULL,
     calculation_version INTEGER NOT NULL,
     submitted_questions INTEGER NOT NULL DEFAULT 0 CHECK (submitted_questions >= 0),
     completed_questions INTEGER NOT NULL DEFAULT 0 CHECK (completed_questions >= 0),
     run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
     active_minutes INTEGER NOT NULL DEFAULT 0 CHECK (active_minutes >= 0),
     prompt_tokens BIGINT,
     completion_tokens BIGINT,
     total_tokens BIGINT,
     token_covered_runs INTEGER,
     token_covered_questions INTEGER,
     spend_usd NUMERIC(30,12),
     spend_dbu NUMERIC(30,12),
     app_spend_usd NUMERIC(30,12),
     app_spend_dbu NUMERIC(30,12),
     spend_usd_quality TEXT NOT NULL DEFAULT 'unavailable'
       CHECK (spend_usd_quality IN ('direct', 'joined', 'allocated', 'unattributed', 'unavailable', 'partial')),
     spend_dbu_quality TEXT NOT NULL DEFAULT 'unavailable'
       CHECK (spend_dbu_quality IN ('direct', 'joined', 'allocated', 'unattributed', 'unavailable', 'partial')),
     components JSONB NOT NULL DEFAULT '{}'::jsonb,
     activity_complete BOOLEAN NOT NULL DEFAULT FALSE,
     billing_complete BOOLEAN NOT NULL DEFAULT FALSE,
     source_through TIMESTAMPTZ,
     computed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (app_scope, user_key, activity_date, calculation_version),
     CHECK (lower(user_key) = user_key),
     CHECK (jsonb_typeof(components) = 'object')
   )`,`CREATE INDEX IF NOT EXISTS user_spend_daily_date_scope_idx
     ON ${USER_SPEND_DAILY_TABLE} (activity_date, app_scope, calculation_version)`,`CREATE TABLE IF NOT EXISTS ${USER_SPEND_REFRESH_TABLE} (
     app_scope TEXT NOT NULL,
     calculation_version INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('idle', 'refreshing', 'ready', 'failed')),
     watermark_day DATE,
     overlap_from_day DATE,
     source_through TIMESTAMPTZ,
     billing_complete_through DATE,
     lease_owner TEXT,
     lease_expires_at TIMESTAMPTZ,
     started_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     error_class TEXT,
     error_at TIMESTAMPTZ,
     rows_upserted BIGINT NOT NULL DEFAULT 0,
     users_upserted BIGINT NOT NULL DEFAULT 0,
     days_upserted BIGINT NOT NULL DEFAULT 0,
     PRIMARY KEY (app_scope, calculation_version)
   )`];var diagnostics={refreshes:0,failures:0,lockContention:0,rowsUpserted:0,lastDurationMs:null};function day(value){if(value instanceof Date)return value.toISOString().slice(0,10);if(typeof value!=="string")return"";const parsed=Date.parse(`${value.slice(0,10)}T00:00:00Z`);return Number.isFinite(parsed)?new Date(parsed).toISOString().slice(0,10):""}function addDays(value,amount){return new Date(Date.parse(`${value}T00:00:00Z`)+amount*DAY_MS).toISOString().slice(0,10)}function daysBetween(from,to){return Math.max(0,Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/DAY_MS)+1)}function decimal(value){if(value===null||value==="")return null;const parsed=typeof value==="number"?value:Number(value);if(!Number.isFinite(parsed))return null;return parsed.toFixed(12)}function safeErrorClass(error){const named=error instanceof Error?error.name:"Error";return named.replace(/[^A-Za-z0-9_.-]/g,"").slice(0,80)||"Error"}function bool(value){return value===true||value==="true"||value==="t"||value===1}function integer(value){const parsed=Number(value);return Number.isFinite(parsed)?Math.max(0,Math.trunc(parsed)):0}function stamp(value){const raw=value instanceof Date?value.toISOString():typeof value==="string"?value:"";return Number.isFinite(Date.parse(raw))?new Date(raw).toISOString():null}async function transaction(connection,work){await connection.query("BEGIN");try{const result=await work();await connection.query("COMMIT");return result}catch(error){await connection.query("ROLLBACK").catch(()=>void 0);throw error}}var UPSERT_USER_SPEND_DAY_QUERY=`INSERT INTO ${USER_SPEND_DAILY_TABLE} (
  app_scope, user_key, display_email, activity_date, calculation_version,
  submitted_questions, completed_questions, run_count, active_minutes,
  prompt_tokens, completion_tokens, total_tokens, token_covered_runs, token_covered_questions, spend_usd, spend_dbu,
  app_spend_usd, app_spend_dbu,
  spend_usd_quality, spend_dbu_quality,
  components, activity_complete, billing_complete, source_through, computed_at, updated_at
) VALUES (
  $1, lower($2), $3, $4::date, $5,
  $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::numeric, $16::numeric,
  $17::numeric, $18::numeric, $19, $20, $21::jsonb, $22, $23, $24::timestamptz, $25::timestamptz, NOW()
)
ON CONFLICT (app_scope, user_key, activity_date, calculation_version) DO UPDATE SET
  display_email = EXCLUDED.display_email,
  submitted_questions = EXCLUDED.submitted_questions,
  completed_questions = EXCLUDED.completed_questions,
  run_count = EXCLUDED.run_count,
  active_minutes = EXCLUDED.active_minutes,
  prompt_tokens = EXCLUDED.prompt_tokens,
  completion_tokens = EXCLUDED.completion_tokens,
  total_tokens = EXCLUDED.total_tokens,
  token_covered_runs = EXCLUDED.token_covered_runs,
  token_covered_questions = EXCLUDED.token_covered_questions,
  spend_usd = EXCLUDED.spend_usd,
  spend_dbu = EXCLUDED.spend_dbu,
  app_spend_usd = EXCLUDED.app_spend_usd,
  app_spend_dbu = EXCLUDED.app_spend_dbu,
  spend_usd_quality = EXCLUDED.spend_usd_quality,
  spend_dbu_quality = EXCLUDED.spend_dbu_quality,
  components = EXCLUDED.components,
  activity_complete = EXCLUDED.activity_complete,
  billing_complete = EXCLUDED.billing_complete,
  source_through = EXCLUDED.source_through,
  computed_at = EXCLUDED.computed_at,
  updated_at = NOW()`;var activeRefreshes=new WeakMap;function runUserSpendReadModelRefresh(store,source,options={}){const active=activeRefreshes.get(store);if(active)return active;const run=(async()=>{const started=options.now?.()??Date.now();const appScope=(options.appScope??process.env.DATABRICKS_APP_NAME??"").trim()||"player-insights";const version=options.calculationVersion??USER_SPEND_CALCULATION_VERSION;const owner=`${process.pid}:${started}:${Math.random().toString(36).slice(2,10)}`;const connection=await store.pool?.connect();if(!connection){throw new Error("User spend refresh requires a pinned Lakebase connection for its lock and transactions.")}const controller=new AbortController;const parentAbort=()=>controller.abort(options.signal?.reason);if(options.signal?.aborted)parentAbort();else options.signal?.addEventListener("abort",parentAbort,{once:true});const timeout=setTimeout(()=>controller.abort(new Error("User spend refresh deadline reached.")),Math.max(1e3,options.timeoutMs??12e4));timeout.unref?.();let locked=false;try{const lock=await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",[`${appScope}:user-spend:${version}`]);locked=bool(lock.rows[0]?.acquired);if(!locked){diagnostics.lockContention+=1;return{acquired:false,refreshed:false,from:null,to:null,rows:0,users:0,days:0}}await connection.query(`INSERT INTO ${USER_SPEND_REFRESH_TABLE} (app_scope, calculation_version, status)
         VALUES ($1, $2, 'idle')
         ON CONFLICT (app_scope, calculation_version) DO NOTHING`,[appScope,version]);const lease=await connection.query(`UPDATE ${USER_SPEND_REFRESH_TABLE}
         SET status = 'refreshing', lease_owner = $3,
             lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
             started_at = NOW(), error_class = NULL, error_at = NULL
         WHERE app_scope = $1 AND calculation_version = $2
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW() OR lease_owner = $3)
         RETURNING watermark_day`,[appScope,version,owner,Math.max(3e4,options.leaseMs??USER_SPEND_LEASE_MS)]);if(lease.rows.length===0){diagnostics.lockContention+=1;return{acquired:false,refreshed:false,from:null,to:null,rows:0,users:0,days:0}}const through=day(options.throughDay)||addDays(new Date(started).toISOString().slice(0,10),-1);const watermark=day(lease.rows[0]?.watermark_day);const overlap=Math.max(1,Math.min(31,Math.trunc(options.overlapDays??USER_SPEND_OVERLAP_DAYS)));const requestedFrom=day(options.fromDay);const earliest=requestedFrom||(watermark?addDays(watermark,-(overlap-1)):day(await source.firstAvailableDay(controller.signal)));if(!earliest||earliest>through){await connection.query(`UPDATE ${USER_SPEND_REFRESH_TABLE}
           SET status = 'ready', lease_owner = NULL, lease_expires_at = NULL,
               completed_at = NOW()
           WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,[appScope,version,owner]);return{acquired:true,refreshed:false,from:earliest||null,to:through,rows:0,users:0,days:0}}const batchDays=Math.max(1,Math.min(62,Math.trunc(options.batchDays??USER_SPEND_REFRESH_BATCH_DAYS)));let rows=0;const users=new Set;const refreshedDays=new Set;let latestSourceThrough=null;let completeThrough=null;for(let from=earliest;from<=through;from=addDays(from,batchDays)){if(controller.signal.aborted)throw controller.signal.reason;const to=[addDays(from,batchDays-1),through].sort()[0];const batch=await source.loadRange({from,to},controller.signal);const validRows=batch.rows.filter(row=>row.appScope===appScope&&row.calculationVersion===version&&row.userKey.trim()&&row.activityDate>=from&&row.activityDate<=to);await transaction(connection,async()=>{await connection.query(`DELETE FROM ${USER_SPEND_DAILY_TABLE}
             WHERE app_scope = $1 AND calculation_version = $2
               AND activity_date BETWEEN $3::date AND $4::date`,[appScope,version,from,to]);for(const row of validRows){const userKey=row.userKey.trim().toLowerCase();await connection.query(UPSERT_USER_SPEND_DAY_QUERY,[appScope,userKey,row.displayEmail.trim().toLowerCase(),row.activityDate,version,integer(row.submittedQuestions),integer(row.completedQuestions),integer(row.runCount),integer(row.activeMinutes),row.promptTokens,row.completionTokens,row.totalTokens,row.tokenCoveredRuns??null,row.tokenCoveredQuestions??null,decimal(row.spendUsd),decimal(row.spendDbu),decimal(row.appSpendUsd),decimal(row.appSpendDbu),row.spendUsdQuality,row.spendDbuQuality,JSON.stringify(row.components??{}),row.activityComplete,row.billingComplete,row.sourceThrough,row.computedAt]);users.add(userKey);refreshedDays.add(row.activityDate)}await connection.query(`UPDATE ${USER_SPEND_REFRESH_TABLE}
             SET watermark_day = $4::date, overlap_from_day = $5::date,
                 source_through = $6::timestamptz,
                 billing_complete_through = $7::date,
                 lease_expires_at = NOW() + ($8::bigint * INTERVAL '1 millisecond'),
                 rows_upserted = rows_upserted + $9,
                 users_upserted = users_upserted + $10,
                 days_upserted = days_upserted + $11
             WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,[appScope,version,owner,to,earliest,batch.sourceThrough,batch.billingCompleteThrough,Math.max(3e4,options.leaseMs??USER_SPEND_LEASE_MS),validRows.length,new Set(validRows.map(row=>row.userKey.toLowerCase())).size,daysBetween(from,to)])});rows+=validRows.length;latestSourceThrough=batch.sourceThrough??latestSourceThrough;completeThrough=batch.billingCompleteThrough??completeThrough}await connection.query(`UPDATE ${USER_SPEND_REFRESH_TABLE}
         SET status = 'ready', source_through = COALESCE($4::timestamptz, source_through),
             billing_complete_through = COALESCE($5::date, billing_complete_through),
             completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL
         WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,[appScope,version,owner,latestSourceThrough,completeThrough]);diagnostics.refreshes+=1;diagnostics.rowsUpserted+=rows;diagnostics.lastDurationMs=(options.now?.()??Date.now())-started;console.log(`[user-spend-read-model] refreshed ${rows} rows for ${users.size} users across ${refreshedDays.size} represented days in ${diagnostics.lastDurationMs}ms`);return{acquired:true,refreshed:true,from:earliest,to:through,rows,users:users.size,days:refreshedDays.size}}catch(error){diagnostics.failures+=1;diagnostics.lastDurationMs=(options.now?.()??Date.now())-started;await connection.query(`UPDATE ${USER_SPEND_REFRESH_TABLE}
           SET status = 'failed', error_class = $4, error_at = NOW(),
               lease_owner = NULL, lease_expires_at = NULL
           WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,[appScope,version,owner,safeErrorClass(error)]).catch(()=>void 0);throw error}finally{clearTimeout(timeout);options.signal?.removeEventListener("abort",parentAbort);if(locked){await connection.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))",[`${appScope}:user-spend:${version}`]).catch(()=>void 0)}connection.release()}})();const tracked=run.finally(()=>activeRefreshes.delete(store));activeRefreshes.set(store,tracked);return tracked}var READ_USER_SPEND_SUMMARY_QUERY=`WITH base AS (
  SELECT *
  FROM ${USER_SPEND_DAILY_TABLE}
  WHERE app_scope = $1
    AND calculation_version = $2
    AND activity_date BETWEEN $3::date AND $4::date
),
aggregated AS (
  SELECT user_key, MIN(display_email) AS display_email,
         SUM(submitted_questions)::bigint AS submitted_questions,
         SUM(completed_questions)::bigint AS completed_questions,
         SUM(run_count)::bigint AS run_count,
         SUM(active_minutes)::bigint AS active_minutes,
         SUM(total_tokens)::numeric AS total_tokens,
         SUM(token_covered_runs)::bigint AS token_covered_runs,
         SUM(token_covered_questions)::bigint AS token_covered_questions,
         MAX(source_through) AS source_through,
         MAX(computed_at) AS computed_at,
         COUNT(*) FILTER (WHERE billing_complete)::int AS covered_days,
         BOOL_AND(activity_complete) AS activity_complete,
         BOOL_AND(billing_complete) AS billing_complete,
         CASE WHEN BOOL_AND(billing_complete) AND COUNT(spend_usd) = COUNT(*)
              THEN SUM(spend_usd) ELSE NULL END AS spend_usd,
         CASE WHEN BOOL_AND(billing_complete) AND COUNT(spend_dbu) = COUNT(*)
              THEN SUM(spend_dbu) ELSE NULL END AS spend_dbu,
         CASE
           WHEN NOT BOOL_AND(billing_complete) OR COUNT(spend_usd) <> COUNT(*) THEN 'unavailable'
           WHEN BOOL_OR(spend_usd_quality = 'partial') THEN 'partial'
           WHEN BOOL_OR(spend_usd_quality = 'allocated') THEN 'allocated'
           WHEN BOOL_OR(spend_usd_quality = 'joined') THEN 'joined'
           ELSE MIN(spend_usd_quality)
         END AS spend_usd_quality,
         CASE
           WHEN NOT BOOL_AND(billing_complete) OR COUNT(spend_dbu) <> COUNT(*) THEN 'unavailable'
           WHEN BOOL_OR(spend_dbu_quality = 'partial') THEN 'partial'
           WHEN BOOL_OR(spend_dbu_quality = 'allocated') THEN 'allocated'
           WHEN BOOL_OR(spend_dbu_quality = 'joined') THEN 'joined'
           ELSE MIN(spend_dbu_quality)
         END AS spend_dbu_quality
  FROM base
  GROUP BY user_key
),
daily_app AS (
  SELECT activity_date,
         MAX(app_spend_usd) AS app_spend_usd,
         MAX(app_spend_dbu) AS app_spend_dbu,
         BOOL_OR(billing_complete) AS billing_complete
  FROM base
  GROUP BY activity_date
),
app_totals AS (
  SELECT CASE WHEN BOOL_AND(billing_complete) AND COUNT(app_spend_usd) = COUNT(*)
              THEN SUM(app_spend_usd) ELSE NULL END AS app_spend_usd,
         CASE WHEN BOOL_AND(billing_complete) AND COUNT(app_spend_dbu) = COUNT(*)
              THEN SUM(app_spend_dbu) ELSE NULL END AS app_spend_dbu,
         COUNT(*) FILTER (WHERE billing_complete)::int AS app_covered_days
  FROM daily_app
),
identity_population AS (
  SELECT roster.user_key, roster.display_email, roster.app_role, roster.identity_updated_at
  FROM (
    SELECT DISTINCT ON (lower(email))
           lower(email) AS user_key,
           lower(email) AS display_email,
           CASE WHEN role IN ('super_admin', 'admin', 'consumer') THEN role ELSE 'admin' END AS app_role,
           added_at AS identity_updated_at
    FROM ${ADMIN_EMAILS_TABLE}
    ORDER BY lower(email), added_at DESC
  ) roster
  WHERE $5::boolean AND $13::boolean
  UNION ALL
  SELECT aggregated.user_key, aggregated.display_email, 'consumer', NULL::timestamptz
  FROM aggregated
  WHERE NOT $13::boolean AND aggregated.user_key = lower($6)
),
identity_revision AS (
  SELECT GREATEST(
    (SELECT MAX(added_at) FROM ${ADMIN_EMAILS_TABLE}),
    (SELECT MAX(updated_at) FROM ${SP_ASSIGNMENTS_TABLE}),
    (SELECT MAX(updated_at) FROM ${SP_PERSONAS_TABLE}),
    (SELECT MAX(updated_at) FROM ${SP_PERSONA_DEFINITIONS_TABLE})
  ) AS revision
),
filtered AS (
  SELECT identity_population.user_key, identity_population.display_email,
         COALESCE(aggregated.submitted_questions, 0) AS submitted_questions,
         COALESCE(aggregated.completed_questions, 0) AS completed_questions,
         COALESCE(aggregated.run_count, 0) AS run_count,
         COALESCE(aggregated.active_minutes, 0) AS active_minutes,
         aggregated.total_tokens, aggregated.token_covered_runs, aggregated.token_covered_questions,
         aggregated.source_through, aggregated.computed_at,
         COALESCE(aggregated.covered_days, 0) AS covered_days,
         COALESCE(aggregated.activity_complete, FALSE) AS activity_complete,
         COALESCE(aggregated.billing_complete, FALSE) AS billing_complete,
         aggregated.spend_usd, aggregated.spend_dbu,
         COALESCE(aggregated.spend_usd_quality, 'unavailable') AS spend_usd_quality,
         COALESCE(aggregated.spend_dbu_quality, 'unavailable') AS spend_dbu_quality,
         app_totals.*,
         identity_population.app_role,
         assignment.persona_id,
         COALESCE(definition.display_name, persona.display_name) AS persona_name,
         identity_revision.revision AS identity_updated_at,
         COUNT(*) OVER ()::int AS total_users
  FROM identity_population
  LEFT JOIN aggregated ON aggregated.user_key = identity_population.user_key
  CROSS JOIN app_totals
  CROSS JOIN identity_revision
  LEFT JOIN ${SP_ASSIGNMENTS_TABLE} assignment ON lower(assignment.email) = identity_population.user_key
  LEFT JOIN ${SP_PERSONAS_TABLE} persona ON persona.id = assignment.persona_id
  LEFT JOIN ${SP_PERSONA_DEFINITIONS_TABLE} definition ON definition.id = assignment.persona_id
  WHERE ($7 = '' OR identity_population.display_email LIKE ('%' || lower($7) || '%'))
    AND ($8 = '' OR identity_population.app_role = $8)
    AND ($9 = '' OR assignment.persona_id = $9)
)
SELECT filtered.*, refresh.status AS refresh_status,
       refresh.source_through AS refresh_source_through,
       refresh.billing_complete_through,
       refresh.completed_at AS refresh_completed_at
FROM filtered
LEFT JOIN ${USER_SPEND_REFRESH_TABLE} refresh
  ON refresh.app_scope = $1 AND refresh.calculation_version = $2
ORDER BY
  CASE WHEN $10 = 'DBU' THEN spend_dbu ELSE spend_usd END DESC NULLS LAST,
  user_key ASC
LIMIT $11 OFFSET $12`;var READ_USER_SPEND_COMPONENTS_QUERY=`SELECT component.key AS component_id,
       MIN(component.value->>'label') AS label,
       CASE WHEN BOOL_AND(component.value ? 'usd' AND component.value->>'usd' IS NOT NULL)
            THEN SUM((component.value->>'usd')::numeric) ELSE NULL END AS spend_usd,
       CASE WHEN BOOL_AND(component.value ? 'dbu' AND component.value->>'dbu' IS NOT NULL)
            THEN SUM((component.value->>'dbu')::numeric) ELSE NULL END AS spend_dbu,
       CASE WHEN BOOL_OR(component.value->>'usdQuality' = 'partial') THEN 'partial'
            WHEN BOOL_OR(component.value->>'usdQuality' = 'allocated') THEN 'allocated'
            WHEN BOOL_OR(component.value->>'usdQuality' = 'joined') THEN 'joined'
            ELSE MIN(component.value->>'usdQuality') END AS spend_usd_quality,
       CASE WHEN BOOL_OR(component.value->>'dbuQuality' = 'partial') THEN 'partial'
            WHEN BOOL_OR(component.value->>'dbuQuality' = 'allocated') THEN 'allocated'
            WHEN BOOL_OR(component.value->>'dbuQuality' = 'joined') THEN 'joined'
            ELSE MIN(component.value->>'dbuQuality') END AS spend_dbu_quality,
       MIN(COALESCE(component.value->>'reason', '')) AS reason
FROM ${USER_SPEND_DAILY_TABLE} daily
CROSS JOIN LATERAL jsonb_each(daily.components) component
WHERE daily.app_scope = $1
  AND daily.calculation_version = $2
  AND daily.user_key = lower($3)
  AND daily.activity_date BETWEEN $4::date AND $5::date
GROUP BY component.key
ORDER BY component.key`;var READ_USER_SPEND_REFRESH_STATE_QUERY=`SELECT status AS refresh_status,
       source_through AS refresh_source_through,
       billing_complete_through,
       completed_at AS refresh_completed_at,
       GREATEST(
         (SELECT MAX(added_at) FROM ${ADMIN_EMAILS_TABLE}),
         (SELECT MAX(updated_at) FROM ${SP_ASSIGNMENTS_TABLE}),
         (SELECT MAX(updated_at) FROM ${SP_PERSONAS_TABLE}),
         (SELECT MAX(updated_at) FROM ${SP_PERSONA_DEFINITIONS_TABLE})
       ) AS identity_updated_at
FROM ${USER_SPEND_REFRESH_TABLE}
WHERE app_scope = $1 AND calculation_version = $2`;function nullableNumber(value){if(value===null||value===void 0||value==="")return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:null}function quality(value){return value==="direct"||value==="joined"||value==="allocated"||value==="unattributed"||value==="partial"?value:"unavailable"}async function readUserSpendReadModelPage(store,input){const version=input.calculationVersion??USER_SPEND_CALCULATION_VERSION;const appScope=(input.appScope??process.env.DATABRICKS_APP_NAME??"").trim()||"player-insights";const limit=Math.max(1,Math.min(100,Math.trunc(input.limit??25)));const offset=Math.max(0,Math.trunc(input.offset??0));const result=await store.query(READ_USER_SPEND_SUMMARY_QUERY,[appScope,version,input.range.from,input.range.to,input.allowBrowse,input.principal.trim().toLowerCase(),(input.search??"").trim().slice(0,120),(input.role??"").trim(),(input.persona??"").trim(),input.unit,limit,offset,input.rosterOnly??input.allowBrowse]);const first=result.rows[0];const metadata=first??(await store.query(READ_USER_SPEND_REFRESH_STATE_QUERY,[appScope,version])).rows[0];const computedAt=stamp(metadata?.refresh_completed_at)??stamp(metadata?.computed_at);const sourceThrough=stamp(metadata?.refresh_source_through)??stamp(metadata?.source_through);const billingCompleteThrough=day(metadata?.billing_complete_through)||null;const coveredThrough=billingCompleteThrough&&billingCompleteThrough<input.range.to?billingCompleteThrough:input.range.to;const coveredDays=billingCompleteThrough&&coveredThrough>=input.range.from?daysBetween(input.range.from,coveredThrough):0;const staleMs=Math.max(6e4,input.staleMs??USER_SPEND_STALE_MS);const now=input.now??Date.now();return{available:Boolean(first||computedAt),rows:result.rows.map(row=>({email:typeof row.display_email==="string"?row.display_email:"",questions:integer(row.submitted_questions),completedQuestions:integer(row.completed_questions),runs:integer(row.run_count),activeMinutes:integer(row.active_minutes),totalTokens:nullableNumber(row.total_tokens),tokenCoveredRuns:nullableNumber(row.token_covered_runs),tokenCoveredQuestions:nullableNumber(row.token_covered_questions),coveredDays,spendUsd:nullableNumber(row.spend_usd),spendDbu:nullableNumber(row.spend_dbu),spendUsdQuality:quality(row.spend_usd_quality),spendDbuQuality:quality(row.spend_dbu_quality),appSpendUsd:nullableNumber(row.app_spend_usd),appSpendDbu:nullableNumber(row.app_spend_dbu),activityComplete:bool(row.activity_complete),billingComplete:bool(row.billing_complete),role:row.app_role==="super_admin"||row.app_role==="admin"||row.app_role==="consumer"?row.app_role:"consumer",persona:typeof row.persona_id==="string"&&row.persona_id&&typeof row.persona_name==="string"?{id:row.persona_id,name:row.persona_name}:null,sourceThrough:stamp(row.source_through),computedAt:stamp(row.computed_at),identityRevision:stamp(row.identity_updated_at)})),total:integer(first?.total_users),identityRevision:stamp(first?.identity_updated_at)??stamp(metadata?.identity_updated_at)??"",freshness:{computedAt,sourceThrough,billingCompleteThrough,isRefreshing:metadata?.refresh_status==="refreshing",isStale:computedAt===null||now-Date.parse(computedAt)>staleMs,calculationVersion:version}}}async function readUserSpendReadModelComponents(store,input){const appScope=(input.appScope??process.env.DATABRICKS_APP_NAME??"").trim()||"player-insights";const version=input.calculationVersion??USER_SPEND_CALCULATION_VERSION;const result=await store.query(READ_USER_SPEND_COMPONENTS_QUERY,[appScope,version,input.email.trim().toLowerCase(),input.range.from,input.range.to]);return result.rows.map(row=>({id:typeof row.component_id==="string"?row.component_id:"",label:typeof row.label==="string"?row.label:typeof row.component_id==="string"?row.component_id:"",usd:{amount:nullableNumber(row.spend_usd),quality:quality(row.spend_usd_quality)},dbu:{amount:nullableNumber(row.spend_dbu),quality:quality(row.spend_dbu_quality)},reason:typeof row.reason==="string"?row.reason:""}))}var HOUR_MS=60*60*1e3;var DAY_MS2=24*HOUR_MS;var USER_SPEND_HOURLY_RETENTION_DAYS=8;var USER_SPEND_HOURLY_OVERLAP_HOURS=48;var USER_SPEND_HOURLY_REFRESH_INTERVAL_MS=15*60*1e3;var USER_SPEND_HOURLY_LEASE_MS=10*60*1e3;var USER_SPEND_HOURLY_TABLE=appTable("user_spend_hourly");var USER_SPEND_HOURLY_REFRESH_TABLE=appTable("user_spend_hourly_refresh_state");var USER_SPEND_HOURLY_READ_MODEL_DDL=[`CREATE TABLE IF NOT EXISTS ${USER_SPEND_HOURLY_TABLE} (
     app_scope TEXT NOT NULL,
     user_key TEXT NOT NULL,
     display_email TEXT NOT NULL,
     activity_hour TIMESTAMPTZ NOT NULL,
     calculation_version INTEGER NOT NULL,
     submitted_questions INTEGER NOT NULL DEFAULT 0 CHECK (submitted_questions >= 0),
     completed_questions INTEGER NOT NULL DEFAULT 0 CHECK (completed_questions >= 0),
     run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
     active_minutes INTEGER NOT NULL DEFAULT 0 CHECK (active_minutes >= 0),
     total_tokens BIGINT,
     token_covered_runs INTEGER,
     token_covered_questions INTEGER,
     spend_usd NUMERIC(30,12),
     spend_dbu NUMERIC(30,12),
     app_spend_usd NUMERIC(30,12),
     app_spend_dbu NUMERIC(30,12),
     spend_usd_quality TEXT NOT NULL DEFAULT 'unavailable'
       CHECK (spend_usd_quality IN ('allocated', 'partial', 'unavailable')),
     spend_dbu_quality TEXT NOT NULL DEFAULT 'unavailable'
       CHECK (spend_dbu_quality IN ('allocated', 'partial', 'unavailable')),
     components JSONB NOT NULL DEFAULT '{}'::jsonb,
     billing_basis_day DATE,
     source_through TIMESTAMPTZ,
     computed_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (app_scope, user_key, activity_hour, calculation_version),
     CHECK (lower(user_key) = user_key),
     CHECK (jsonb_typeof(components) = 'object')
   )`,`CREATE INDEX IF NOT EXISTS user_spend_hourly_hour_scope_idx
     ON ${USER_SPEND_HOURLY_TABLE} (activity_hour, app_scope, calculation_version)`,`CREATE TABLE IF NOT EXISTS ${USER_SPEND_HOURLY_REFRESH_TABLE} (
     app_scope TEXT NOT NULL,
     calculation_version INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('idle', 'refreshing', 'ready', 'failed')),
     watermark_hour TIMESTAMPTZ,
     source_through TIMESTAMPTZ,
     billing_basis_through DATE,
     lease_owner TEXT,
     lease_expires_at TIMESTAMPTZ,
     started_at TIMESTAMPTZ,
     completed_at TIMESTAMPTZ,
     error_class TEXT,
     error_at TIMESTAMPTZ,
     rows_upserted BIGINT NOT NULL DEFAULT 0,
     PRIMARY KEY (app_scope, calculation_version)
   )`];var READ_USER_SPEND_HOURLY_SOURCE_QUERY=`WITH evidence AS (
  SELECT lower(c.user_email) AS user_key, m.created_at AS occurred_at,
         1::int AS questions, 0::int AS completed, 0::int AS runs,
         0::int AS active_minutes, NULL::bigint AS total_tokens,
         0::int AS token_covered_runs, NULL::text AS token_question_id
  FROM ${appTable("messages")} m
  JOIN ${appTable("conversations")} c ON c.id = m.conversation_id
  WHERE m.role = 'user' AND m.created_at >= $3::timestamptz AND m.created_at < $4::timestamptz
  UNION ALL
  SELECT lower(r.user_email), COALESCE(r.completed_at, r.created_at),
         0, CASE WHEN r.state = 'SUCCEEDED' THEN 1 ELSE 0 END, 1, 0,
         CASE
           WHEN COALESCE(m.response_json->'trace'->>'total_tokens', '') ~ '^[0-9]+$'
             THEN (m.response_json->'trace'->>'total_tokens')::bigint
           WHEN COALESCE(m.response_json->'trace'->>'prompt_tokens', '') ~ '^[0-9]+$'
            AND COALESCE(m.response_json->'trace'->>'completion_tokens', '') ~ '^[0-9]+$'
             THEN (m.response_json->'trace'->>'prompt_tokens')::bigint
                + (m.response_json->'trace'->>'completion_tokens')::bigint
           ELSE NULL
         END,
         CASE WHEN COALESCE(m.response_json->'trace'->>'total_tokens', '') ~ '^[0-9]+$'
                    OR (COALESCE(m.response_json->'trace'->>'prompt_tokens', '') ~ '^[0-9]+$'
                    AND COALESCE(m.response_json->'trace'->>'completion_tokens', '') ~ '^[0-9]+$')
              THEN 1 ELSE 0 END,
         CASE WHEN COALESCE(m.response_json->'trace'->>'total_tokens', '') ~ '^[0-9]+$'
                    OR (COALESCE(m.response_json->'trace'->>'prompt_tokens', '') ~ '^[0-9]+$'
                    AND COALESCE(m.response_json->'trace'->>'completion_tokens', '') ~ '^[0-9]+$')
              THEN r.turn_id ELSE NULL END
  FROM ${appTable("runs")} r
  LEFT JOIN ${appTable("messages")} m ON m.id = r.terminal_message_id
  WHERE COALESCE(r.completed_at, r.created_at) >= $3::timestamptz
    AND COALESCE(r.completed_at, r.created_at) < $4::timestamptz
  UNION ALL
  SELECT lower(a.user_email), a.active_minute, 0, 0, 0, 1, NULL::bigint, 0::int, NULL::text
  FROM ${appTable("app_activity_minutes")} a
  WHERE a.active_minute >= $3::timestamptz AND a.active_minute < $4::timestamptz
),
hourly AS (
  SELECT user_key, date_trunc('hour', occurred_at) AS activity_hour,
         SUM(questions)::int AS submitted_questions,
         SUM(completed)::int AS completed_questions,
         SUM(runs)::int AS run_count,
         SUM(active_minutes)::int AS active_minutes,
         CASE WHEN COUNT(total_tokens) > 0 THEN SUM(total_tokens)::bigint ELSE NULL END AS total_tokens,
         SUM(token_covered_runs)::int AS token_covered_runs,
         COUNT(DISTINCT token_question_id)::int AS token_covered_questions,
         MAX(occurred_at) AS source_through
  FROM evidence
  WHERE user_key <> ''
  GROUP BY user_key, date_trunc('hour', occurred_at)
)
SELECT hourly.*, basis.display_email, basis.activity_date AS billing_basis_day,
       basis.submitted_questions AS basis_questions,
       basis.completed_questions AS basis_completed,
       basis.active_minutes AS basis_active_minutes,
       basis.spend_usd AS basis_spend_usd, basis.spend_dbu AS basis_spend_dbu,
       basis.components AS basis_components
FROM hourly
LEFT JOIN LATERAL (
  SELECT daily.display_email, daily.activity_date, daily.submitted_questions,
         daily.completed_questions, daily.active_minutes, daily.spend_usd,
         daily.spend_dbu, daily.components
  FROM ${USER_SPEND_DAILY_TABLE} daily
  WHERE daily.app_scope = $1 AND daily.calculation_version = $2
    AND daily.user_key = hourly.user_key
    AND daily.activity_date <= (hourly.activity_hour AT TIME ZONE 'UTC')::date
  ORDER BY daily.activity_date DESC
  LIMIT 1
) basis ON TRUE
ORDER BY hourly.activity_hour, hourly.user_key`;var UPSERT_USER_SPEND_HOUR_QUERY=`INSERT INTO ${USER_SPEND_HOURLY_TABLE} (
  app_scope, user_key, display_email, activity_hour, calculation_version,
  submitted_questions, completed_questions, run_count, active_minutes, total_tokens,
  token_covered_runs, token_covered_questions,
  spend_usd, spend_dbu, app_spend_usd, app_spend_dbu,
  spend_usd_quality, spend_dbu_quality, components, billing_basis_day,
  source_through, computed_at, updated_at
) VALUES (
  $1, lower($2), $3, $4::timestamptz, $5,
  $6, $7, $8, $9, $10, $11, $12, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
  $17, $18, $19::jsonb, $20::date, $21::timestamptz, $22::timestamptz, NOW()
)
ON CONFLICT (app_scope, user_key, activity_hour, calculation_version) DO UPDATE SET
  display_email = EXCLUDED.display_email,
  submitted_questions = EXCLUDED.submitted_questions,
  completed_questions = EXCLUDED.completed_questions,
  run_count = EXCLUDED.run_count,
  active_minutes = EXCLUDED.active_minutes,
  total_tokens = EXCLUDED.total_tokens,
  token_covered_runs = EXCLUDED.token_covered_runs,
  token_covered_questions = EXCLUDED.token_covered_questions,
  spend_usd = EXCLUDED.spend_usd,
  spend_dbu = EXCLUDED.spend_dbu,
  app_spend_usd = EXCLUDED.app_spend_usd,
  app_spend_dbu = EXCLUDED.app_spend_dbu,
  spend_usd_quality = EXCLUDED.spend_usd_quality,
  spend_dbu_quality = EXCLUDED.spend_dbu_quality,
  components = EXCLUDED.components,
  billing_basis_day = EXCLUDED.billing_basis_day,
  source_through = EXCLUDED.source_through,
  computed_at = EXCLUDED.computed_at,
  updated_at = NOW()`;function rollingCompleteHours(from,to,now=Date.now()){const requestedTo=Date.parse(to??"");const end=Math.floor(Math.min(Number.isFinite(requestedTo)?requestedTo:now,now)/HOUR_MS)*HOUR_MS;const requestedFrom=Date.parse(from??"");const startCandidate=Number.isFinite(requestedFrom)?Math.floor(requestedFrom/HOUR_MS)*HOUR_MS:end-DAY_MS2;const start=Math.max(end-DAY_MS2,Math.min(startCandidate,end-HOUR_MS));return{from:new Date(start).toISOString(),to:new Date(end).toISOString()}}function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0}function nullableNumber2(value){if(value===null||value===void 0||value==="")return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:null}function stamp2(value){const raw=value instanceof Date?value.toISOString():typeof value==="string"?value:"";return Number.isFinite(Date.parse(raw))?new Date(raw).toISOString():null}function day2(value){const valueStamp=stamp2(value);if(valueStamp)return valueStamp.slice(0,10);const raw=typeof value==="string"?value.slice(0,10):"";return/^\d{4}-\d{2}-\d{2}$/.test(raw)?raw:null}function decimal2(value){return value===null||!Number.isFinite(value)?null:value.toFixed(12)}function safeErrorClass2(error){const named=error instanceof Error?error.name:"Error";return named.replace(/[^A-Za-z0-9_.-]/g,"").slice(0,80)||"Error"}function bool2(value){return value===true||value==="true"||value==="t"||value===1}function scaledComponents(value,weight){if(!value||typeof value!=="object"||Array.isArray(value))return{};return Object.fromEntries(Object.entries(value).map(([id,raw])=>{const component=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:{};const usd=nullableNumber2(component.usd);const dbu=nullableNumber2(component.dbu);return[id,{...component,usd:decimal2(usd===null?null:usd*weight),dbu:decimal2(dbu===null?null:dbu*weight),usdQuality:usd===null?"unavailable":"partial",dbuQuality:dbu===null?"unavailable":"partial",reason:"Estimated from exact hourly activity and the finest complete daily billing basis."}]}))}function materializeUserSpendHours(rows){const result=rows.flatMap(row=>{const activityHour=stamp2(row.activity_hour);const sourceThrough=stamp2(row.source_through);const userKey=typeof row.user_key==="string"?row.user_key.trim().toLowerCase():"";if(!activityHour||!sourceThrough||!userKey)return[];const questions=number(row.submitted_questions);const completed=number(row.completed_questions);const runs=number(row.run_count);const activeMinutes=number(row.active_minutes);const hourlyEvidence=Math.max(1,questions+completed+activeMinutes);const dailyEvidence=Math.max(1,number(row.basis_questions)+number(row.basis_completed)+number(row.basis_active_minutes));const basisDay=day2(row.billing_basis_day);const sameDay=basisDay===activityHour.slice(0,10);const weight=sameDay?Math.min(1,hourlyEvidence/dailyEvidence):hourlyEvidence/dailyEvidence;const basisUsd=nullableNumber2(row.basis_spend_usd);const basisDbu=nullableNumber2(row.basis_spend_dbu);return[{userKey,displayEmail:typeof row.display_email==="string"&&row.display_email.trim()?row.display_email.trim().toLowerCase():userKey,activityHour,questions,completed,runs,activeMinutes,totalTokens:nullableNumber2(row.total_tokens),tokenCoveredRuns:nullableNumber2(row.token_covered_runs),tokenCoveredQuestions:nullableNumber2(row.token_covered_questions),spendUsd:basisUsd===null?null:basisUsd*weight,spendDbu:basisDbu===null?null:basisDbu*weight,appSpendUsd:null,appSpendDbu:null,usdQuality:basisUsd===null?"unavailable":"partial",dbuQuality:basisDbu===null?"unavailable":"partial",components:scaledComponents(row.basis_components,weight),basisDay,sourceThrough}]});const totals=new Map;for(const row of result){const current=totals.get(row.activityHour)??{usd:0,dbu:0};current.usd=current.usd===null||row.spendUsd===null?null:current.usd+row.spendUsd;current.dbu=current.dbu===null||row.spendDbu===null?null:current.dbu+row.spendDbu;totals.set(row.activityHour,current)}for(const row of result){const total=totals.get(row.activityHour);row.appSpendUsd=total?.usd??null;row.appSpendDbu=total?.dbu??null}return result}var activeRefresh=null;function runUserSpendHourlyRefresh(store,options={}){if(activeRefresh)return activeRefresh;const run=(async()=>{const now=options.now??Date.now();const appScope=(options.appScope??process.env.DATABRICKS_APP_NAME??"").trim()||"player-insights";const version=options.calculationVersion??USER_SPEND_CALCULATION_VERSION;const to=rollingCompleteHours(void 0,options.to,now).to;const defaultFrom=new Date(Date.parse(to)-USER_SPEND_HOURLY_OVERLAP_HOURS*HOUR_MS).toISOString();const requestedFrom=Date.parse(options.from??defaultFrom);const from=new Date(Math.min(Date.parse(to)-HOUR_MS,Math.floor((Number.isFinite(requestedFrom)?requestedFrom:Date.parse(defaultFrom))/HOUR_MS)*HOUR_MS)).toISOString();const owner=`${process.pid}:${now}:${Math.random().toString(36).slice(2,10)}`;const connection=await store.pool?.connect();if(!connection)throw new Error("Hourly user spend refresh requires a pinned Lakebase connection.");let locked=false;try{const lock=await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",[`${appScope}:user-spend-hourly:${version}`]);locked=bool2(lock.rows[0]?.acquired);if(!locked)return;await connection.query(`INSERT INTO ${USER_SPEND_HOURLY_REFRESH_TABLE} (app_scope, calculation_version, status)
         VALUES ($1, $2, 'idle') ON CONFLICT (app_scope, calculation_version) DO NOTHING`,[appScope,version]);const lease=await connection.query(`UPDATE ${USER_SPEND_HOURLY_REFRESH_TABLE}
         SET status = 'refreshing', lease_owner = $3,
             lease_expires_at = NOW() + ($4::bigint * INTERVAL '1 millisecond'),
             started_at = NOW(), error_class = NULL, error_at = NULL
         WHERE app_scope = $1 AND calculation_version = $2
           AND (lease_expires_at IS NULL OR lease_expires_at < NOW() OR lease_owner = $3)
         RETURNING watermark_hour`,[appScope,version,owner,USER_SPEND_HOURLY_LEASE_MS]);if(lease.rows.length===0)return;const source=await connection.query(READ_USER_SPEND_HOURLY_SOURCE_QUERY,[appScope,version,from,to]);const rows=materializeUserSpendHours(source.rows);await connection.query("BEGIN");try{await connection.query(`DELETE FROM ${USER_SPEND_HOURLY_TABLE}
           WHERE app_scope = $1 AND calculation_version = $2
             AND activity_hour >= $3::timestamptz AND activity_hour < $4::timestamptz`,[appScope,version,from,to]);for(const row of rows){await connection.query(UPSERT_USER_SPEND_HOUR_QUERY,[appScope,row.userKey,row.displayEmail,row.activityHour,version,row.questions,row.completed,row.runs,row.activeMinutes,row.totalTokens,row.tokenCoveredRuns,row.tokenCoveredQuestions,decimal2(row.spendUsd),decimal2(row.spendDbu),decimal2(row.appSpendUsd),decimal2(row.appSpendDbu),row.usdQuality,row.dbuQuality,JSON.stringify(row.components),row.basisDay,row.sourceThrough,new Date(now).toISOString()])}const sourceTimes=rows.map(row=>row.sourceThrough).sort();const basisDays=rows.flatMap(row=>row.basisDay?[row.basisDay]:[]).sort();const sourceThrough=sourceTimes[sourceTimes.length-1]??null;const basisThrough=basisDays[basisDays.length-1]??null;await connection.query(`UPDATE ${USER_SPEND_HOURLY_REFRESH_TABLE}
           SET status = 'ready', watermark_hour = $4::timestamptz,
               source_through = $5::timestamptz, billing_basis_through = $6::date,
               completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL,
               rows_upserted = rows_upserted + $7
           WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,[appScope,version,owner,to,sourceThrough,basisThrough,rows.length]);const retentionDays=Math.max(2,Math.min(31,Math.trunc(options.retentionDays??USER_SPEND_HOURLY_RETENTION_DAYS)));await connection.query(`DELETE FROM ${USER_SPEND_HOURLY_TABLE}
           WHERE app_scope = $1 AND calculation_version = $2
             AND activity_hour < $3::timestamptz`,[appScope,version,new Date(Date.parse(to)-retentionDays*DAY_MS2).toISOString()]);await connection.query("COMMIT")}catch(error){await connection.query("ROLLBACK").catch(()=>void 0);throw error}}catch(error){await connection.query(`UPDATE ${USER_SPEND_HOURLY_REFRESH_TABLE}
           SET status = 'failed', error_class = $4, error_at = NOW(),
               lease_owner = NULL, lease_expires_at = NULL
           WHERE app_scope = $1 AND calculation_version = $2 AND lease_owner = $3`,[appScope,version,owner,safeErrorClass2(error)]).catch(()=>void 0);throw error}finally{if(locked){await connection.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))",[`${appScope}:user-spend-hourly:${version}`]).catch(()=>void 0)}connection.release()}})();activeRefresh=run.finally(()=>{activeRefresh=null});return activeRefresh}var READ_USER_SPEND_HOURLY_SUMMARY_QUERY=`WITH base AS (
  SELECT * FROM ${USER_SPEND_HOURLY_TABLE}
  WHERE app_scope = $1 AND calculation_version = $2
    AND activity_hour >= $3::timestamptz AND activity_hour < $4::timestamptz
),
aggregated AS (
  SELECT user_key, MIN(display_email) AS display_email,
         SUM(submitted_questions)::bigint AS submitted_questions,
         SUM(completed_questions)::bigint AS completed_questions,
         SUM(run_count)::bigint AS run_count,
         SUM(active_minutes)::bigint AS active_minutes,
         SUM(total_tokens)::numeric AS total_tokens,
         SUM(token_covered_runs)::bigint AS token_covered_runs,
         SUM(token_covered_questions)::bigint AS token_covered_questions,
         COUNT(DISTINCT activity_hour)::int AS covered_hours,
         MAX(source_through) AS source_through, MAX(computed_at) AS computed_at,
         SUM(spend_usd) AS spend_usd, SUM(spend_dbu) AS spend_dbu,
         CASE WHEN COUNT(spend_usd) = 0 THEN 'unavailable' ELSE 'partial' END AS spend_usd_quality,
         CASE WHEN COUNT(spend_dbu) = 0 THEN 'unavailable' ELSE 'partial' END AS spend_dbu_quality
  FROM base GROUP BY user_key
),
hourly_app AS (
  SELECT activity_hour, MAX(app_spend_usd) AS app_spend_usd, MAX(app_spend_dbu) AS app_spend_dbu
  FROM base GROUP BY activity_hour
),
app_totals AS (
  SELECT SUM(app_spend_usd) AS app_spend_usd, SUM(app_spend_dbu) AS app_spend_dbu FROM hourly_app
),
identity_population AS (
  SELECT roster.user_key, roster.display_email, roster.app_role, roster.identity_updated_at
  FROM (
    SELECT DISTINCT ON (lower(email))
           lower(email) AS user_key, lower(email) AS display_email,
           CASE WHEN role IN ('super_admin', 'admin', 'consumer') THEN role ELSE 'admin' END AS app_role,
           added_at AS identity_updated_at
    FROM ${appTable("admin_emails")}
    ORDER BY lower(email), added_at DESC
  ) roster
  WHERE $5::boolean AND $13::boolean
  UNION ALL
  SELECT aggregated.user_key, aggregated.display_email, 'consumer', NULL::timestamptz
  FROM aggregated
  WHERE NOT $13::boolean AND aggregated.user_key = lower($6)
),
identity_revision AS (
  SELECT GREATEST(
    (SELECT MAX(added_at) FROM ${appTable("admin_emails")}),
    (SELECT MAX(updated_at) FROM ${appTable("sp_assignments")}),
    (SELECT MAX(updated_at) FROM ${appTable("sp_personas")}),
    (SELECT MAX(updated_at) FROM ${appTable("sp_persona_definitions")})
  ) AS revision
),
filtered AS (
  SELECT identity_population.user_key, identity_population.display_email,
         COALESCE(aggregated.submitted_questions, 0) AS submitted_questions,
         COALESCE(aggregated.completed_questions, 0) AS completed_questions,
         COALESCE(aggregated.run_count, 0) AS run_count,
         COALESCE(aggregated.active_minutes, 0) AS active_minutes,
         aggregated.total_tokens, aggregated.token_covered_runs, aggregated.token_covered_questions,
         COALESCE(aggregated.covered_hours, 0) AS covered_hours,
         aggregated.source_through, aggregated.computed_at,
         aggregated.spend_usd, aggregated.spend_dbu,
         COALESCE(aggregated.spend_usd_quality, 'unavailable') AS spend_usd_quality,
         COALESCE(aggregated.spend_dbu_quality, 'unavailable') AS spend_dbu_quality,
         app_totals.*, identity_population.app_role,
         assignment.persona_id, COALESCE(definition.display_name, persona.display_name) AS persona_name,
         identity_revision.revision AS identity_updated_at,
         COUNT(*) OVER ()::int AS total_users
  FROM identity_population
  LEFT JOIN aggregated ON aggregated.user_key = identity_population.user_key
  CROSS JOIN app_totals
  CROSS JOIN identity_revision
  LEFT JOIN ${appTable("sp_assignments")} assignment ON lower(assignment.email) = identity_population.user_key
  LEFT JOIN ${appTable("sp_personas")} persona ON persona.id = assignment.persona_id
  LEFT JOIN ${appTable("sp_persona_definitions")} definition ON definition.id = assignment.persona_id
  WHERE ($7 = '' OR identity_population.display_email LIKE ('%' || lower($7) || '%'))
    AND ($8 = '' OR identity_population.app_role = $8)
    AND ($9 = '' OR assignment.persona_id = $9)
)
SELECT filtered.*, refresh.status AS refresh_status,
       refresh.source_through AS refresh_source_through,
       refresh.billing_basis_through, refresh.completed_at AS refresh_completed_at
FROM filtered
LEFT JOIN ${USER_SPEND_HOURLY_REFRESH_TABLE} refresh
  ON refresh.app_scope = $1 AND refresh.calculation_version = $2
ORDER BY CASE WHEN $10 = 'DBU' THEN spend_dbu ELSE spend_usd END DESC NULLS LAST, user_key ASC
LIMIT $11 OFFSET $12`;var READ_USER_SPEND_HOURLY_COMPONENTS_QUERY=`SELECT component.key AS component_id,
       MIN(component.value->>'label') AS label,
       SUM((component.value->>'usd')::numeric) FILTER (WHERE component.value->>'usd' IS NOT NULL) AS spend_usd,
       SUM((component.value->>'dbu')::numeric) FILTER (WHERE component.value->>'dbu' IS NOT NULL) AS spend_dbu,
       CASE WHEN COUNT(*) FILTER (WHERE component.value->>'usd' IS NOT NULL) = 0 THEN 'unavailable' ELSE 'partial' END
         AS spend_usd_quality,
       CASE WHEN COUNT(*) FILTER (WHERE component.value->>'dbu' IS NOT NULL) = 0 THEN 'unavailable' ELSE 'partial' END
         AS spend_dbu_quality,
       'Estimated from exact hourly activity and the finest complete daily billing basis.' AS reason
FROM ${USER_SPEND_HOURLY_TABLE} hourly
CROSS JOIN LATERAL jsonb_each(hourly.components) component
WHERE hourly.app_scope = $1 AND hourly.calculation_version = $2
  AND hourly.user_key = lower($3)
  AND hourly.activity_hour >= $4::timestamptz AND hourly.activity_hour < $5::timestamptz
GROUP BY component.key ORDER BY component.key`;function quality2(value){return value==="partial"||value==="allocated"?value:"unavailable"}async function readUserSpendHourlyPage(store,input){const appScope=(input.appScope??process.env.DATABRICKS_APP_NAME??"").trim()||"player-insights";const version=input.calculationVersion??USER_SPEND_CALCULATION_VERSION;const limit=Math.max(1,Math.min(100,Math.trunc(input.limit??25)));const offset=Math.max(0,Math.trunc(input.offset??0));const result=await store.query(READ_USER_SPEND_HOURLY_SUMMARY_QUERY,[appScope,version,input.window.from,input.window.to,input.allowBrowse,input.principal.trim().toLowerCase(),(input.search??"").trim().slice(0,120),(input.role??"").trim(),(input.persona??"").trim(),input.unit,limit,offset,input.rosterOnly??input.allowBrowse]);const first=result.rows[0];const metadata=first??(await store.query(`SELECT status AS refresh_status, source_through AS refresh_source_through,
                billing_basis_through, completed_at AS refresh_completed_at,
                GREATEST(
                  (SELECT MAX(added_at) FROM ${appTable("admin_emails")}),
                  (SELECT MAX(updated_at) FROM ${appTable("sp_assignments")}),
                  (SELECT MAX(updated_at) FROM ${appTable("sp_personas")}),
                  (SELECT MAX(updated_at) FROM ${appTable("sp_persona_definitions")})
                ) AS identity_updated_at
         FROM ${USER_SPEND_HOURLY_REFRESH_TABLE}
         WHERE app_scope = $1 AND calculation_version = $2`,[appScope,version])).rows[0];const computedAt=stamp2(metadata?.refresh_completed_at)??stamp2(metadata?.computed_at);const sourceThrough=stamp2(metadata?.refresh_source_through)??stamp2(metadata?.source_through);const billingCompleteThrough=day2(metadata?.billing_basis_through);const now=input.now??Date.now();const rows=result.rows.map(row=>({email:typeof row.display_email==="string"?row.display_email:"",questions:number(row.submitted_questions),completedQuestions:number(row.completed_questions),runs:number(row.run_count),activeMinutes:number(row.active_minutes),totalTokens:nullableNumber2(row.total_tokens),tokenCoveredRuns:nullableNumber2(row.token_covered_runs),tokenCoveredQuestions:nullableNumber2(row.token_covered_questions),coveredDays:Math.ceil(number(row.covered_hours)/24),spendUsd:nullableNumber2(row.spend_usd),spendDbu:nullableNumber2(row.spend_dbu),spendUsdQuality:quality2(row.spend_usd_quality),spendDbuQuality:quality2(row.spend_dbu_quality),appSpendUsd:nullableNumber2(row.app_spend_usd),appSpendDbu:nullableNumber2(row.app_spend_dbu),activityComplete:true,billingComplete:false,role:row.app_role==="super_admin"||row.app_role==="admin"||row.app_role==="consumer"?row.app_role:"consumer",persona:typeof row.persona_id==="string"&&row.persona_id&&typeof row.persona_name==="string"?{id:row.persona_id,name:row.persona_name}:null,sourceThrough:stamp2(row.source_through),computedAt:stamp2(row.computed_at),identityRevision:stamp2(row.identity_updated_at)}));return{available:Boolean(first||computedAt),rows,total:number(first?.total_users),identityRevision:stamp2(first?.identity_updated_at)??stamp2(metadata?.identity_updated_at)??"",freshness:{computedAt,sourceThrough,billingCompleteThrough,isRefreshing:metadata?.refresh_status==="refreshing",isStale:computedAt===null||now-Date.parse(computedAt)>Math.max(6e4,input.staleMs??USER_SPEND_STALE_MS),calculationVersion:version}}}async function readUserSpendHourlyComponents(store,input){const appScope=(input.appScope??process.env.DATABRICKS_APP_NAME??"").trim()||"player-insights";const version=input.calculationVersion??USER_SPEND_CALCULATION_VERSION;const result=await store.query(READ_USER_SPEND_HOURLY_COMPONENTS_QUERY,[appScope,version,input.email.trim().toLowerCase(),input.window.from,input.window.to]);return result.rows.map(row=>({id:typeof row.component_id==="string"?row.component_id:"",label:typeof row.label==="string"?row.label:typeof row.component_id==="string"?row.component_id:"",usd:{amount:nullableNumber2(row.spend_usd),quality:quality2(row.spend_usd_quality)},dbu:{amount:nullableNumber2(row.spend_dbu),quality:quality2(row.spend_dbu_quality)},reason:typeof row.reason==="string"?row.reason:""}))}var stopActiveScheduler=null;function startUserSpendHourlyScheduler(store,options={}){stopActiveScheduler?.();let stopped=false;const run=()=>{if(stopped)return;void runUserSpendHourlyRefresh(store).catch(error=>{console.warn(`[user-spend-hourly] refresh failed (${safeErrorClass2(error)}); last successful rows remain.`)})};const warm=setTimeout(run,Math.floor(Math.random()*(Math.max(0,options.jitterMs??3e4)+1)));warm.unref?.();const timer=setInterval(run,Math.max(6e4,options.intervalMs??USER_SPEND_HOURLY_REFRESH_INTERVAL_MS));timer.unref?.();const stop=()=>{stopped=true;clearTimeout(warm);clearInterval(timer);process.off("beforeExit",stop);if(stopActiveScheduler===stop)stopActiveScheduler=null};process.once("beforeExit",stop);stopActiveScheduler=stop;return stop}function stopUserSpendHourlyScheduler(){stopActiveScheduler?.()}export{USER_SPEND_CALCULATION_VERSION,USER_SPEND_DAILY_TABLE,USER_SPEND_REFRESH_TABLE,USER_SPEND_READ_MODEL_DDL,runUserSpendReadModelRefresh,readUserSpendReadModelPage,readUserSpendReadModelComponents,USER_SPEND_HOURLY_RETENTION_DAYS,USER_SPEND_HOURLY_OVERLAP_HOURS,USER_SPEND_HOURLY_REFRESH_INTERVAL_MS,USER_SPEND_HOURLY_LEASE_MS,USER_SPEND_HOURLY_TABLE,USER_SPEND_HOURLY_REFRESH_TABLE,USER_SPEND_HOURLY_READ_MODEL_DDL,READ_USER_SPEND_HOURLY_SOURCE_QUERY,UPSERT_USER_SPEND_HOUR_QUERY,rollingCompleteHours,materializeUserSpendHours,runUserSpendHourlyRefresh,READ_USER_SPEND_HOURLY_SUMMARY_QUERY,READ_USER_SPEND_HOURLY_COMPONENTS_QUERY,readUserSpendHourlyPage,readUserSpendHourlyComponents,startUserSpendHourlyScheduler,stopUserSpendHourlyScheduler};
