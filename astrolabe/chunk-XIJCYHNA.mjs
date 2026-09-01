
import {
  APP_SCHEMA
} from "./chunk-7DTM6FIL.mjs";

// server/lib/admin-roles.ts
import crypto from "node:crypto";

// server/lib/admin-roles-schema.ts
var ADDED_ADMINS_TABLE = `${APP_SCHEMA}.admin_emails`;
var ADMIN_AUDIT_TABLE = `${APP_SCHEMA}.admin_audit`;
var ADMIN_GRANTS_TABLE = `${APP_SCHEMA}.admin_access_grants`;
var ADMIN_ROLES_DDL = [
  /**
   * One row per added admin.
   *
   * The email is the primary key rather than a surrogate id, because the
   * question this table answers is "is this address an admin" and a second row
   * for the same address is not a fact, it is a duplicate. Stored lowercased by
   * the write path, so the key is the comparison the role check makes.
   *
   * `added_by` and `added_at` are what the origin chip in Settings prints. They
   * are NOT the audit trail: the audit table below records the action, and this
   * records the state the action produced. Both, because a removed admin leaves
   * no row here and the fact that they were removed still has to be answerable.
   */
  `CREATE TABLE IF NOT EXISTS ${ADDED_ADMINS_TABLE} (
     email TEXT PRIMARY KEY,
     added_by TEXT NOT NULL,
     added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  /**
   * Every add, every removal, and every read of another person's conversation.
   *
   * Append only, and nothing in this app reads it. There is no audit viewer, on
   * purpose: writing the trail and building a screen for it are separate pieces
   * of work, and the specification scopes out the second one.
   *
   * `subject` is who or what the action was about, which is a person's address
   * for a list change and a conversation id for a read. `detail` is a sentence,
   * so a row is legible to somebody querying this table with no knowledge of
   * the app's internals. Both are NOT NULL and written as '' when they do not
   * apply, so a reader never has to decide what a null means.
   */
  `CREATE TABLE IF NOT EXISTS ${ADMIN_AUDIT_TABLE} (
     id TEXT PRIMARY KEY,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     subject TEXT NOT NULL,
     detail TEXT NOT NULL,
     recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  /**
   * Indexed by who acted and when, which is the only question anybody asks of
   * an audit trail. Safe here because the table it indexes is created by the
   * statement above rather than by another module: `CREATE INDEX` checks
   * ownership of the table before it considers `IF NOT EXISTS`.
   */
  `CREATE INDEX IF NOT EXISTS admin_audit_actor_time
     ON ${APP_SCHEMA}.admin_audit (actor, recorded_at DESC)`,
  /**
   * One row per (person, object, privilege) this app tried to grant, and what
   * it found when it looked BEFORE granting.
   *
   * THIS TABLE EXISTS TO STOP A REVOKE FROM TAKING AWAY SOMETHING NOBODY ASKED
   * US TO TOUCH. Removing an admin should hand back the access the add handed
   * out, and a blind `REVOKE` does something else entirely: it also removes
   * access the person already held, for a reason that has nothing to do with
   * this app, and Unity Catalog keeps no record that would let anybody put it
   * back. So the state before the grant is written down at the moment it is
   * observable, which is the only moment it is.
   *
   * `provenance` is one of three words and the removal path branches on it:
   *
   *   app-granted   The privilege was absent, and this app added it. Removing
   *                 the admin revokes it.
   *   pre-existing  The privilege was already there. Removing the admin leaves
   *                 it alone, and the editor says so rather than staying quiet.
   *   unknown       The check could not be made, usually because the acting
   *                 admin cannot read grants on the object. NEVER REVOKED.
   *                 Unknown is not evidence, and the safe reading of no
   *                 evidence is to change nothing.
   *
   * Keyed on person, object and privilege, because one person holds several
   * privileges on several objects and each has its own provenance. A row is
   * replaced rather than duplicated on a re-grant: the newest observation is the
   * one a later revoke has to reason from. `target` is which admin surface the
   * privilege is for, stored rather than inferred from the object name so a
   * later reader is not parsing `system.` prefixes to work it out.
   */
  `CREATE TABLE IF NOT EXISTS ${ADMIN_GRANTS_TABLE} (
     email TEXT NOT NULL,
     target TEXT NOT NULL,
     object TEXT NOT NULL,
     privilege TEXT NOT NULL,
     provenance TEXT NOT NULL,
     actor TEXT NOT NULL,
     recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (email, object, privilege)
   )`
];

// server/lib/admin-identity.ts
function normalizeAdminEmail(raw) {
  return raw.trim().toLowerCase();
}
function columnText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

// shared/user-roster-contract.ts
var ROLES = ["super_admin", "admin", "consumer"];
var ROLE_WORD = {
  super_admin: "Super admin",
  admin: "Admin",
  consumer: "Consumer"
};
var ROLE_RANK = {
  consumer: 0,
  admin: 1,
  super_admin: 2
};
function isRole(value) {
  return typeof value === "string" && ROLES.includes(value);
}
function highestRole(left, right) {
  return ROLE_RANK[left] >= ROLE_RANK[right] ? left : right;
}
function opensAdminSurfaces(role) {
  return ROLE_RANK[role] >= ROLE_RANK.admin;
}
function opensUserRoster(role) {
  return role === "super_admin";
}

// server/lib/user-roster.ts
var ROLE_COLUMN = "role";
var ADD_ROLE_COLUMN_STATEMENT = `ALTER TABLE ${ADDED_ADMINS_TABLE} ADD COLUMN IF NOT EXISTS ${ROLE_COLUMN} TEXT NOT NULL DEFAULT 'admin'`;
var UNDEFINED_COLUMN = "42703";
function missingRoleColumn(error) {
  const code = error.code;
  if (code === UNDEFINED_COLUMN) return true;
  const message = error?.message ?? "";
  return message.includes(ROLE_COLUMN) && /does not exist|undefined column/i.test(message);
}
var REQUEST_ROSTER = Symbol("request-roster");
var rosterGeneration = /* @__PURE__ */ new WeakMap();
function generationFor(store) {
  return rosterGeneration.get(store) ?? 0;
}
function invalidateRosterCache(store) {
  rosterGeneration.set(store, generationFor(store) + 1);
}
async function readRoster(store) {
  try {
    const withRole = await store.query(
      `SELECT email, ${ROLE_COLUMN}, added_by, added_at FROM ${ADDED_ADMINS_TABLE} ORDER BY added_at ASC`
    );
    return { rows: withRole.rows.map((row) => storedRole(row, columnText(row[ROLE_COLUMN]))), roleColumnPresent: true };
  } catch (error) {
    if (!missingRoleColumn(error)) throw error;
    const withoutRole = await store.query(
      `SELECT email, added_by, added_at FROM ${ADDED_ADMINS_TABLE} ORDER BY added_at ASC`
    );
    return { rows: withoutRole.rows.map((row) => storedRole(row, "admin")), roleColumnPresent: false };
  }
}
function readRosterForRequest(store, req) {
  const request = req;
  const generation = generationFor(store);
  const cached = request[REQUEST_ROSTER];
  if (cached && cached.store === store && cached.generation === generation) return cached.reading;
  const reading = readRoster(store);
  request[REQUEST_ROSTER] = { store, generation, reading };
  return reading;
}
function storedRole(row, rawRole) {
  const candidate = rawRole.trim().toLowerCase();
  return {
    email: normalizeAdminEmail(columnText(row.email)),
    role: isRole(candidate) ? candidate : "admin",
    setBy: columnText(row.added_by),
    setAt: row.added_at instanceof Date ? row.added_at.toISOString() : columnText(row.added_at)
  };
}
async function writeRole(store, input) {
  const email = normalizeAdminEmail(input.email);
  const actor = normalizeAdminEmail(input.actor);
  if (!input.roleColumnPresent) {
    await store.query(
      `INSERT INTO ${ADDED_ADMINS_TABLE} (email, added_by) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET added_by = EXCLUDED.added_by, added_at = NOW()`,
      [email, actor]
    );
    invalidateRosterCache(store);
    return;
  }
  await store.query(
    `INSERT INTO ${ADDED_ADMINS_TABLE} (email, ${ROLE_COLUMN}, added_by) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE
       SET ${ROLE_COLUMN} = EXCLUDED.${ROLE_COLUMN},
           added_by = EXCLUDED.added_by,
           added_at = NOW()`,
    [email, input.role, actor]
  );
  invalidateRosterCache(store);
}
async function deleteRosterRow(store, email) {
  const result = await store.query(`DELETE FROM ${ADDED_ADMINS_TABLE} WHERE email = $1 RETURNING email`, [
    normalizeAdminEmail(email)
  ]);
  const deleted = result.rows.length > 0;
  if (deleted) invalidateRosterCache(store);
  return deleted;
}
function seedFloorFor(seed, email) {
  const candidate = normalizeAdminEmail(email);
  if (!candidate) return "consumer";
  if (seed.superAdmins.includes(candidate)) return "super_admin";
  if (seed.admins.includes(candidate)) return "admin";
  return "consumer";
}
function effectiveRole(input) {
  const candidate = normalizeAdminEmail(input.email);
  const floor = seedFloorFor(input.seed, candidate);
  const row = input.stored.find((entry) => entry.email === candidate);
  return row ? highestRole(floor, row.role) : floor;
}
function everyKnownUser(input) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const email of [...input.seed.superAdmins, ...input.seed.admins]) {
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, role: effectiveRole({ ...input, email }) });
  }
  for (const row of input.stored) {
    if (seen.has(row.email)) continue;
    seen.add(row.email);
    out.push({ email: row.email, role: effectiveRole({ ...input, email: row.email }) });
  }
  return out;
}
function countSuperAdmins(input) {
  return everyKnownUser(input).filter((user) => user.role === "super_admin").length;
}
function recoveryStatement() {
  return `INSERT INTO ${ADDED_ADMINS_TABLE} (email, ${ROLE_COLUMN}, added_by) VALUES ('<address>', 'super_admin', '<who ran this>') ON CONFLICT (email) DO UPDATE SET ${ROLE_COLUMN} = 'super_admin'`;
}
function roleChangeRefusal(input) {
  if (!isRole(input.role)) return "unknown-role";
  const target = normalizeAdminEmail(input.email);
  const desired = input.role;
  const current = effectiveRole({ seed: input.seed, stored: input.stored, email: target });
  const createsConsumer = input.allowMissingConsumer === true && desired === "consumer" && seedFloorFor(input.seed, target) === "consumer" && !input.stored.some((entry) => entry.email === target);
  if (desired === current && !createsConsumer) return "already-holds";
  if (current === "super_admin") return "immutable-super-admin";
  if (ROLE_RANK[desired] < ROLE_RANK[seedFloorFor(input.seed, target)]) return "seed-floor";
  if (!input.roleColumnPresent && desired !== "admin") return "no-role-column";
  if (leavesNoSuperAdmin({ ...input, target, desired })) return "last-super-admin";
  return "";
}
function removalRefusal(input) {
  const target = normalizeAdminEmail(input.email);
  if (!input.stored.some((entry) => entry.email === target)) return "not-found";
  if (effectiveRole({ seed: input.seed, stored: input.stored, email: target }) === "super_admin") {
    return "immutable-super-admin";
  }
  if (seedFloorFor(input.seed, target) !== "consumer") return "seed-floor";
  if (leavesNoSuperAdmin({ ...input, target, desired: "consumer" })) return "last-super-admin";
  return "";
}
function leavesNoSuperAdmin(input) {
  const after = input.stored.filter((entry) => entry.email !== input.target).concat(input.desired === "consumer" ? [] : [{ email: input.target, role: input.desired, setBy: "", setAt: "" }]);
  return countSuperAdmins({ seed: input.seed, stored: after }) === 0;
}
var REFUSAL_DETAIL = {
  "immutable-super-admin": "Super admins are deployment owners and cannot be changed or removed here.",
  "seed-floor": "That role is set in this deployment's configuration and cannot be lowered here. It can be raised.",
  "last-super-admin": "That is the only super admin. Appoint another one first.",
  "not-found": "That address is not on the roster.",
  "already-holds": "That address already holds that role.",
  "no-role-column": `This deployment's roster cannot record that role yet. Run: ${ADD_ROLE_COLUMN_STATEMENT}`,
  "unknown-role": `Send one of ${ROLES.join(", ")}.`
};
function rosterPayload(input) {
  const you = normalizeAdminEmail(input.reader);
  const superAdminCount = countSuperAdmins({ seed: input.seed, stored: input.stored });
  const adminCount = everyKnownUser({ seed: input.seed, stored: input.stored }).filter(
    (user) => user.role !== "consumer"
  ).length;
  const entries = everyKnownUser({ seed: input.seed, stored: input.stored }).map((user) => {
    const row = input.stored.find((entry) => entry.email === user.email);
    const floor = seedFloorFor(input.seed, user.email);
    return {
      email: user.email,
      role: user.role,
      seedFloor: floor,
      setBy: row?.setBy ?? "",
      setAt: row?.setAt ?? "",
      isYou: user.email === you,
      assignable: ROLES.filter(
        (candidate) => !roleChangeRefusal({
          email: user.email,
          role: candidate,
          seed: input.seed,
          stored: input.stored,
          roleColumnPresent: input.roleColumnPresent
        })
      ),
      canRemove: !removalRefusal({ email: user.email, seed: input.seed, stored: input.stored })
    };
  }).sort((left, right) => ROLE_RANK[right.role] - ROLE_RANK[left.role] || left.email.localeCompare(right.email));
  return {
    entries,
    storedRosterReadable: input.storedRosterReadable,
    roleColumnPresent: input.roleColumnPresent,
    pendingSchemaStatement: input.roleColumnPresent ? "" : ADD_ROLE_COLUMN_STATEMENT,
    superAdminCount,
    // Only when nobody can act at all. See recoveryStatement.
    recoveryStatement: superAdminCount === 0 && adminCount === 0 ? recoveryStatement() : ""
  };
}
function roleChangeSentence(input) {
  return `${input.actor} changed ${input.email} from ${ROLE_WORD[input.from].toLowerCase()} to ${ROLE_WORD[input.to].toLowerCase()} in this deployment.`;
}

// server/lib/admin-roles.ts
var SEED_ADMIN_EMAILS_ENV = "PLAYER_INSIGHTS_ADMIN_EMAILS";
var SEED_SUPER_ADMIN_PREFIX = "super:";
function parseSeedAdmins(raw) {
  const emails = [];
  const superEmails = [];
  const rejected = [];
  for (const token of (raw ?? "").split(/[,;\s]+/)) {
    const raw0 = normalizeAdminEmail(token);
    if (!raw0) continue;
    const isSuper = raw0.startsWith(SEED_SUPER_ADMIN_PREFIX);
    const candidate = isSuper ? raw0.slice(SEED_SUPER_ADMIN_PREFIX.length).trim() : raw0;
    if (!candidate.includes("@")) {
      rejected.push(raw0);
      continue;
    }
    if (!emails.includes(candidate)) emails.push(candidate);
    if (isSuper && !superEmails.includes(candidate)) superEmails.push(candidate);
  }
  return { emails, superEmails, rejected };
}
var seedAdmins = [];
var seedSuperAdmins = [];
function seedAdminEmails() {
  return seedAdmins;
}
function seedSuperAdminEmails() {
  return seedSuperAdmins;
}
function seedRoles() {
  return { superAdmins: seedSuperAdmins, admins: seedAdmins };
}
function announceSeedAdmins(raw = process.env[SEED_ADMIN_EMAILS_ENV]) {
  const { emails, superEmails, rejected } = parseSeedAdmins(raw);
  seedAdmins = emails;
  seedSuperAdmins = superEmails;
  if (rejected.length > 0) {
    console.error(
      `[admin] ${SEED_ADMIN_EMAILS_ENV} contains ${rejected.length} entr${rejected.length === 1 ? "y" : "ies"} with no "@" in ${JSON.stringify(rejected)}, so they are NOT addresses and have been ignored. Nothing is exposed by this. If one of them was meant to be an administrator, they are not one.`
    );
  }
  if (emails.length === 0) {
    console.warn(
      `[admin] NO SEED ADMINISTRATORS. ${SEED_ADMIN_EMAILS_ENV} is unset or empty, so nobody is an administrator except whoever an existing admin has added in Lakebase, and on a fresh deployment that is nobody. Monitoring, Ops, Benchmark Lab and the Settings gear will refuse every caller with 403. An empty list means nobody rather than everybody, deliberately. Set the bundle variable to give this deployment an administrator.`
    );
    return;
  }
  console.log(
    `[admin:test] installed ${emails.length} in-memory administrator${emails.length === 1 ? "" : "s"}, ${superEmails.length} of them super administrator${superEmails.length === 1 ? "" : "s"}. Production does not use this path; it bootstraps an empty Lakebase roster once.`
  );
  if (superEmails.length === 0) {
    console.log(
      `[admin] NO SEED SUPER ADMINISTRATOR. Nobody can appoint or remove administrators from inside the app unless the stored roster already names a super admin. This deployment therefore has the two roles it always had. To name one, prefix an entry in ${SEED_ADMIN_EMAILS_ENV} with "${SEED_SUPER_ADMIN_PREFIX}".`
    );
  }
}
async function bootstrapSeedRoles(store, raw = process.env[SEED_ADMIN_EMAILS_ENV]) {
  const parsed = parseSeedAdmins(raw);
  seedAdmins = [];
  seedSuperAdmins = [];
  if (parsed.rejected.length > 0) {
    console.error(
      `[admin] ${SEED_ADMIN_EMAILS_ENV} contains ${parsed.rejected.length} invalid entr${parsed.rejected.length === 1 ? "y" : "ies"} and they were ignored.`
    );
  }
  let current;
  try {
    current = await readRoster(store);
  } catch (error) {
    const rawCode = error.code;
    const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : "unknown";
    console.error(
      `[admin] ROLE BOOTSTRAP SKIPPED: the Lakebase roster could not be read (code ${code}: ${error.message}). Astrolabe will keep serving with no stored roles available; Connections reports the storage problem. No configured role was written or retained, because an unreadable roster is not evidence that it is empty.`
    );
    return "unavailable";
  }
  if (current.rows.length > 0) {
    console.log(
      `[admin] Lakebase already contains ${current.rows.length} role row${current.rows.length === 1 ? "" : "s"}; ${SEED_ADMIN_EMAILS_ENV} is ignored. A code deploy cannot add, remove, promote, or demote anybody.`
    );
    return "existing-roster";
  }
  const roles = parsed.emails.map((email) => ({
    email,
    role: parsed.superEmails.includes(email) ? "super_admin" : "admin"
  }));
  if (roles.length === 0) {
    console.warn(
      `[admin] The Lakebase roster is empty and ${SEED_ADMIN_EMAILS_ENV} names nobody. No role was bootstrapped; every caller remains a consumer until an operator explicitly creates a role row.`
    );
    return "empty";
  }
  const params = [];
  const values = roles.map(({ email, role }, index) => {
    params.push(email, role, email);
    const offset = index * 3;
    return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
  }).join(", ");
  const inserted = await store.query(
    `INSERT INTO ${ADDED_ADMINS_TABLE} (email, ${ROLE_COLUMN}, added_by)
     SELECT seed.email, seed.role, seed.added_by
       FROM (VALUES ${values}) AS seed(email, role, added_by)
      WHERE NOT EXISTS (SELECT 1 FROM ${ADDED_ADMINS_TABLE})
     ON CONFLICT (email) DO NOTHING
     RETURNING email, ${ROLE_COLUMN}`,
    params
  );
  if (inserted.rows.length === 0) {
    console.log(
      `[admin] The roster stopped being empty before bootstrap committed; ${SEED_ADMIN_EMAILS_ENV} was ignored.`
    );
    return "existing-roster";
  }
  console.log(
    `[admin] Bootstrapped ${inserted.rows.length} role row${inserted.rows.length === 1 ? "" : "s"} into Lakebase. Future boots ignore deployed role config because the database is now authoritative.`
  );
  invalidateRosterCache(store);
  return "bootstrapped";
}
async function readAddedAdmins(store) {
  const result = await store.query(`SELECT email, added_by, added_at FROM ${ADDED_ADMINS_TABLE} ORDER BY added_at ASC`);
  return result.rows.map((row) => ({
    email: normalizeAdminEmail(columnText(row.email)),
    addedBy: columnText(row.added_by),
    addedAt: row.added_at instanceof Date ? row.added_at.toISOString() : columnText(row.added_at)
  }));
}
async function resolveRoleFrom(email, read) {
  const caller = normalizeAdminEmail(email);
  const seed = seedRoles();
  const floor = seedFloorFor(seed, caller);
  if (floor === "super_admin") {
    return { role: "super_admin", addedAdminsReadable: true, seedAdminCount: seed.admins.length };
  }
  try {
    const { rows } = await read();
    const role = caller ? effectiveRole({ seed, stored: rows, email: caller }) : "consumer";
    return { role, addedAdminsReadable: true, seedAdminCount: seed.admins.length };
  } catch (error) {
    console.warn(
      `[admin] The stored roster could not be read (${error.message}), so this request has no stored roles to check against and resolves at the seed floor. Seed administrators are unaffected. An unreadable roster denies rather than admits.`
    );
    return { role: floor, addedAdminsReadable: false, seedAdminCount: seed.admins.length };
  }
}
async function resolveRole(store, email) {
  return resolveRoleFrom(email, () => readRoster(store));
}
async function resolveRoleForRequest(store, req, readEmail) {
  return resolveRoleFrom(readEmail(req), () => readRosterForRequest(store, req));
}
async function rolePayload(store, email) {
  const { role, addedAdminsReadable, seedAdminCount } = await resolveRole(store, email);
  return { role, addedAdminsReadable, seedAdminCount };
}
var ADMIN_ROUTE_PREFIXES = [
  "/api/monitoring",
  "/api/ops",
  "/api/admins",
  // Benchmark Lab is not an admin tab, and its endpoints are still admin-only.
  // The experimental toggle that reveals it is a per-browser preference anybody
  // can set, so on its own it hides the page without protecting it. This is what
  // makes "hidden from consumers" a fact rather than a default.
  "/api/benchmarks",
  // The roster. Under the admin prefixes as well as the super-admin ones below, so
  // that a consumer is refused by the same middleware as every other admin surface
  // and a defect in the narrower guard cannot leave the roster open to everybody.
  "/api/users",
  // The egress controls' writes, recent-record reads and classification. `/api/egress/admin` and
  // not `/api/egress`, and the narrowness is deliberate rather than an oversight:
  // `/api/egress/controls` and `/api/egress/events` have to stay open to every
  // signed-in reader, because a consumer's own browser is where the copy buttons
  // and the chart controls are and is therefore the only party that can report an
  // export. Widening this to `/api/egress` would refuse consumers on the recorder,
  // so the only exports still recorded would be administrators' own -- a record
  // that has quietly narrowed to one person while continuing to look complete.
  // `setupEgressRoutes` checks BOTH halves of that and registers nothing if either
  // is wrong.
  "/api/egress/admin",
  // Connections MUTATIONS and the Apply plan. Not `/api/settings` itself: GET
  // must stay open so a consumer can see what the deployment is connected to.
  // These prefixes cover PUT/DELETE on values, POST/DELETE on declared
  // connections, impact/restore, and GET/POST on `/api/settings/apply`.
  "/api/settings/values",
  "/api/settings/connections",
  "/api/settings/apply",
  "/api/settings/resource-tags",
  // One namespace for every release-request lifecycle operation. Creation,
  // claim, and completion all resolve the acting person from the same trusted
  // forwarded identity and are refused to consumers by construction.
  "/api/admin"
];
var SUPER_ADMIN_ROUTE_PREFIXES = ["/api/users"];
function matchesPrefix(path, prefixes) {
  const lowered = path.toLowerCase();
  return prefixes.some((prefix) => lowered === prefix || lowered.startsWith(`${prefix}/`));
}
function isAdminRoute(path) {
  return matchesPrefix(path, ADMIN_ROUTE_PREFIXES);
}
function isSuperAdminRoute(path) {
  return matchesPrefix(path, SUPER_ADMIN_ROUTE_PREFIXES);
}
var ADMIN_REQUIRED_BODY = {
  error: "admin_role_required",
  detail: "This deployment restricts this to its administrators, and you are not one."
};
var SUPER_ADMIN_REQUIRED_BODY = {
  error: "super_admin_role_required",
  detail: "This deployment restricts changing roles to its super administrator."
};
function requireAdmin(store, readEmail) {
  return function refuseNonAdmins(req, res, next) {
    if (!isAdminRoute(req.path)) {
      next();
      return;
    }
    let caller;
    try {
      caller = readEmail(req);
    } catch {
      res.status(403).json(ADMIN_REQUIRED_BODY);
      return;
    }
    resolveRoleForRequest(store, req, () => caller).then((resolution) => {
      if (opensAdminSurfaces(resolution.role)) {
        next();
        return;
      }
      console.warn(
        `[admin] REFUSED ${req.method} ${req.path}: the caller is not an administrator of this deployment. Expected whenever a consumer follows a link to an admin surface; the page they land on says so.`
      );
      res.status(403).json(ADMIN_REQUIRED_BODY);
    }).catch((error) => {
      console.error(
        `[admin] REFUSED ${req.method} ${req.path}: the role could not be established (${error.message}). Denying rather than admitting, because an unresolved role is not evidence of one.`
      );
      res.status(403).json(ADMIN_REQUIRED_BODY);
    });
  };
}
function requireSuperAdmin(store, readEmail) {
  return function refuseNonSuperAdmins(req, res, next) {
    if (!isSuperAdminRoute(req.path)) {
      next();
      return;
    }
    let caller;
    try {
      caller = readEmail(req);
    } catch {
      res.status(403).json(SUPER_ADMIN_REQUIRED_BODY);
      return;
    }
    resolveRoleForRequest(store, req, () => caller).then((resolution) => {
      if (opensUserRoster(resolution.role)) {
        next();
        return;
      }
      console.warn(
        `[admin] REFUSED ${req.method} ${req.path}: the caller does not hold the super administrator role of this deployment. Expected whenever an administrator reaches the roster; the panel is not drawn for them.`
      );
      res.status(403).json(SUPER_ADMIN_REQUIRED_BODY);
    }).catch((error) => {
      console.error(
        `[admin] REFUSED ${req.method} ${req.path}: the role could not be established (${error.message}). Denying rather than admitting, because an unresolved role is not evidence of one.`
      );
      res.status(403).json(SUPER_ADMIN_REQUIRED_BODY);
    });
  };
}
async function recordAdminAction(store, entry) {
  try {
    await store.query(
      `INSERT INTO ${ADMIN_AUDIT_TABLE} (id, actor, action, subject, detail) VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), normalizeAdminEmail(entry.actor), entry.action, entry.subject, entry.detail]
    );
    return true;
  } catch (error) {
    console.error(
      `[admin] AUDIT ROW NOT WRITTEN for ${entry.action} by ${entry.actor} on ${entry.subject}: ${error.message}. The action itself went ahead. This line is the record.`
    );
    return false;
  }
}
function adminListPayload(input) {
  const you = normalizeAdminEmail(input.reader);
  const seedRows = input.seed.map((email) => ({
    email,
    origin: "seed",
    addedBy: "",
    addedAt: "",
    isYou: email === you,
    removable: false
  }));
  const addedRows = input.added.filter((entry) => !input.seed.includes(entry.email)).map((entry) => ({
    email: entry.email,
    origin: "added",
    addedBy: entry.addedBy,
    addedAt: entry.addedAt,
    isYou: entry.email === you,
    removable: true
  }));
  return {
    entries: [...seedRows, ...addedRows],
    addedAdminsReadable: input.addedAdminsReadable,
    seedAdminCount: input.seed.length
  };
}
function invalidAdminEmail(raw) {
  const candidate = normalizeAdminEmail(raw);
  if (!candidate) return "Enter an email address.";
  if (candidate.length > 320) return "That is longer than an email address can be.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return "That does not look like an email address.";
  return "";
}
function removalRefusal2(input) {
  const target = normalizeAdminEmail(input.email);
  if (input.seed.includes(target)) return "seed-row";
  if (!input.added.some((entry) => entry.email === target)) return "not-found";
  if (input.seed.length === 0 && input.added.length === 1) return "last-admin";
  return "";
}
var REMOVAL_REFUSAL_DETAIL = {
  "seed-row": "That administrator was set at deployment and cannot be removed here. Edit the bundle variable to change it.",
  "last-admin": "That is the last administrator, and this deployment has no seed administrators to fall back on. Removing them would leave nobody able to open Monitoring, Ops or these settings, and nobody able to appoint anybody. Add another administrator first.",
  "not-found": "That address is not on the list."
};
async function addAdmin(store, input) {
  const email = normalizeAdminEmail(input.email);
  const result = await store.query(
    `INSERT INTO ${ADDED_ADMINS_TABLE} (email, added_by) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING email`,
    [email, normalizeAdminEmail(input.addedBy)]
  );
  const inserted = result.rows.length > 0;
  if (inserted) invalidateRosterCache(store);
  return inserted;
}
async function removeAdmin(store, email) {
  const result = await store.query(`DELETE FROM ${ADDED_ADMINS_TABLE} WHERE email = $1 RETURNING email`, [
    normalizeAdminEmail(email)
  ]);
  const deleted = result.rows.length > 0;
  if (deleted) invalidateRosterCache(store);
  return deleted;
}

export {
  normalizeAdminEmail,
  columnText,
  ADMIN_GRANTS_TABLE,
  ADMIN_ROLES_DDL,
  ROLE_WORD,
  isRole,
  opensAdminSurfaces,
  readRoster,
  readRosterForRequest,
  writeRole,
  deleteRosterRow,
  effectiveRole,
  everyKnownUser,
  roleChangeRefusal,
  removalRefusal,
  REFUSAL_DETAIL,
  rosterPayload,
  roleChangeSentence,
  SEED_ADMIN_EMAILS_ENV,
  SEED_SUPER_ADMIN_PREFIX,
  parseSeedAdmins,
  seedAdminEmails,
  seedSuperAdminEmails,
  seedRoles,
  announceSeedAdmins,
  bootstrapSeedRoles,
  readAddedAdmins,
  resolveRole,
  resolveRoleForRequest,
  rolePayload,
  ADMIN_ROUTE_PREFIXES,
  SUPER_ADMIN_ROUTE_PREFIXES,
  isAdminRoute,
  isSuperAdminRoute,
  ADMIN_REQUIRED_BODY,
  SUPER_ADMIN_REQUIRED_BODY,
  requireAdmin,
  requireSuperAdmin,
  recordAdminAction,
  adminListPayload,
  invalidAdminEmail,
  removalRefusal2,
  REMOVAL_REFUSAL_DETAIL,
  addAdmin,
  removeAdmin
};
