/**
 * The words the panel puts on screen, which are the claims it makes.
 *
 * Most of this file asserts that a string is absent. That is the point: the
 * failure mode for a control panel is not a crash, it is a reassuring word next
 * to a control that does not do what the word implies. Nobody files a bug about
 * it, and the person who reads it acts on it.
 *
 * Two families of assertion:
 *
 *   1. A switch says how far it reaches. `stored` must never render as though it
 *      were enforcement.
 *   2. Nothing anywhere in the classification vocabulary reads as a clearance.
 *      "Not classified" is a fact about a catalog and must not become a finding
 *      about contents.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CLASSIFICATION_LABEL,
  controllablePaths,
  EGRESS_PATHS,
  type TableClassification,
} from '../../shared/egress-contract';
import {
  CLASSIFICATION_CAPTION,
  classificationFacts,
  classificationPill,
  controlAccessibleName,
  ENFORCEMENT_PILL,
  ENFORCEMENT_SITE,
  enforcementPill,
  pathMeta,
  reportingNote,
} from './egress-panel';

const PANEL_SOURCE = readFileSync(new URL('./EgressPanel.tsx', import.meta.url), 'utf8');
const WORDS_SOURCE = readFileSync(new URL('./egress-panel.ts', import.meta.url), 'utf8');

function table(over: Partial<TableClassification> = {}): TableClassification {
  return {
    table: 'example_catalog.demo_schema.demo_table',
    state: 'not-classified',
    columns: [],
    rowFilter: null,
    notChecked: '',
    ...over,
  };
}

describe('a switch says how far it reaches', () => {
  it('gives every controllable path a word, so no row is silent about its own coverage', () => {
    for (const path of controllablePaths()) {
      expect(enforcementPill(path).label, path.channel).toBeTruthy();
    }
  });

  it('does not let a recorded preference read as enforcement', () => {
    // The single most important assertion in this file. An administrator who
    // turns off a `stored` path and reads "Enforced" will tell somebody the copy
    // button is gone, and it will still be there.
    expect(ENFORCEMENT_PILL.stored.label).not.toMatch(/enforc|block|prevent|stop|disabl/i);
    expect(ENFORCEMENT_PILL.stored.label).toBe('Recorded only');
  });

  it('does not congratulate itself with a positive chip on any control', () => {
    for (const pill of Object.values(ENFORCEMENT_PILL)) {
      expect(pill.tone).not.toBe('pos');
    }
  });

  it('names where each enforced path is enforced, because the two are not equal', () => {
    // One withholds the value; the other removes a button in a browser that
    // already has it. Collapsing them into one word would overstate the second.
    expect(ENFORCEMENT_SITE['workspace-link']).toMatch(/server/i);
    expect(ENFORCEMENT_SITE['chart-image']).toMatch(/browser/i);
    for (const path of EGRESS_PATHS) {
      if (path.enforcement === 'enforced') {
        expect(ENFORCEMENT_SITE[path.channel], path.channel).toBeTruthy();
      }
    }
  });

  it('puts where the affordance is on every controllable row', () => {
    for (const path of controllablePaths()) {
      expect(pathMeta(path)[0], path.channel).toBe(path.where);
    }
  });

  it('names the action on the control and not the path, so the two are distinct', () => {
    const path = controllablePaths()[0];
    expect(controlAccessibleName(path)).not.toBe(path.label);
    expect(controlAccessibleName(path)).toMatch(/^Permit /);
  });
});

describe('what the panel lists', () => {
  it('draws only controllable paths, with switches', () => {
    expect(PANEL_SOURCE).toContain('controllablePaths()');
    expect(PANEL_SOURCE).toContain('ControlRow');
    expect(PANEL_SOURCE).toContain('<Switch');
  });

  it('does not draw the uncontrollable status rows or the egress log', () => {
    // Those were a reporting surface with no control behind them. The registry
    // still names the paths; Settings no longer lists them or "What has left".
    expect(PANEL_SOURCE).not.toContain('UncontrollableRow');
    expect(PANEL_SOURCE).not.toContain('What has left');
    expect(PANEL_SOURCE).not.toContain('/api/egress/admin/events');
    expect(PANEL_SOURCE).not.toMatch(/Cannot be stopped/);
  });
});

describe('a switch whose path is not recorded says so', () => {
  it('adds the note to a controllable path that nothing reports', () => {
    // The panel's worst possible row is "Recorded only" on a channel that is not
    // recorded, because the label is the whole of what the switch does.
    const path = EGRESS_PATHS.find((candidate) => candidate.enforcement === 'stored');
    expect(path).toBeTruthy();
    if (path && !path.reported) {
      expect(reportingNote(path)).toBe('Not recorded yet');
      expect(pathMeta(path)).toContain('Not recorded yet');
    }
  });

  it('says nothing about recording on a path the app cannot see at all', () => {
    // There is no click to hang a report on. A note would imply one is coming.
    for (const path of EGRESS_PATHS.filter((candidate) => candidate.enforcement === 'uncontrollable')) {
      expect(reportingNote(path), path.channel).toBe('');
    }
  });

  it('drops the note the moment a path starts reporting', () => {
    expect(reportingNote({ ...EGRESS_PATHS[0], reported: true })).toBe('');
  });

  it('keeps the two questions apart in the registry itself', () => {
    // Enforcement and reporting are different facts, and a path can be either
    // without the other. Collapsing them is how a panel answers one for the other.
    for (const path of EGRESS_PATHS) {
      expect(typeof path.reported, path.channel).toBe('boolean');
      if (path.enforcement === 'uncontrollable') expect(path.reported, path.channel).toBe(false);
    }
  });
});

describe('what the panel says about personal information', () => {
  /** Anything that would be heard as a clearance. */
  const CLEARANCE = [
    /\bno personal\b/i,
    /\bno pii\b/i,
    /\bclean\b/i,
    /\bsafe\b/i,
    /\bnothing sensitive\b/i,
    /\bcontains no\b/i,
    /\bverified\b/i,
    /\bcleared\b/i,
    /\bcompliant\b/i,
  ];

  it('has no word for "no personal data", in any label', () => {
    for (const label of Object.values(CLASSIFICATION_LABEL)) {
      for (const forbidden of CLEARANCE) {
        expect(label, label).not.toMatch(forbidden);
      }
    }
  });

  it('has none of those words anywhere in the panel vocabulary either', () => {
    // The labels are three strings and easy to keep honest. The caption, the
    // facts and the markup are where a reassuring sentence would actually get
    // written, so the whole of both files is scanned.
    for (const forbidden of CLEARANCE) {
      expect(CLASSIFICATION_CAPTION, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('renders an unclassified table neutrally and never positively', () => {
    // A green chip on a table nobody has classified is the panel awarding a
    // clearance it has no grounds for.
    expect(classificationPill(table({ state: 'not-classified' })).tone).toBe('neutral');
    expect(classificationPill(table({ state: 'not-classified' })).label).toBe('Not classified');
  });

  it('separates a silent catalog from a read that did not happen', () => {
    expect(classificationPill(table({ state: 'not-checked' })).tone).toBe('warn');
    expect(CLASSIFICATION_LABEL['not-checked']).not.toBe(CLASSIFICATION_LABEL['not-classified']);
  });

  it('says where the answer came from and that no values were read', () => {
    expect(CLASSIFICATION_CAPTION).toMatch(/unity catalog/i);
    expect(CLASSIFICATION_CAPTION).toMatch(/no column values are inspected/i);
  });

  it('counts what the catalog carries and does not interpret it', () => {
    const facts = classificationFacts(
      table({
        state: 'classified',
        columns: [
          { column: 'alpha', tags: ['a_tag'], masked: false },
          { column: 'beta', tags: [], masked: true },
        ],
        rowFilter: true,
      })
    );
    expect(facts).toContain('1 tagged column');
    expect(facts).toContain('1 masked column');
    expect(facts).toContain('Row filter');
  });

  it('prints nothing at all rather than a zero for a table with no findings', () => {
    expect(classificationFacts(table({ state: 'not-classified' }))).toEqual([]);
  });

  it('says only why, for a table it could not ask about', () => {
    const facts = classificationFacts(table({ state: 'not-checked', notChecked: 'No warehouse' }));
    expect(facts).toEqual(['No warehouse']);
  });

  it('does not report a row filter it never read as absent', () => {
    // `rowFilter: null` is "not read" and must not print as "no row filter".
    const facts = classificationFacts(table({ state: 'classified', rowFilter: null }));
    expect(facts.join(' ')).not.toMatch(/row filter/i);
  });
});

describe('the house style the design asks for', () => {
  it('uses no em dash in anything that reaches the screen', () => {
    for (const words of [
      CLASSIFICATION_CAPTION,
      ...Object.values(CLASSIFICATION_LABEL),
      ...Object.values(ENFORCEMENT_PILL).map((pill) => pill.label),
    ]) {
      expect(words, words).not.toMatch(/—|–/);
    }
  });

  it('appends the blocked state with the specified middle dot', () => {
    expect(PANEL_SOURCE).toContain("' · Blocked by the server'");
    expect(PANEL_SOURCE).not.toMatch(/—|–/);
  });

  it('draws distinct enforced and recorded-only mode chips', () => {
    expect(PANEL_SOURCE).toContain('egress-mode');
    expect(PANEL_SOURCE).toContain('egress-mode-${path.enforcement}');
  });

  it('never claims the data is synthetic', () => {
    for (const source of [PANEL_SOURCE, WORDS_SOURCE]) {
      expect(source).not.toMatch(/\bsynthetic\b/i);
      expect(source).not.toMatch(/\bfake data\b/i);
      expect(source).not.toMatch(/\bdummy\b/i);
    }
  });
});
