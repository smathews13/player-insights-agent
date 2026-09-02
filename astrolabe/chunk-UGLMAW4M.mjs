
import {
  sqlQueryTags
} from "./chunk-TPU7NP2N.mjs";
import {
  ADMIN_GRANTS_TABLE,
  columnText,
  normalizeAdminEmail
} from "./chunk-TIMY5ERW.mjs";

// server/lib/admin-access.ts
function quote(part) {
  return "`" + part.replace(/`/g, "``") + "`";
}
function quotedName(fullName) {
  return fullName.split(".").map(quote).join(".");
}
function revokeStatement(privilege, principal) {
  return `REVOKE ${privilege.privilege} ON ${privilege.kind} ${quotedName(privilege.name)} FROM ${quote(principal)};`;
}
async function readProvenance(store, email) {
  const result = await store.query(
    `SELECT email, target, object, privilege, provenance FROM ${ADMIN_GRANTS_TABLE}
     WHERE email = $1 ORDER BY recorded_at ASC`,
    [normalizeAdminEmail(email)]
  );
  return result.rows.map((row) => ({
    email: columnText(row.email),
    object: columnText(row.object),
    privilege: columnText(row.privilege),
    // Anything this app cannot read as one of the three provenances is treated as
    // `unknown`, which is the reading that never revokes.
    provenance: ["app-granted", "pre-existing"].includes(columnText(row.provenance)) ? columnText(row.provenance) : "unknown"
  }));
}
var NO_WAREHOUSE_REASON = "Not checked. This deployment has no SQL warehouse configured, so no statement could be attempted.";
var NO_TOKEN_REASON = "Not checked. This session has no forwarded sign-in token, so a statement would have to be run by the app itself rather than by you. It is not, deliberately.";
function keptOnRemoval(row) {
  return row.privilege.toUpperCase() === "USE CATALOG";
}
function leftInPlaceNote(theirs, kept) {
  const parts = [];
  if (theirs > 0) parts.push("Access this app did not grant was left in place.");
  if (kept > 0) {
    parts.push(
      "Permission to see into the catalog was left in place. It shows no data on its own, and taking it back could hide tables this person was given for another reason."
    );
  }
  return parts.join(" ");
}
function kindOf(object) {
  const parts = object.split(".").length;
  return parts === 1 ? "CATALOG" : parts === 2 ? "SCHEMA" : "TABLE";
}
async function withdrawAccess(input) {
  const email = normalizeAdminEmail(input.email);
  const nothing = (summary, note = "") => ({ revoked: 0, refused: [], summary, note });
  let rows;
  try {
    rows = await readProvenance(input.store, email);
  } catch (error) {
    console.warn(
      `[admin] The grant record for ${email} could not be read (${error.message}), so nothing was revoked. Leaving access in place is the safe reading: this app cannot show it was the one that granted it.`
    );
    return nothing("Not checked. The record of what this app granted could not be read, so no access was taken away.");
  }
  const mine = rows.filter((row) => row.provenance === "app-granted" && !keptOnRemoval(row));
  const kept = rows.filter((row) => row.provenance === "app-granted" && keptOnRemoval(row));
  const theirs = rows.filter((row) => row.provenance !== "app-granted");
  const leftInPlace = leftInPlaceNote(theirs.length, kept.length);
  if (mine.length === 0) {
    return nothing(
      theirs.length + kept.length > 0 ? "No read access to take away." : "No access to take away. This app granted none.",
      leftInPlace
    );
  }
  if (!input.run) return nothing(input.unavailable ?? NO_WAREHOUSE_REASON);
  const failed = [];
  const revoked = [];
  for (const row of mine) {
    const statement = revokeStatement({ kind: kindOf(row.object), name: row.object, privilege: row.privilege }, email);
    const outcome = await input.run(statement);
    if (outcome.ok) revoked.push(row);
    else failed.push(statement);
  }
  for (const row of revoked) {
    try {
      await input.store.query(`DELETE FROM ${ADMIN_GRANTS_TABLE} WHERE email = $1 AND object = $2 AND privilege = $3`, [
        email,
        row.object,
        row.privilege
      ]);
    } catch (error) {
      console.error(
        `[admin] The grant record for ${row.privilege} on ${row.object} could not be cleared: ${error.message}. The revoke itself succeeded.`
      );
    }
  }
  return {
    revoked: revoked.length,
    refused: failed,
    summary: failed.length > 0 ? `Access not fully taken back. ${failed.length} of ${mine.length} statements were refused.` : "Access taken back.",
    note: leftInPlace
  };
}
var ACCESS_STATEMENT_TIMEOUT_MS = 4e4;
function accessRunner(options) {
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? ACCESS_STATEMENT_TIMEOUT_MS;
  return async (statement) => {
    let response;
    try {
      response = await call(`${options.host}/api/2.0/sql/statements`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          warehouse_id: options.warehouseId,
          statement,
          query_tags: sqlQueryTags({
            surface: "admin",
            tool: "admin_access",
            operation: "revoke"
          }),
          wait_timeout: "30s",
          on_wait_timeout: "CANCEL"
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      return {
        ok: false,
        message: timedOut ? `The SQL warehouse did not answer within ${timeoutMs} ms, so this did not complete.` : `The SQL warehouse could not be reached: ${error.message}`
      };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: body.message ?? `Databricks answered HTTP ${response.status} with no message body.`
      };
    }
    if (body.status?.state !== "SUCCEEDED") {
      return {
        ok: false,
        message: body.status?.error?.message ?? `The statement ended in state ${body.status?.state ?? "UNKNOWN"}.`
      };
    }
    const data = body.result?.data_array;
    return { ok: true, rows: Array.isArray(data) ? data : [] };
  };
}

export {
  NO_WAREHOUSE_REASON,
  NO_TOKEN_REASON,
  withdrawAccess,
  accessRunner
};
