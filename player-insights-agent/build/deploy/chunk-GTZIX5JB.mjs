
import{DECLARABLE_KINDS,DECLARED_RESOURCE_TYPES}from"./chunk-6VWRNKK5.mjs";import{CONNECTED_RESOURCES}from"./chunk-Q7N2ZVLF.mjs";import{APP_SCHEMA}from"./chunk-OMC625AH.mjs";var DECLARED_CONNECTIONS_QUERY=`
  SELECT id, label, kind, resource_type, value, note, state, origin, created_at, created_by, changed_at, changed_by
  FROM ${APP_SCHEMA}.declared_connections
  ORDER BY created_at, id`;var UPSERT_DECLARED_CONNECTION_QUERY=`
  INSERT INTO ${APP_SCHEMA}.declared_connections
    (id, label, kind, resource_type, value, note, state, origin, created_by, changed_by, changed_at)
  VALUES ($1, $2, $3, $4, $5, $6, 'declared', $7, $8, $8, now())
  ON CONFLICT (id) DO UPDATE
    SET label = EXCLUDED.label,
        kind = EXCLUDED.kind,
        resource_type = EXCLUDED.resource_type,
        value = EXCLUDED.value,
        note = EXCLUDED.note,
        state = 'declared',
        origin = EXCLUDED.origin,
        changed_by = EXCLUDED.changed_by,
        changed_at = now()
  RETURNING id, label, kind, resource_type, value, note, state, origin, created_at, created_by, changed_at, changed_by`;var INSERT_DECLARED_CONNECTIONS_BATCH_QUERY=`
  WITH incoming AS (
    SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS row(
        id TEXT, label TEXT, kind TEXT, resource_type TEXT, value TEXT, note TEXT
      )
  ),
  conflicts AS (
    SELECT 1
      FROM incoming
      JOIN ${APP_SCHEMA}.declared_connections existing
        ON lower(btrim(existing.id)) = lower(btrim(incoming.id))
        OR (
          existing.state = 'declared'
          AND lower(btrim(existing.kind)) = lower(btrim(incoming.kind))
          AND lower(btrim(existing.resource_type)) = lower(btrim(incoming.resource_type))
          AND lower(btrim(existing.value)) = lower(btrim(incoming.value))
        )
    UNION ALL
    SELECT 1
      FROM incoming
     GROUP BY lower(btrim(id))
    HAVING count(*) > 1
    UNION ALL
    SELECT 1
      FROM incoming a
      JOIN incoming b
        ON a.id < b.id
       AND (
         lower(btrim(a.id)) = lower(btrim(b.id))
         OR (
           lower(btrim(a.kind)) = lower(btrim(b.kind))
           AND lower(btrim(a.resource_type)) = lower(btrim(b.resource_type))
           AND lower(btrim(a.value)) = lower(btrim(b.value))
         )
       )
  ),
  inserted AS (
    INSERT INTO ${APP_SCHEMA}.declared_connections
      (id, label, kind, resource_type, value, note, state, origin, created_by, changed_by, changed_at)
    SELECT id, label, kind, resource_type, value, note, 'declared', 'app', $2, $2, now()
      FROM incoming
     WHERE NOT EXISTS (SELECT 1 FROM conflicts)
    RETURNING id, label, kind, resource_type, value, note, state, origin,
              created_at, created_by, changed_at, changed_by
  )
  SELECT coalesce(jsonb_agg(to_jsonb(inserted)), '[]'::jsonb) AS connections,
         (SELECT count(*)::int FROM conflicts) AS conflict_count
    FROM inserted`;var WITHDRAW_DECLARED_CONNECTION_QUERY=`
  UPDATE ${APP_SCHEMA}.declared_connections
     SET state = 'withdrawn', changed_by = $2, changed_at = now()
   WHERE id = $1 AND state = 'declared'
  RETURNING id, label, kind, resource_type, value, note, state, origin, created_at, created_by, changed_at, changed_by`;var RESTORE_DECLARED_CONNECTION_QUERY=`
  UPDATE ${APP_SCHEMA}.declared_connections
     SET state = 'declared', changed_by = $2, changed_at = now()
   WHERE id = $1 AND state = 'withdrawn'
  RETURNING id, label, kind, resource_type, value, note, state, origin, created_at, created_by, changed_at, changed_by`;var FORGET_DECLARED_CONNECTION_QUERY=`
  WITH target AS (
    SELECT lower(btrim(id)) AS id,
           lower(btrim(kind)) AS kind,
           lower(btrim(coalesce(resource_type, ''))) AS resource_type,
           lower(btrim(value)) AS value
      FROM ${APP_SCHEMA}.declared_connections
     WHERE lower(btrim(id)) = lower(btrim($1))
     ORDER BY created_at, id
     LIMIT 1
  )
  DELETE FROM ${APP_SCHEMA}.declared_connections AS connection
   USING target
   WHERE lower(btrim(connection.id)) = target.id
      OR (
        lower(btrim(connection.kind)) = target.kind
        AND lower(btrim(coalesce(connection.resource_type, ''))) = target.resource_type
        AND lower(btrim(connection.value)) = target.value
      )
  RETURNING connection.id`;function text(value){if(typeof value==="string")return value;if(typeof value==="number"||typeof value==="boolean")return String(value);return""}function timestamp(value){if(value instanceof Date)return value.toISOString();return text(value)}function storedFromRow(row){const kind=text(row.kind);const resourceType=text(row.resource_type);return{id:text(row.id),label:text(row.label),kind:DECLARABLE_KINDS.includes(kind)?kind:"unity-catalog",resourceType:DECLARED_RESOURCE_TYPES.includes(resourceType)?resourceType:void 0,value:text(row.value),note:text(row.note),state:row.state==="withdrawn"?"withdrawn":"declared",origin:row.origin==="notebook"?"notebook":"app",createdAt:timestamp(row.created_at),createdBy:text(row.created_by),changedAt:timestamp(row.changed_at),changedBy:text(row.changed_by)}}async function readDeclaredConnections(client){try{const result=await client.lakebase.query(DECLARED_CONNECTIONS_QUERY);return(result?.rows??[]).map(storedFromRow).filter(entry=>entry.id!=="")}catch(error){console.warn("[connections] Declared connections could not be read:",error.message);return[]}}async function writeDeclaredConnection(client,connection){const result=await client.lakebase.query(UPSERT_DECLARED_CONNECTION_QUERY,[connection.id,connection.label,connection.kind,connection.resourceType??"",connection.value,connection.note,connection.origin,connection.changedBy]);const row=(result?.rows??[])[0];if(!row)throw new Error("the declared connection was not written back");return storedFromRow(row)}async function writeDeclaredConnectionsBatch(client,connections,changedBy){const payload=connections.map(connection=>({id:connection.id,label:connection.label,kind:connection.kind,resource_type:connection.resourceType,value:connection.value,note:connection.note}));const result=await client.lakebase.query(INSERT_DECLARED_CONNECTIONS_BATCH_QUERY,[JSON.stringify(payload),changedBy]);const row=result?.rows?.[0]??{};const raw=Array.isArray(row.connections)?row.connections:typeof row.connections==="string"?JSON.parse(row.connections):[];const saved=Array.isArray(raw)?raw.filter(entry=>Boolean(entry)&&typeof entry==="object"):[];return{connections:saved.map(storedFromRow),conflict:Number(row.conflict_count)>0||saved.length!==connections.length}}async function restoreDeclaredConnection(client,id,changedBy){const result=await client.lakebase.query(RESTORE_DECLARED_CONNECTION_QUERY,[id,changedBy]);const row=(result?.rows??[])[0];return row?storedFromRow(row):null}async function forgetDeclaredConnection(client,id){const result=await client.lakebase.query(FORGET_DECLARED_CONNECTION_QUERY,[id]);return(result?.rows??[]).map(row=>text(row.id)).filter(Boolean)}var ID_PATTERN=/^[a-z0-9][a-z0-9-]{1,60}$/;function addFault(input){if(!ID_PATTERN.test(input.id)){return"A name may use lower-case letters, digits and hyphens, must start with a letter or digit, and is between 2 and 61 characters."}if(CONNECTED_RESOURCES.some(resource=>resource.id===input.id)){return`${input.id} is already the name of one of this deployment's own settings. Choose another name.`}if(!DECLARABLE_KINDS.includes(input.kind)){return`${input.kind} is not a kind of asset that can be added here.`}if(input.resourceType){const expectedKind={catalog:"unity-catalog",schema:"unity-catalog",table:"unity-catalog",volume:"volume","sql-warehouse":"sql-warehouse","serving-endpoint":"model","genie-space":"genie-space","vector-search-endpoint":"vector-search","vector-search-index":"vector-search"};if(!DECLARED_RESOURCE_TYPES.includes(input.resourceType)){return`${input.resourceType} is not a resource type that can be added here.`}if(expectedKind[input.resourceType]!==input.kind){return`${input.resourceType} does not match the submitted connection kind.`}}if(!input.value.trim()){return"An asset needs an identifier, such as a three-part table name."}const value=input.value.trim();if(input.resourceType==="schema"&&value.split(".").filter(Boolean).length!==2){return"A schema identifier must be catalog.schema."}if((input.resourceType==="table"||input.resourceType==="vector-search-index")&&value.split(".").filter(Boolean).length!==3){return"This resource identifier must have three parts: catalog.schema.name."}if(input.resourceType==="volume"&&!/^\/Volumes\/[^/]+\/[^/]+\/[^/]+$/.test(value)){return"A volume identifier must be /Volumes/catalog/schema/volume."}return null}function addedConnectionEffect(){return"Recorded as an asset the agent may consider. It grants nobody access: whether a person can read it is decided by their own Unity Catalog grants."}function removalImpact(connection,liveValues){const consequences=["The agent stops being offered this asset when it chooses where to look."];const normalised=connection.value.trim().toLowerCase();const alsoLive=liveValues.some(value=>value.trim().toLowerCase()===normalised);if(alsoLive){consequences.push("The running agent is configured with this same value, so it keeps using it. Removing the row here changes what this page lists, not what the agent reaches.")}if(connection.origin==="notebook"){consequences.push("It was published from a notebook, so publishing again will add it back.")}return{headline:alsoLive?`Remove ${connection.label} from the list. The running agent is configured with this value and keeps using it.`:`Remove ${connection.label} from the assets the agent may consider.`,consequences,recoverable:false}}export{readDeclaredConnections,writeDeclaredConnection,writeDeclaredConnectionsBatch,restoreDeclaredConnection,forgetDeclaredConnection,addFault,addedConnectionEffect,removalImpact};
