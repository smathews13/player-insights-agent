/**
 * The guard refuses exactly one situation, and it is the one that happened.
 *
 * A local development server was pointed at the Lakebase branch the deployed app
 * uses. It booted, ran the app's DDL, and three tables that had just been ADDED
 * to that DDL did not exist yet -- so nothing refused them. They were created,
 * owned by the developer, and the next release was blocked: the app cannot
 * maintain tables it does not own, and ownership cannot be handed back, because
 * `ALTER ... OWNER TO` needs `SET ROLE` on the owner and Lakebase does not grant
 * a human that over a service principal. They were empty, so dropping them was
 * survivable. A table with rows in it would not have been.
 *
 * THE HALF THAT MATTERS MORE THAN THE REFUSAL is that nothing else is refused. A
 * guard that fires on a healthy deployment is a guard somebody deletes, and this
 * one sits in front of every boot of the app in front of the customer. Three of
 * the four cases below have to proceed, and they are the reason the condition
 * asks Postgres about role membership rather than comparing two strings.
 */
import { describe, expect, it } from 'vitest';

import { schemaOwnershipQuery, schemaWriteRefusal, type SchemaOwnership } from './schema-ownership-guard';

const SCHEMA = 'player_insights';
/** A service principal client id, which is what the deployed app connects as. */
const APP_ROLE = '00000000-0000-4000-8000-000000000000';
const DEVELOPER = 'someone@example.invalid';

function state(overrides: Partial<SchemaOwnership> = {}): SchemaOwnership {
  return {
    schemaExists: true,
    owner: APP_ROLE,
    connectedRole: APP_ROLE,
    connectedRoleHoldsOwner: true,
    ...overrides,
  };
}

describe('the boot DDL proceeds in every legitimate case', () => {
  it('proceeds for the deployed app, which owns its own schema', () => {
    // The case that runs thousands of times for every time the guard fires.
    expect(schemaWriteRefusal(SCHEMA, state())).toEqual('');
  });

  it('proceeds on a fresh branch, where the schema does not exist yet', () => {
    // Whoever runs the DDL first creates the schema and owns it, which is how a
    // developer gets a branch of their own and how a new deployment starts.
    expect(
      schemaWriteRefusal(
        SCHEMA,
        state({ schemaExists: false, owner: '', connectedRole: DEVELOPER, connectedRoleHoldsOwner: false })
      )
    ).toEqual('');
  });

  it('proceeds for local development against a branch of one’s own', () => {
    // The developer owns what they created. This is the arrangement the refusal
    // below tells people to adopt, so refusing it too would leave no way out.
    expect(schemaWriteRefusal(SCHEMA, state({ owner: DEVELOPER, connectedRole: DEVELOPER }))).toEqual('');
  });

  it('proceeds when the connected role is a member of the owner rather than the owner itself', () => {
    // Asked of Postgres rather than inferred from the names matching. A role with
    // the owner's rights can maintain the schema, and refusing it would be a
    // false alarm that costs a deployment its DDL for no reason.
    expect(
      schemaWriteRefusal(SCHEMA, state({ connectedRole: 'a_member_role', connectedRoleHoldsOwner: true }))
    ).toEqual('');
  });
});

describe('the boot DDL is refused when the connected role could never maintain the schema', () => {
  const refusal = schemaWriteRefusal(SCHEMA, state({ connectedRole: DEVELOPER, connectedRoleHoldsOwner: false }));

  it('refuses, rather than creating tables the owner will not be able to maintain', () => {
    expect(refusal).not.toEqual('');
  });

  it('names both roles, so the reader can tell which end is wrong', () => {
    // A refusal that says "ownership mismatch" sends somebody to read the code.
    // Which role owns it and which role is asking is the whole diagnosis.
    expect(refusal).toContain(SCHEMA);
    expect(refusal).toContain(APP_ROLE);
    expect(refusal).toContain(DEVELOPER);
  });

  it('says the remedy is a branch of one’s own, and not a grant', () => {
    // Grants do not fix ownership, and the failure mode of this guard being
    // misread is somebody re-running the grant script until they give up.
    expect(refusal).toContain('branch of its own');
    expect(refusal).toMatch(/cannot be handed back/);
  });

  it('explains that the danger is the statements that SUCCEED', () => {
    // The counter-intuitive half, and the reason the guard is needed at all. A
    // reader who believes IF NOT EXISTS makes the DDL harmless against someone
    // else's schema will remove this.
    expect(refusal).toMatch(/ADDED would be created/);
  });
});

describe('the query behind it asks Postgres the right question', () => {
  const sql = schemaOwnershipQuery();

  it('returns one row whether or not the schema exists', () => {
    // `to_regnamespace` yields NULL rather than no rows, so the caller reads one
    // shape instead of branching on a row count.
    expect(sql).toContain('to_regnamespace($1) IS NOT NULL AS schema_exists');
  });

  it('asks about role membership rather than comparing names', () => {
    expect(sql).toContain('pg_has_role(current_user');
    expect(sql).toContain("'USAGE'");
  });

  it('takes the schema as a parameter rather than interpolating it', () => {
    expect(sql).not.toContain(SCHEMA);
    expect(sql).toContain('$1');
  });

  it('defaults every column, so an absent schema cannot surface as null', () => {
    // The caller coerces too, but a null owner reaching the message would print
    // "owned by null" at the top of a fresh deployment's log.
    expect(sql.match(/COALESCE/g) ?? []).toHaveLength(2);
  });
});
