
import{listDeclarableTablesInSchema,unionTableNames}from"./chunk-DEL2UBXP.mjs";import{ANSWER_LANDED_SQL,APP_ACTIVITY_TABLE,APP_SESSION_TABLE,PLAN_APPROVAL_MESSAGE,PROSE_ONLY_DEGRADED_SQL,VERDICT_STAGE_EXEMPTION_SQL,appSessionDeployment,bindSynthesisIncompleteSql,chooseRows,markResponse,mlflowReference,overlayJoinSql,readStored,runRuntimeUsedFromStored,userEmail,workspaceLinksAllowed}from"./chunk-CRZLPSII.mjs";import{FAILURE_TAXONOMY,accessDependenciesFrom,forwardedUserToken,isFailureCode,listSpAssignments,listSpPersonas,statementRunnerFor,verifyTableAccess}from"./chunk-VWGZVZ6G.mjs";import{resolveExperimentId}from"./chunk-NCE55VGM.mjs";import{ExpiringLruCache}from"./chunk-66G4LGYE.mjs";import{normalizeWorkspaceHost}from"./chunk-3KZTQDF5.mjs";import"./chunk-FKVP2HWJ.mjs";import{effectiveRole,everyKnownUser,invalidAdminEmail,readRosterForRequest,seedRoles}from"./chunk-MT5TZPIP.mjs";import"./chunk-3LJPB2Y3.mjs";import"./chunk-LHBUU3QA.mjs";import{isMlflowTraceId}from"./chunk-TOE5V7KL.mjs";import"./chunk-DDLERORI.mjs";import{APP_SCHEMA}from"./chunk-YKLXTEAM.mjs";import"./chunk-A7SHUGSC.mjs";var OUTCOME_BY_STATE={REFUSED:"refused",FAILED:"failed",DEADLINE_EXCEEDED:"failed",PERSISTENCE_FAILED:"failed",CLARIFICATION_REQUIRED:"partial",CANCELLED:"partial"};function classifyOutcome(input){const state=(input.runState??"").trim().toUpperCase();const writerMissed=state==="DEADLINE_EXCEEDED"||input.synthesisIncomplete===true;if(input.answerLanded&&writerMissed&&state!=="REFUSED"){return"partial"}if(state&&OUTCOME_BY_STATE[state])return OUTCOME_BY_STATE[state];if(input.proseOnlyDegraded)return"partial";if(state&&state!=="SUCCEEDED")return"partial";if(input.answerLanded&&(state==="SUCCEEDED"||input.hasStoredAnswer)){return"completed"}if(input.traceHasFailedStage)return"failed";if(input.traceHasPartialStage)return"partial";if(state==="SUCCEEDED"||input.hasStoredAnswer)return"completed";return"partial"}function applyAdminOutcome(classified,overlayStatus){const word=(overlayStatus??"").trim().toLowerCase();if(word==="complete"||word==="completed")return"completed";if(word==="partial")return"partial";if(word==="failed")return"failed";if(word==="refused")return"refused";return classified}function applyAdminFeedback(classified,overlayFeedback){const word=(overlayFeedback??"").trim().toLowerCase();if(word==="unrated"||word==="none")return null;if(word==="up"||word==="down")return word;return classified}var CAUSE_BY_LAYER={authorization:"missing-grant",governance:"agent-rules",evidence:"agent-rules"};function classifyRefusal(code){const value=(code??"").trim();if(!isFailureCode(value))return"other";return CAUSE_BY_LAYER[FAILURE_TAXONOMY[value].layer]??"other"}function refusalSentence(code){const value=(code??"").trim();return isFailureCode(value)?FAILURE_TAXONOMY[value].uiMessage:null}function feedbackDirection(sentiment,legacyUsefulness){const word=typeof sentiment==="string"?sentiment.trim().toLowerCase():"";if(word==="up"||word==="down")return word;const usefulness=typeof legacyUsefulness==="string"?Number(legacyUsefulness):typeof legacyUsefulness==="number"?legacyUsefulness:Number.NaN;if(!Number.isFinite(usefulness))return null;if(usefulness>=4&&usefulness<=5)return"up";if(usefulness>=1&&usefulness<=2)return"down";return null}var GRANT_CACHE_TTL_MS=3e4;var GRANT_CACHE_MAX_ENTRIES=256;function unresolvedGrants(now){return{resolved:false,verdicts:new Map,resolvedAt:now}}function conditioningFor(tables,grants){if(!grants.resolved)return null;for(const table of tables){const verdict=grants.verdicts.get(table);if(!verdict||verdict.status!=="denied")continue;return{table:verdict.missing?.object??table,permission:verdict.missing?.permission??"SELECT"}}return null}function cacheKey(key){return`${key.admin.trim().toLowerCase()}\0${key.window}`}var cache=new ExpiringLruCache(GRANT_CACHE_MAX_ENTRIES,GRANT_CACHE_TTL_MS);async function resolveGrants(options){const now=options.now??Date.now();const ttl=options.ttlMs??GRANT_CACHE_TTL_MS;const id=cacheKey(options.key);const cached=cache.get(id,now);if(cached)return cached;if(options.tables.length===0){const empty={resolved:true,verdicts:new Map,resolvedAt:now};cache.set(id,empty,now,ttl);return empty}if(!options.probe){const failed=unresolvedGrants(now);cache.set(id,failed,now,ttl);return failed}let outcome;try{outcome=await(options.verify??verifyTableAccess)(options.tables,options.probe,options.key.admin,options.verifyOptions)}catch(error){console.warn(`[monitoring] Table permissions could not be resolved for ${options.key.admin}: ${error.message}. Everything is shown, and the page says the check could not run.`);const failed=unresolvedGrants(now);cache.set(id,failed,now,ttl);return failed}if(outcome.blocked){console.warn(`[monitoring] Table permissions not established for ${options.key.admin}: ${outcome.blocked.kind}. Everything is shown.`);const failed=unresolvedGrants(now);cache.set(id,failed,now,ttl);return failed}const verdicts=new Map;for(const verdict of outcome.verdicts)verdicts.set(verdict.table,verdict);const resolution={resolved:true,verdicts,resolvedAt:now};cache.set(id,resolution,now,ttl);return resolution}var TABLE_POLICY_TTL_MS=10*6e4;var TABLE_POLICY_CACHE_MAX_ENTRIES=512;var PERSON_PRIVILEGE_TTL_MS=3e4;var PERSON_PRIVILEGE_CACHE_MAX_ENTRIES=2048;var tablePolicies=new ExpiringLruCache(TABLE_POLICY_CACHE_MAX_ENTRIES,TABLE_POLICY_TTL_MS);var personPrivileges=new ExpiringLruCache(PERSON_PRIVILEGE_CACHE_MAX_ENTRIES,PERSON_PRIVILEGE_TTL_MS);var QUESTION_PAGE_SIZE=50;var QUESTION_READ_LIMIT=100;var MONITORING_TOP_TABLE_LIMIT=5;var MONITORING_GRANT_PROBE_CONCURRENCY=6;var MONITORING_GRANT_PROBE_BUDGET_MS=2e4;var MONITORING_GRANT_STATEMENT_TIMEOUT_MS=7e3;var MONITORING_GRANT_WAIT_TIMEOUT_SECONDS=5;var MONITORING_TABLE_DISCOVERY_TIMEOUT_MS=5e3;var MONITORING_GRANT_VERIFY_OPTIONS={budgetMs:MONITORING_GRANT_PROBE_BUDGET_MS,concurrency:MONITORING_GRANT_PROBE_CONCURRENCY};var OFFSET_REFUSAL="Use the opaque cursor from pagination.nextCursor instead of an offset.";function encodeCursor(cursor){return Buffer.from(JSON.stringify(cursor),"utf8").toString("base64url")}function decodeCursor(raw){if(!raw)return null;try{const parsed=JSON.parse(Buffer.from(raw,"base64url").toString("utf8"));const askedAt=typeof parsed.askedAt==="string"?new Date(parsed.askedAt).toISOString():"";const id=typeof parsed.id==="string"?parsed.id.trim():"";return askedAt&&id?{askedAt,id}:null}catch{return null}}function monitoringCursor(askedAt,id){return encodeCursor({askedAt:new Date(askedAt).toISOString(),id})}function pageFrom(req){const limit=Number.parseInt(queryString(req.query.limit),10);const offset=Number.parseInt(queryString(req.query.offset),10);const rawCursor=queryString(req.query.cursor).trim();const cursor=decodeCursor(rawCursor);return{limit:Number.isFinite(limit)&&limit>0?Math.min(limit,QUESTION_READ_LIMIT):QUESTION_PAGE_SIZE,cursor,refusal:Number.isFinite(offset)&&offset>0?OFFSET_REFUSAL:rawCursor&&!cursor?"The Monitoring page cursor is invalid. Start again without a cursor.":""}}var MONITORING_QUESTIONS_QUERY=`
  WITH page AS (
    SELECT u.id AS question_id, u.conversation_id, u.content AS question,
           u.created_at AS asked_at, c.user_email
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1
      AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz
      AND ($5 = '' OR lower(c.user_email) = lower($5))
      AND ($6 = '' OR (u.created_at, u.id) < ($6::timestamptz, $7))
      AND (
        $8 = ''
        OR lower(u.content) LIKE ('%' || lower($8) || '%')
        OR lower(c.user_email) LIKE ('%' || lower($8) || '%')
      )
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT $4
  ),
  range_totals AS (
    SELECT COUNT(*)::int AS asked_total,
           COUNT(DISTINCT u.conversation_id)::int AS thread_total,
           COALESCE(array_agg(DISTINCT c.user_email), ARRAY[]::text[]) AS people_list
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1
      AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz
      AND ($5 = '' OR lower(c.user_email) = lower($5))
      AND (
        $8 = ''
        OR lower(u.content) LIKE ('%' || lower($8) || '%')
        OR lower(c.user_email) LIKE ('%' || lower($8) || '%')
      )
  )
  SELECT t.asked_total, t.thread_total, t.people_list,
         q.question_id, q.conversation_id, q.question, q.asked_at, q.user_email,
         a.id AS answer_id, a.trace_id,
         a.execution_mode, a.execution_identity_verified, a.access_mode,
         a.response_json->'trace'->>'totalMs' AS total_ms,
         a.response_json->'trace'->>'toolCalls' AS tool_calls,
         a.response_json->'trace'->>'total_tokens' AS total_tokens,
         jsonb_path_exists(a.response_json->'trace', '$.stages[*] ? (@.status == "failed" ${VERDICT_STAGE_EXEMPTION_SQL})') AS trace_failed,
         jsonb_path_exists(
           a.response_json->'trace',
           '$.stages[*] ? (@.status == "partial" ${VERDICT_STAGE_EXEMPTION_SQL})'
         ) AS trace_partial,
         ${ANSWER_LANDED_SQL.split("payload").join("a.response_json")} AS answer_landed,
         ${bindSynthesisIncompleteSql("a.response_json->'trace'","a.response_json->'caveats'")} AS synthesis_incomplete,
         ${PROSE_ONLY_DEGRADED_SQL.split("payload").join("a.response_json").split("caveats").join("a.response_json->'caveats'")} AS prose_only_degraded,
         label_overlay.status AS overlay_status,
         label_overlay.rating AS overlay_rating,
         (SELECT COALESCE(jsonb_agg(s->>'name'), '[]'::jsonb)
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(a.response_json->'sources') = 'array'
                        THEN a.response_json->'sources' ELSE '[]'::jsonb END) s
           WHERE s->>'name' IS NOT NULL) AS sources,
         f.sentiment, f.usefulness, f.comment
  FROM range_totals t
  LEFT JOIN page q ON TRUE
  LEFT JOIN LATERAL (
    SELECT m.id, m.response_json, m.trace_id, m.execution_mode,
           m.execution_identity_verified, m.access_mode
    FROM ${APP_SCHEMA}.messages m
    WHERE m.conversation_id = q.conversation_id
      AND m.role = 'assistant'
      AND jsonb_typeof(m.response_json->'trace') = 'object'
      AND m.created_at >= q.asked_at
      AND m.created_at < COALESCE(
            (SELECT MIN(u.created_at) FROM ${APP_SCHEMA}.messages u
              WHERE u.conversation_id = q.conversation_id AND u.role = 'user'
                AND u.content <> $1 AND u.created_at > q.asked_at),
            'infinity'::timestamptz)
    -- The turn's FINAL assistant message, not its first. A turn that went
    -- through plan approval has the proposed plan in this window as well as the
    -- answer, and the plan's trace carries neither \`totalMs\` nor \`toolCalls\`.
    -- Taking the first left Monitoring's Time and Tools blank for exactly those
    -- turns while Run Explorer, which reads the answer, showed both. The
    -- \`totalMs\` test leads so the row carrying the figures wins outright rather
    -- than by being latest; \`created_at DESC\` settles the rest.
    ORDER BY (m.response_json->'trace'->>'totalMs') IS NOT NULL DESC,
             m.created_at DESC
    LIMIT 1
  ) a ON TRUE
  LEFT JOIN LATERAL (
    SELECT fb.sentiment, fb.usefulness, fb.comment
    FROM ${APP_SCHEMA}.feedback fb
    WHERE fb.message_id = a.id AND fb.user_email = q.user_email
    ORDER BY fb.created_at DESC LIMIT 1
  ) f ON TRUE
  ${overlayJoinSql("a.id")}
  ORDER BY q.asked_at DESC, q.question_id DESC
`;var MONITORING_LEDGER_QUERY=`
  SELECT terminal_message_id AS answer_id, state, terminal_code
  FROM ${APP_SCHEMA}.runs
  WHERE terminal_message_id = ANY($1::text[])
`;var MONITORING_DETAIL_QUERY=`
  SELECT q.id AS question_id, q.conversation_id, q.content AS question,
         q.created_at AS asked_at, c.user_email,
         a.id AS answer_id, a.trace_id, a.response_json,
         jsonb_path_exists(a.response_json->'trace', '$.stages[*] ? (@.status == "failed" ${VERDICT_STAGE_EXEMPTION_SQL})') AS trace_failed,
         jsonb_path_exists(
           a.response_json->'trace',
           '$.stages[*] ? (@.status == "partial" ${VERDICT_STAGE_EXEMPTION_SQL})'
         ) AS trace_partial,
         ${ANSWER_LANDED_SQL.split("payload").join("a.response_json")} AS answer_landed,
         ${bindSynthesisIncompleteSql("a.response_json->'trace'","a.response_json->'caveats'")} AS synthesis_incomplete,
         ${PROSE_ONLY_DEGRADED_SQL.split("payload").join("a.response_json").split("caveats").join("a.response_json->'caveats'")} AS prose_only_degraded,
         label_overlay.status AS overlay_status,
         label_overlay.rating AS overlay_rating,
         a.execution_mode, a.execution_identity_verified,
         (SELECT COALESCE(jsonb_agg(s->>'name'), '[]'::jsonb)
            FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(a.response_json->'sources') = 'array'
                        THEN a.response_json->'sources' ELSE '[]'::jsonb END) s
           WHERE s->>'name' IS NOT NULL) AS sources,
         f.sentiment, f.usefulness, f.comment
  FROM ${APP_SCHEMA}.messages q
  JOIN ${APP_SCHEMA}.conversations c ON c.id = q.conversation_id
  LEFT JOIN LATERAL (
    SELECT m.id, m.response_json, m.trace_id, m.execution_mode, m.execution_identity_verified
    FROM ${APP_SCHEMA}.messages m
    WHERE m.conversation_id = q.conversation_id AND m.role = 'assistant'
      AND jsonb_typeof(m.response_json->'trace') = 'object'
      AND m.created_at >= q.created_at
      AND (SELECT u.id FROM ${APP_SCHEMA}.messages u
            WHERE u.conversation_id = m.conversation_id AND u.role = 'user'
              AND u.content <> $2 AND u.created_at <= m.created_at
            ORDER BY u.created_at DESC LIMIT 1) = q.id
    -- Same "the answer, not the plan" rule as MONITORING_QUESTIONS_QUERY, and
    -- for the same reason: the drawer opened on an approved-plan row was reading
    -- the plan's trace, so it disagreed with the row it was opened from.
    ORDER BY (m.response_json->'trace'->>'totalMs') IS NOT NULL DESC,
             m.created_at DESC
    LIMIT 1
  ) a ON TRUE
  LEFT JOIN LATERAL (
    SELECT fb.sentiment, fb.usefulness, fb.comment
    FROM ${APP_SCHEMA}.feedback fb
    WHERE fb.message_id = a.id AND fb.user_email = c.user_email
    ORDER BY fb.created_at DESC LIMIT 1
  ) f ON TRUE
  ${overlayJoinSql("a.id")}
  WHERE q.id = $1 AND q.role = 'user'
    AND q.created_at >= $3::timestamptz AND q.created_at < $4::timestamptz
`;var MONITORING_PERSON_SEEN_QUERY=`
  WITH evidence AS (
    SELECT u.created_at AS occurred_at
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1 AND c.user_email = $2
    UNION ALL
    SELECT r.created_at
    FROM ${APP_SCHEMA}.runs r
    WHERE lower(r.user_email) = lower($2)
    UNION ALL
    SELECT f.created_at
    FROM ${APP_SCHEMA}.feedback f
    WHERE lower(f.user_email) = lower($2)
    UNION ALL
    SELECT a.active_minute
    FROM ${APP_ACTIVITY_TABLE} a
    WHERE lower(a.user_email) = lower($2)
    UNION ALL
    SELECT s.created_at
    FROM ${APP_SESSION_TABLE} s
    WHERE s.deployment_key = $3 AND lower(s.subject) = lower($2)
  )
  SELECT MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen
  FROM evidence
`;var MONITORING_PERSON_TABLES_QUERY=`
  WITH asked AS (
    SELECT u.id AS question_id, u.conversation_id, u.created_at AS asked_at
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1
      AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz
      AND lower(c.user_email) = lower($4)
  ),
  answered AS (
    SELECT q.question_id, a.id AS answer_id, a.response_json
    FROM asked q
    JOIN LATERAL (
      SELECT m.id, m.response_json
      FROM ${APP_SCHEMA}.messages m
      WHERE m.conversation_id = q.conversation_id
        AND m.role = 'assistant'
        AND jsonb_typeof(m.response_json->'trace') = 'object'
        AND m.created_at >= q.asked_at
        AND m.created_at < COALESCE(
              (SELECT MIN(u.created_at) FROM ${APP_SCHEMA}.messages u
                WHERE u.conversation_id = q.conversation_id AND u.role = 'user'
                  AND u.content <> $1 AND u.created_at > q.asked_at),
              'infinity'::timestamptz)
      ORDER BY (m.response_json->'trace'->>'totalMs') IS NOT NULL DESC,
               m.created_at DESC
      LIMIT 1
    ) a ON TRUE
  ),
  source_runs AS (
    SELECT lower(source->>'name') AS table_key,
           MIN(source->>'name') AS table_name,
           COUNT(DISTINCT a.answer_id)::int AS runs
    FROM answered a
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(a.response_json->'sources') = 'array'
           THEN a.response_json->'sources' ELSE '[]'::jsonb END
    ) source
    WHERE source->>'name' ~ '^[^.]+[.][^.]+[.][^.]+$'
    GROUP BY lower(source->>'name')
  )
  SELECT table_name, runs
  FROM source_runs
  ORDER BY runs DESC, table_name ASC
  LIMIT $5
`;var MONITORING_PERSON_TABLE_EVIDENCE_QUERY=`
  WITH asked AS (
    SELECT u.conversation_id, u.created_at AS asked_at
    FROM ${APP_SCHEMA}.messages u
    JOIN ${APP_SCHEMA}.conversations c ON c.id = u.conversation_id
    WHERE u.role = 'user' AND u.content <> $1
      AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz
      AND lower(c.user_email) = lower($4)
  ),
  answered AS (
    SELECT a.id AS answer_id, a.response_json, a.created_at
    FROM asked q
    JOIN LATERAL (
      SELECT m.id, m.response_json, m.created_at
      FROM ${APP_SCHEMA}.messages m
      WHERE m.conversation_id = q.conversation_id
        AND m.role = 'assistant'
        AND m.execution_mode = 'signed_in_user'
        AND m.execution_identity_verified = TRUE
        AND jsonb_typeof(m.response_json->'sources') = 'array'
        AND m.created_at >= q.asked_at
      ORDER BY m.created_at DESC
      LIMIT 1
    ) a ON TRUE
  )
  SELECT lower(source->>'name') AS table_key,
         COUNT(DISTINCT answered.answer_id)::int AS runs,
         MAX(answered.created_at) AS latest_read_at
  FROM answered
  CROSS JOIN LATERAL jsonb_array_elements(answered.response_json->'sources') source
  WHERE lower(source->>'name') = ANY($5::text[])
  GROUP BY lower(source->>'name')
`;function manifestTables(){return accessDependenciesFrom({env:process.env}).tables}async function declaredTablesForRequest(req){const configured=manifestTables();const discovered=await listDeclarableTablesInSchema({catalog:(process.env.PLAYER_INSIGHTS_CATALOG??"").trim(),schema:(process.env.PLAYER_INSIGHTS_SCHEMA??"").trim(),host:normalizeWorkspaceHost(process.env.DATABRICKS_HOST),token:forwardedUserToken(req)??"",denylist:(process.env.PLAYER_INSIGHTS_CATALOG_DENYLIST??"").split(",").map(entry=>entry.trim()).filter(Boolean),timeoutMs:MONITORING_TABLE_DISCOVERY_TIMEOUT_MS});return unionTableNames(configured,discovered)}function liveSelfGrantLedger(tables,resolution){return tables.map(table=>{const verdict=resolution.verdicts.get(table);return{table,canRead:verdict?.status==="ok"?true:verdict?.status==="denied"?false:null,missing:verdict?.status==="denied"?verdict.missing?.permission??"SELECT missing":null,rowFilter:null,maskedColumns:null,source:"live-user-probe",verifiedRuns:0,latestVerifiedReadAt:null}})}function historicalGrantLedger(tables,rows){const evidence=new Map(rows.map(row=>[text(row.table_key).toLowerCase(),{runs:integer(row.runs)??0,latest:stamp(row.latest_read_at)||null}]));return tables.map(table=>{const recorded=evidence.get(table.toLowerCase());return{table,canRead:recorded&&recorded.runs>0?true:null,missing:null,rowFilter:null,maskedColumns:null,source:recorded&&recorded.runs>0?"verified-run":"no-evidence",verifiedRuns:recorded?.runs??0,latestVerifiedReadAt:recorded?.latest??null}})}var PLAN_APPROVAL_SENTINEL=PLAN_APPROVAL_MESSAGE;function queryString(value){return typeof value==="string"?value:""}function text(value){return typeof value==="string"?value:""}function integer(value){if(typeof value==="number")return Number.isFinite(value)?Math.round(value):null;if(typeof value!=="string")return null;const parsed=Number.parseFloat(value);return Number.isFinite(parsed)?Math.round(parsed):null}function tokenCount(value){const parsed=integer(value);return parsed!==null&&parsed>=0?parsed:null}function stamp(value){if(value instanceof Date)return value.toISOString();const raw=text(value);const parsed=Date.parse(raw);return Number.isFinite(parsed)?new Date(parsed).toISOString():""}function tableList(value){if(!Array.isArray(value))return[];const seen=new Map;for(const entry of value){const name=text(entry).trim();if(name.split(".").filter(part=>part.length>0).length===3){const normalized=name.toLowerCase();if(!seen.has(normalized))seen.set(normalized,name)}}return[...seen.values()]}function traceOf(response){if(!response||typeof response!=="object")return null;const trace=response.trace;return trace&&typeof trace==="object"?trace:null}function responseWithTokenAttribution(response,attribution){if(!response||typeof response!=="object"||!attribution)return response;const answer=response;const trace=traceOf(answer);if(!trace||typeof trace!=="object")return response;const traceRecord=trace;const stages=Array.isArray(traceRecord.stages)?traceRecord.stages:[];return{...answer,trace:{...traceRecord,stages:stages.map(stage=>{if(!stage||typeof stage!=="object")return stage;const record=stage;const usage=attribution.stages[text(record.id)];return usage?{...record,token_usage:usage}:record}),token_reconciliation:attribution.reconciliation,token_invocations:attribution.invocations}}}function tokensOf(response){const trace=traceOf(response);if(!trace)return null;const prompt=integer(trace.prompt_tokens);const completion=integer(trace.completion_tokens);const total=integer(trace.total_tokens);if(prompt===null&&completion===null&&total===null)return null;return{prompt,completion,total}}function questionRows(rows){return rows.filter(row=>text(row.question_id)!=="")}function rangeTotalsFrom(row,page){const asked=integer(row?.asked_total);const threads=integer(row?.thread_total);const listed=Array.isArray(row?.people_list)?row.people_list.map(entry=>text(entry)).filter(email=>email!==""):null;const fromPage=[...new Set(page.map(question=>question.askedBy).filter(email=>email!==""))].sort();const threadsFromPage=new Set(page.map(question=>question.conversationId).filter(Boolean)).size;return{asked:asked!==null&&asked>=page.length?asked:page.length,threads:threads!==null&&threads>=0?threads:threadsFromPage,peopleList:listed===null?fromPage:[...listed].sort()}}function questionFromRow(row,ledger){const answerId=text(row.answer_id);const verdict=answerId?ledger.get(answerId):void 0;const outcome=applyAdminOutcome(classifyOutcome({runState:verdict?.state??null,hasStoredAnswer:answerId!=="",traceHasFailedStage:row.trace_failed===true,traceHasPartialStage:row.trace_partial===true,answerLanded:row.answer_landed===true,synthesisIncomplete:row.synthesis_incomplete===true,proseOnlyDegraded:row.prose_only_degraded===true}),text(row.overlay_status));return{id:text(row.question_id),conversationId:text(row.conversation_id),question:text(row.question),askedBy:text(row.user_email),askedAt:stamp(row.asked_at),outcome,outcomeDetail:refusalSentence(verdict?.code),durationMs:integer(row.total_ms),toolCalls:integer(row.tool_calls),totalTokens:tokenCount(row.total_tokens),feedback:applyAdminFeedback(feedbackDirection(row.sentiment,row.usefulness),text(row.overlay_rating)),tables:tableList(row.sources)}}function summarize(questions,userThreads){const buckets={completed:0,partial:0,refused:0,failed:0};let helpful=0;let feedbackTotal=0;const durations=[];for(const question of questions){buckets[question.outcome]+=1;if(question.feedback==="up"){helpful+=1;feedbackTotal+=1}else if(question.feedback==="down"){feedbackTotal+=1}if(question.durationMs!==null)durations.push(question.durationMs)}durations.sort((a,b)=>a-b);return{questionsAsked:questions.length,userThreads,completed:buckets.completed,partial:buckets.partial,refused:buckets.refused,failed:buckets.failed,helpful,feedbackTotal,medianMs:durations.length>0?durations[Math.floor((durations.length-1)/2)]:null,timedCount:durations.length}}function rankTablesRead(questions,limit=MONITORING_TOP_TABLE_LIMIT){const counted=new Set;const totals=new Map;for(const question of questions){for(const table of question.tables){const normalized=table.trim().toLowerCase();if(!normalized)continue;const pair=`${question.id}\0${normalized}`;if(counted.has(pair))continue;counted.add(pair);const current=totals.get(normalized);if(current)current.runs+=1;else totals.set(normalized,{table:table.trim(),runs:1})}}return[...totals.values()].sort((left,right)=>right.runs-left.runs||left.table.localeCompare(right.table)).slice(0,Math.max(0,limit))}function rangeFrom(req,now=Date.now()){const from=Date.parse(queryString(req.query.from));const to=Date.parse(queryString(req.query.to));if(Number.isFinite(from)&&Number.isFinite(to)&&to>from){return{from:new Date(from).toISOString(),to:new Date(to).toISOString()}}return{from:new Date(now-7*864e5).toISOString(),to:new Date(now).toISOString()}}function filtersFrom(req,person=queryString(req.query.person).trim()){const outcome=queryString(req.query.outcome).trim();const feedback=(queryString(req.query.feedback)||queryString(req.query.rating)).trim();return{person,outcome:["completed","partial","refused","failed"].includes(outcome)?outcome:"",feedback:["up","down","none","unrated"].includes(feedback)?feedback==="unrated"?"none":feedback:"",table:queryString(req.query.table).trim(),search:queryString(req.query.q).trim()}}function matchingQuestions(questions,filters){const person=filters.person.toLowerCase();const search=filters.search.toLowerCase();const table=filters.table.toLowerCase();const feedback=filters.feedback??(filters.rating==="unrated"?"none":filters.rating??"");return questions.filter(question=>{if(person&&question.askedBy.toLowerCase()!==person)return false;if(filters.outcome&&question.outcome!==filters.outcome)return false;if(feedback==="none"&&question.feedback!==null)return false;if((feedback==="up"||feedback==="down")&&question.feedback!==feedback){return false}if(table&&!question.tables.some(name=>name.toLowerCase()===table))return false;if(search&&!`${question.question} ${question.askedBy} ${question.askedBy.split("@")[0]}`.toLowerCase().includes(search)){return false}return true})}function paginationFor(input){const hasMore=input.rawPage.length>input.page.limit;const last=hasMore?input.rawPage[input.page.limit-1]:null;return{pageSize:input.page.limit,total:input.total,hasMore,nextCursor:last?encodeCursor({askedAt:last.askedAt,id:last.id}):null}}async function readLedger(appkit,answerIds){const verdicts=new Map;if(answerIds.length===0)return verdicts;try{const result=await appkit.lakebase.query(MONITORING_LEDGER_QUERY,[answerIds]);for(const row of result.rows){const id=text(row.answer_id);if(!id)continue;verdicts.set(id,{state:text(row.state),code:text(row.terminal_code)||null})}}catch(error){console.warn(`[monitoring] The run ledger could not be read (${error.message}). Outcomes fall back to each answer’s stored trace, which cannot tell a refusal from a failure by code.`)}return verdicts}function probeForAdmin(req){const host=normalizeWorkspaceHost(process.env.DATABRICKS_HOST);const warehouseId=(process.env.DATABRICKS_SQL_WAREHOUSE_ID??"").trim();const token=forwardedUserToken(req);if(!host||!warehouseId||!token)return null;return statementRunnerFor({host,token,warehouseId,timeoutMs:MONITORING_GRANT_STATEMENT_TIMEOUT_MS,waitTimeoutSeconds:MONITORING_GRANT_WAIT_TIMEOUT_SECONDS})}var MONITORING_ROUTES=["/api/monitoring/questions","/api/monitoring/questions/:id","/api/monitoring/people/:email"];function setupMonitoringRoutes(appkit,deps){if(typeof deps?.isAdminRoute!=="function"){console.error("[monitoring] NOT REGISTERED: no admin-route predicate was supplied, so there is no way to confirm these paths are guarded. They serve every person’s questions and answers. Pass isAdminRoute.");return}const uncovered=MONITORING_ROUTES.filter(path=>!deps.isAdminRoute(path));if(uncovered.length>0){console.error(`[monitoring] NOT REGISTERED: the admin guard does not cover ${uncovered.join(", ")}. Add the prefix to ADMIN_ROUTE_PREFIXES in lib/admin-roles.ts. Registering these unguarded would serve every person’s questions and answers to any signed-in reader.`);return}const probeFor=deps.probeFor??probeForAdmin;const clock=deps.now??Date.now;const declaredTables=deps.declaredTablesFor??declaredTablesForRequest;appkit.server.extend(app=>{app.get("/api/monitoring/questions",async(req,res)=>{const admin=userEmail(req);const range=rangeFrom(req,clock());const page=pageFrom(req);const filters=filtersFrom(req);if(page.refusal){res.status(400).json({error:page.refusal});return}const stored=await readStored(appkit,"GET /api/monitoring/questions",MONITORING_QUESTIONS_QUERY,[PLAN_APPROVAL_SENTINEL,range.from,range.to,page.limit+1,filters.person,page.cursor?.askedAt??"",page.cursor?.id??"",filters.search]);const{rows,substitution}=chooseRows("GET /api/monitoring/questions",stored.available?{available:true,rows:questionRows(stored.rows)}:stored);markResponse(res,substitution);const readAt=new Date(clock()).toISOString();if(!stored.available){res.status(503).json({readState:"unavailable",readAt,summary:summarize([],0),questions:[],people:[],tables:[],grantsResolution:"ok",pagination:{pageSize:page.limit,total:null,hasMore:false,nextCursor:null}});return}const answerIds=rows.map(row=>text(row.answer_id)).filter(id=>id!=="");const ledger=await readLedger(appkit,answerIds);const rawPage=rows.map(row=>questionFromRow(row,ledger));const pageRows=rawPage.slice(0,page.limit);const all=matchingQuestions(pageRows,filters);const totals=rangeTotalsFrom(stored.rows[0],all);const found=totals.asked;const threads=totals.threads;const peopleList=totals.peopleList;const distinctTables=[...new Set(all.flatMap(question=>question.tables))].sort();const tableOptions=[...new Set([...distinctTables,...filters.table?[filters.table]:[]])].sort();const peopleOptions=[...new Set([...peopleList,...filters.person?[filters.person]:[]])].sort();const grants=await resolveGrants({key:{admin,window:`${range.from}|${range.to}`},tables:distinctTables,probe:probeFor(req),now:clock(),verifyOptions:MONITORING_GRANT_VERIFY_OPTIONS});const exactTotal=filters.outcome||filters.feedback||filters.table?null:found;const pagination=paginationFor({page,rawPage,total:exactTotal});const partial=pagination.hasMore||page.cursor!==null;res.json({readState:partial?"partial":"ok",readAt,summary:summarize(all,threads),...partial?{countedQuestions:all.length,...exactTotal!==null?{foundQuestions:exactTotal}:{}}:{},questions:all,people:peopleOptions,tables:tableOptions,grantsResolution:grants.resolved?"ok":"failed",pagination})});app.get("/api/monitoring/questions/:id",async(req,res)=>{const admin=userEmail(req);const range=rangeFrom(req,clock());const stored=await readStored(appkit,"GET /api/monitoring/questions/:id",MONITORING_DETAIL_QUERY,[req.params.id,PLAN_APPROVAL_SENTINEL,range.from,range.to]);if(!stored.available){res.status(503).json({error:"storage_unavailable"});return}const row=stored.rows[0];if(!row){res.status(404).json({error:"question_not_found"});return}const answerId=text(row.answer_id);const ledger=await readLedger(appkit,answerId?[answerId]:[]);const verdict=answerId?ledger.get(answerId):void 0;const tables=tableList(row.sources);const grants=await resolveGrants({key:{admin,window:`${range.from}|${range.to}`},tables,probe:probeFor(req),now:clock(),verifyOptions:MONITORING_GRANT_VERIFY_OPTIONS});const conditioning=conditioningFor(tables,grants);const traceId=text(row.trace_id);const storedTrace=traceOf(row.response_json);const stageIds=Array.isArray(storedTrace?.stages)?storedTrace.stages.map(stage=>stage&&typeof stage==="object"?text(stage.id):"").filter(Boolean):[];const attribution=deps.traceTokenEvidenceReader&&isMlflowTraceId(traceId)?await deps.traceTokenEvidenceReader(traceId,stageIds,tokenCount(storedTrace?.total_tokens)??void 0):null;const enrichedResponse=responseWithTokenAttribution(row.response_json,attribution);const mlflow=traceId?mlflowReference(traceId,await resolveExperimentId(appkit)):null;const executionMode=text(row.execution_mode);const detail={id:text(row.question_id),conversationId:text(row.conversation_id),question:text(row.question),askedBy:text(row.user_email),askedAt:stamp(row.asked_at),outcome:applyAdminOutcome(classifyOutcome({runState:verdict?.state??null,hasStoredAnswer:answerId!=="",traceHasFailedStage:row.trace_failed===true,traceHasPartialStage:row.trace_partial===true,answerLanded:row.answer_landed===true,synthesisIncomplete:row.synthesis_incomplete===true,proseOnlyDegraded:row.prose_only_degraded===true}),text(row.overlay_status)),outcomeDetail:refusalSentence(verdict?.code),outcomeCode:verdict?.code??null,answer:conditioning?null:enrichedResponse??null,conditioning,trace:traceOf(enrichedResponse),tokens:tokensOf(enrichedResponse),execution:executionMode&&typeof row.execution_identity_verified==="boolean"?{mode:executionMode,verified:row.execution_identity_verified}:null,feedback:applyAdminFeedback(feedbackDirection(row.sentiment,row.usefulness),text(row.overlay_rating)),comment:applyAdminFeedback(feedbackDirection(row.sentiment,row.usefulness),text(row.overlay_rating))==="down"?text(row.comment)||null:null,mlflowUrl:await workspaceLinksAllowed(appkit)?mlflow?.url??null:null,runId:answerId||null,runtimeUsed:runRuntimeUsedFromStored(row.response_json)};res.json(detail)});app.get("/api/monitoring/people/:email",async(req,res)=>{const admin=userEmail(req);const person=decodeURIComponent(String(req.params.email));if(invalidAdminEmail(person)){res.status(400).json({error:"invalid_monitoring_user"});return}let roster;try{roster=await readRosterForRequest(appkit.lakebase,req)}catch{res.status(503).json({error:"identity_roster_unavailable"});return}const identityRoster=everyKnownUser({seed:seedRoles(),stored:roster.rows});if(!identityRoster.some(entry=>entry.email===person.trim().toLowerCase())){res.status(404).json({error:"monitoring_user_not_rostered"});return}const range=rangeFrom(req,clock());const page=pageFrom(req);const filters=filtersFrom(req,person);if(page.refusal){res.status(400).json({error:page.refusal});return}const readAt=new Date(clock()).toISOString();const stored=await readStored(appkit,"GET /api/monitoring/people/:email",MONITORING_QUESTIONS_QUERY,[PLAN_APPROVAL_SENTINEL,range.from,range.to,page.limit+1,person,page.cursor?.askedAt??"",page.cursor?.id??"",filters.search]);if(!stored.available){res.status(503).json({error:"storage_unavailable"});return}const mine=questionRows(stored.rows).filter(row=>text(row.user_email).toLowerCase()===person.toLowerCase());const answerIds=mine.map(row=>text(row.answer_id)).filter(id=>id!=="");const ledger=await readLedger(appkit,answerIds);const rawPage=mine.map(row=>questionFromRow(row,ledger));const questions=matchingQuestions(rawPage.slice(0,page.limit),filters);const selectedQuestionIds=new Set(questions.map(question=>question.id));const selectedRows=mine.filter(row=>selectedQuestionIds.has(text(row.question_id)));const selectedAnswerIds=selectedRows.map(row=>text(row.answer_id)).filter(id=>id!=="");const totals=rangeTotalsFrom(stored.rows[0],questions);const exactTotal=filters.outcome||filters.feedback||filters.table?null:totals.asked;const pagination=paginationFor({page,rawPage,total:exactTotal});let tokenTotal=0;let metredRuns=0;for(const row of selectedRows){const tokens=integer(row.total_tokens);if(tokens!==null&&tokens>0){tokenTotal+=tokens;metredRuns+=1}}const executionSplit={asThemselves:0,asApplication:0,unrecorded:0};const subjectSplit={verified:0,confirmedByEndpoint:0,unrecorded:0};for(const row of selectedRows){const mode=text(row.execution_mode);if(mode==="signed_in_user")executionSplit.asThemselves+=1;else if(mode==="app_service_principal")executionSplit.asApplication+=1;else executionSplit.unrecorded+=1;if(typeof row.execution_identity_verified==="boolean"){if(row.execution_identity_verified)subjectSplit.verified+=1;else subjectSplit.confirmedByEndpoint+=1}else subjectSplit.unrecorded+=1}let refusedMissingGrant=0;let refusedAgentRules=0;for(const id of selectedAnswerIds){const verdict=ledger.get(id);if(!verdict||verdict.state!=="REFUSED")continue;const cause=classifyRefusal(verdict.code);if(cause==="missing-grant")refusedMissingGrant+=1;else if(cause==="agent-rules")refusedAgentRules+=1}const tableResult=await appkit.lakebase.query(MONITORING_PERSON_TABLES_QUERY,[PLAN_APPROVAL_SENTINEL,range.from,range.to,person,MONITORING_TOP_TABLE_LIMIT]);const tablesReadMost=tableResult.rows.map(row=>{const table=tableList([row.table_name])[0]??"";const runs=integer(row.runs);return table&&runs!==null&&runs>0?{table,runs}:null}).filter(entry=>entry!==null).sort((left,right)=>right.runs-left.runs||left.table.localeCompare(right.table)).slice(0,MONITORING_TOP_TABLE_LIMIT);const wanted=await declaredTables(req);let grants=null;const self=admin.trim().toLowerCase()===person.trim().toLowerCase();if(wanted.length>0){if(self){const resolution=await resolveGrants({key:{admin,window:`person-self:${range.from}:${range.to}`},tables:wanted,probe:probeFor(req),now:clock(),verifyOptions:MONITORING_GRANT_VERIFY_OPTIONS});grants=liveSelfGrantLedger(wanted,resolution)}else{const evidenceResult=await appkit.lakebase.query(MONITORING_PERSON_TABLE_EVIDENCE_QUERY,[PLAN_APPROVAL_SENTINEL,range.from,range.to,person,wanted.map(table=>table.toLowerCase())]);grants=historicalGrantLedger(wanted,evidenceResult.rows)}}let firstSeen=null;let lastSeen=null;try{const seen=await appkit.lakebase.query(MONITORING_PERSON_SEEN_QUERY,[PLAN_APPROVAL_SENTINEL,person,appSessionDeployment()??"__unavailable__"]);firstSeen=stamp(seen.rows[0]?.first_seen)||null;lastSeen=stamp(seen.rows[0]?.last_seen)||null}catch(error){console.warn(`[monitoring] First and last seen could not be read for ${person}: ${error.message}`)}const[personaCatalog,personaAssignments]=await Promise.all([listSpPersonas(appkit).catch(()=>[]),listSpAssignments(appkit).catch(()=>[])]);const role=effectiveRole({seed:seedRoles(),stored:roster.rows,email:person});const assignment=personaAssignments.find(entry=>entry.email.toLowerCase()===person.toLowerCase());const assignedPersona=assignment?personaCatalog.find(entry=>entry.id===assignment.personaId):void 0;const assignedPersonaName=assignedPersona?.displayName.trim()??"";const persona=assignedPersona&&assignedPersonaName&&!/^(no persona|none|unassigned|n\/a|null|unknown)$/i.test(assignedPersonaName)?{id:assignedPersona.id,name:assignedPersonaName}:null;const payload={email:person,role,persona,firstSeen,lastSeen,summary:summarize(questions,totals.threads),durationsMs:questions.map(question=>question.durationMs).filter(ms=>ms!==null),tokens:{total:tokenTotal,metredRuns,totalRuns:questions.length},tokenCostUsd:tokenCost(tokenTotal,metredRuns),helpful:questions.filter(question=>question.feedback==="up").length,notHelpful:questions.filter(question=>question.feedback==="down").length,tablesReadMost,executionSplit,subjectSplit,grants,grantsMode:self?"live-self":"historical",refusedMissingGrant,refusedAgentRules,questions,readState:pagination.hasMore||page.cursor!==null?"partial":"ok",readAt,pagination};void admin;res.json(payload)})});console.log("[monitoring] Registered the Monitoring read routes. The admin guard's prefix list covers all of them.")}function tokenCost(totalTokens,metredRuns){if(metredRuns<=0)return null;const raw=(process.env.PLAYER_INSIGHTS_TOKEN_PRICE_PER_MILLION_USD??"").trim();if(!raw)return null;const price=Number.parseFloat(raw);if(!Number.isFinite(price)||price<0)return null;return totalTokens/1e6*price}export{MONITORING_DETAIL_QUERY,MONITORING_GRANT_PROBE_BUDGET_MS,MONITORING_GRANT_PROBE_CONCURRENCY,MONITORING_GRANT_STATEMENT_TIMEOUT_MS,MONITORING_GRANT_WAIT_TIMEOUT_SECONDS,MONITORING_LEDGER_QUERY,MONITORING_PERSON_SEEN_QUERY,MONITORING_PERSON_TABLES_QUERY,MONITORING_PERSON_TABLE_EVIDENCE_QUERY,MONITORING_QUESTIONS_QUERY,MONITORING_ROUTES,MONITORING_TABLE_DISCOVERY_TIMEOUT_MS,MONITORING_TOP_TABLE_LIMIT,OFFSET_REFUSAL,QUESTION_PAGE_SIZE,QUESTION_READ_LIMIT,historicalGrantLedger,liveSelfGrantLedger,matchingQuestions,monitoringCursor,pageFrom,questionFromRow,questionRows,rangeFrom,rangeTotalsFrom,rankTablesRead,responseWithTokenAttribution,setupMonitoringRoutes,summarize,tokenCost};
