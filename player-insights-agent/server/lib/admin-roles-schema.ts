import { APP_SCHEMA } from '../../shared/app-schema';
/**
 * The three tables the admin role keeps: who was added, what admins did, and
 * which Unity Catalog grants this app is the reason for.
 *
 * A separate module from admin-roles.ts for the reason run-ledger-schema.ts is
 * separate from run-ledger.ts: the boot path has to reach the statements, and
 * the logic has to reach the caller's identity, and putting both in one file
 * makes insights-routes.ts and this file import each other.
 *
 * THE SAME RULES APPLY HERE AS TO THE RUN LEDGER, and they are worth restating
 * because `applySchema` runs this list at every start of the deployed app,
 * against a database holding the customer's conversation history:
 *
 *   1. Nothing alters an existing table. `ALTER TABLE ... ADD COLUMN IF NOT
 *      EXISTS` is REFUSED when the app's Postgres role does not own the table,
 *      because ownership is checked before the statement is found to be a
 *      no-op. Every constraint below is declared inside its own CREATE.
 *   2. Nothing drops, renames or rewrites anything.
 *   3. Every statement is a no-op the second time.
 *   4. No table name here is used by anything else in the schema, so a
 *      `CREATE TABLE IF NOT EXISTS` here cannot quietly resolve to somebody
 *      else's table and start writing rows into it.
 *
 * NO TABLE HERE IS THE WHOLE ADMIN LIST. The seed list is read from the process
 * environment, so an unreachable Lakebase leaves the deployment administerable
 * by whoever was named at deployment. See admin-roles.ts.
 */

/** The table holding admins added from the Settings gear. */
export const ADDED_ADMINS_TABLE = `${APP_SCHEMA}.admin_emails`;

/** The table holding what admins did. Written to, never read by the app. */
export const ADMIN_AUDIT_TABLE = `${APP_SCHEMA}.admin_audit`;

/**
 * The table recording which Unity Catalog grants this app is the reason for.
 *
 * Read on removal, and it is the only thing standing between "give back what
 * we handed out" and "take away access somebody holds for a reason we know
 * nothing about". See admin-access.ts.
 */
export const ADMIN_GRANTS_TABLE = `${APP_SCHEMA}.admin_access_grants`;

export const ADMIN_ROLES_DDL: readonly string[] = [
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
   )`,
];
