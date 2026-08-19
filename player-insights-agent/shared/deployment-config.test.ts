/**
 * The registry is the shared configuration model. These are the properties any
 * surface reading it is entitled to rely on.
 *
 * The settings pane is the consumer. What is asserted here is not that the
 * registry has particular contents, but that it cannot describe a value in a way
 * that would let that surface lie about it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CHANGED_BY,
  CONNECTED_RESOURCES,
  RUNTIME_EDITABLE_IDS,
  STAGEABLE_IDS,
  appliesImmediately,
  connectedResource,
  type ChangedBy,
} from './deployment-config';

const AGENT_CONFIG = path.resolve(__dirname, '../../agent/config.py');

describe('the vocabulary is shared with the orchestrator', () => {
  it('uses no tier the agent does not also name', () => {
    // Parsed out of config.py rather than restated here. That module resolves the
    // orchestrator's settings and reports a `mutability` for each of them over
    // the wire, so a tier this file invented would arrive in the payload as a
    // string the pane cannot look up, and the pane renders that string as the
    // instruction for how to change the value.
    const source = readFileSync(AGENT_CONFIG, 'utf8');
    const declared = [...source.matchAll(/^[A-Z_]+ = "([a-z-]+)"$/gm)].map((match) => match[1]);

    for (const tier of Object.keys(CHANGED_BY)) {
      expect(declared, `agent/config.py does not name the tier '${tier}'`).toContain(tier);
    }
  });

  it('agrees with the agent about which settings a form can change', () => {
    const source = readFileSync(AGENT_CONFIG, 'utf8');
    // The agent marks exactly one of its own settings as adjustable, and it is a
    // diagnostic knob rather than a resource. If that ever changes, one of these
    // two files has grown a notion of editability the other does not share.
    const block = /MUTABILITY = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(block).toContain('BAKED_AT_LOG_TIME for key in ENV_VARS');

    const orchestratorOwned = CONNECTED_RESOURCES.filter((resource) => resource.agentKey);
    expect(orchestratorOwned.length).toBeGreaterThan(0);
    for (const resource of orchestratorOwned) {
      expect(resource.changedBy, `${resource.id} is owned by the orchestrator`).toBe('model-version');
    }
  });
});

describe('every resource can be acted on', () => {
  it('has a unique id', () => {
    const ids = CONNECTED_RESOURCES.map((resource) => resource.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says what would change it, in words a reader can act on', () => {
    for (const resource of CONNECTED_RESOURCES) {
      expect(Object.keys(CHANGED_BY)).toContain(resource.changedBy);
      // The failure this prevents is a row that says "not editable here" and
      // stops. A deployer looking at a Genie space id they need to change needs
      // the command, not the refusal.
      expect(resource.applyWith.length, `${resource.id} has no way to apply a change`).toBeGreaterThan(10);
      expect(resource.arrivesBy.length, `${resource.id} does not say how the value reaches it`).toBeGreaterThan(20);
    }
  });

  it('names either a bundle variable, an app variable, or neither on purpose', () => {
    // A resource with no configuration route at all is a resource nobody can
    // point at their own workspace, which is a finding rather than a state to
    // pass over quietly. Lakebase schema used to be the one that qualified
    // (decorative var); it is now wired through PLAYER_INSIGHTS_APP_SCHEMA, so
    // the unconfigurable set is empty.
    const unconfigurable = CONNECTED_RESOURCES.filter((resource) => !resource.bundleVariable && !resource.appEnvVar && !resource.agentKey
    );
    expect(unconfigurable.map((resource) => resource.id)).toEqual([]);
  });

  it('wires the Lakebase schema through the bundle var and the app env', () => {
    const resource = connectedResource('lakebase-schema');
    expect(resource?.bundleVariable).toBe('lakebase_app_schema');
    expect(resource?.appEnvVar).toBe('PLAYER_INSIGHTS_APP_SCHEMA');
    expect(resource?.changedBy).toBe('app-redeploy');
  });
});

describe('what may be written, and as what', () => {
  it('only calls a setting editable when the app reads it per request', () => {
    // The whole hazard in one assertion. `app-runtime` is the only tier whose
    // values a form can change, because it is the only one the app re-reads
    // after the form was submitted.
    for (const id of RUNTIME_EDITABLE_IDS) {
      const resource = connectedResource(id);
      expect(resource?.changedBy).toBe('app-runtime');
      expect(appliesImmediately(id)).toBe(true);
    }
  });

  it('marks nothing baked into the model artifact as immediately editable', () => {
    for (const resource of CONNECTED_RESOURCES) {
      if (resource.changedBy !== 'model-version') continue;
      expect(appliesImmediately(resource.id), `${resource.id} would be edited to no effect`).toBe(false);
      expect(RUNTIME_EDITABLE_IDS).not.toContain(resource.id);
    }
  });

  it('only stages values that a documented command can then apply', () => {
    // Staging a value nobody can apply is a to-do list disguised as
    // configuration. Every stageable resource is one whose `applyWith` is a
    // command, which for the orchestrator means the agent release.
    for (const id of STAGEABLE_IDS) {
      const resource = connectedResource(id);
      expect(resource?.changedBy).toBe('model-version');
      expect(resource?.applyWith).toContain('agent-release.sh');
    }
  });

  it('does not put the conversation rail on the Apply plan, which is a tenancy control', () => {
    // Admins may RECORD an intention (Option B unlocks the padlock), but the
    // rail stays out of STAGEABLE_IDS so Apply / agent-release never promotes
    // it. Widening tenancy still requires an app release someone reviewed.
    const rail = connectedResource('shared-conversation-rail');
    expect(rail?.changedBy).toBe('app-redeploy');
    expect(rail?.stageable).toBe(false);
    expect(STAGEABLE_IDS).not.toContain('shared-conversation-rail');
  });

  it('appliesImmediately is false for anything it has never heard of', () => {
    // The pane asks this before offering an edit box, and an unknown id has to
    // fall on the side of "do not offer".
    expect(appliesImmediately('something-invented')).toBe(false);
  });
});

describe('tier descriptions', () => {
  it('says of each tier whether saving a value would do anything', () => {
    const immediate = (Object.keys(CHANGED_BY) as ChangedBy[]).filter((tier) => CHANGED_BY[tier].appliesImmediately
    );
    expect(immediate).toEqual(['app-runtime']);
  });

  it('explains itself rather than only labelling itself', () => {
    for (const [tier, description] of Object.entries(CHANGED_BY)) {
      expect(description.label.length, `${tier} has no label`).toBeGreaterThan(3);
      expect(description.note.length, `${tier} does not explain itself`).toBeGreaterThan(40);
    }
  });
});
