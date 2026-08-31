import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { answerInline, type Inline } from './answer-markdown';
import { declaredColumns, entityHref } from './data-entities';
import { databricksLink } from '../../shared/databricks-links';
import { partial } from './styles/stylesheet';

/**
 * The plan card names tables and columns, and now says which is which.
 *
 * The card used to render its summary and every step through `EntityText` with
 * `sources={[]}`, which is the empty candidate set: nothing in a plan could
 * match anything, so every table and every column in it was grey text a reader
 * had to copy out and look up by hand. That is the defect these tests pin, and
 * they pin it at both ends -- the segmentation the renderer is handed, and the
 * call sites in the component that ask for it.
 *
 * They cannot say what the card looks like. There is no browser in this repo,
 * so what is asserted is that the right function is called with the right
 * candidate set and that its output marks the runs a reader needs marked. See
 * answer-geometry.test.ts, which makes the same trade for the same reason.
 */
const PLAN = readFileSync(new URL('./PlanCard.tsx', import.meta.url), 'utf8');
const CARD = readFileSync(new URL('./AnswerCard.tsx', import.meta.url), 'utf8');
const FINAL_ANSWER = readFileSync(new URL('./FinalAnswer.tsx', import.meta.url), 'utf8');
const LINKS = readFileSync(new URL('./DataEntityLinks.tsx', import.meta.url), 'utf8');
const INLINE_LINKS = readFileSync(new URL('./InlineEntityText.tsx', import.meta.url), 'utf8');
const MODULE = readFileSync(new URL('./SourcesModule.tsx', import.meta.url), 'utf8');
const ANSWER_CSS = partial('answer.css');

const HOST = 'https://example-workspace.invalid';
const CATALOG = 'a_catalog.a_schema';
const DAILY = `${CATALOG}.gold_title_daily_summary`;
/** What the plan actually says, in the shape the agent writes it. */
const SUMMARY = `Aggregate active_players from ${DAILY} by title over the 30-day window`;
const STEP = `Read ${DAILY}. Columns: event_date, title_code, title_name, active_players`;

/** Every run in a parsed line, flattened, so a claim can be made about one. */
function runs(nodes: readonly Inline[]): { text: string; entity?: string; emphasis?: true }[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'text' || node.kind === 'code') return [...node.runs];
    if (node.kind === 'strong' || node.kind === 'link') return runs(node.children);
    return [];
  });
}

/** The plan's own prose, segmented exactly as `PlanText` segments it. */
function planRuns(line: string) {
  const tracked = [DAILY];
  return runs(answerInline(line, tracked, tracked, declaredColumns([SUMMARY, STEP])));
}

describe('a table named in a plan is a link to that table', () => {
  it('links the name the plan wrote, in the summary and in the step', () => {
    for (const line of [SUMMARY, STEP]) {
      const linked = planRuns(line).filter((run) => run.entity);
      expect(linked.map((run) => run.text)).toEqual([DAILY]);
      expect(linked[0].entity).toBe(DAILY);
    }
  });

  it('sends the reader to this app’s entry for it, which exists without a workspace', () => {
    // The identifier itself carries the in-app link, as it does in an answer:
    // it is the one target that resolves in a deployment that was never told
    // which workspace it is in. See DataEntityLinks.tsx.
    const [linked] = planRuns(SUMMARY).filter((run) => run.entity);
    expect(entityHref(linked.entity!)).toBe(`/connections?entity=${encodeURIComponent(DAILY)}`);
  });

  it('builds the workspace URL for that same table', () => {
    // What the "Open in Databricks" control beside a source row opens. Three
    // levels and a host, or nothing at all.
    expect(databricksLink(HOST, { kind: 'table', table: DAILY })).toBe(
      `${HOST}/explore/data/a_catalog/a_schema/gold_title_daily_summary`
    );
  });

  it('offers no workspace link at all when the app was told no host', () => {
    // The deployment with no `DATABRICKS_HOST` renders the name and no control.
    // A link built on a guessed host lands the reader in a workspace that is
    // not theirs, which is worse than having nowhere to click.
    expect(databricksLink('', { kind: 'table', table: DAILY })).toBeNull();
    expect(LINKS).toContain('if (!href) return null;');
  });
});

describe('a column named in a plan is bold and inert', () => {
  it('bolds every column the step declared', () => {
    const marked = planRuns(STEP).filter((run) => run.emphasis);
    expect(marked.map((run) => run.text)).toEqual(['event_date', 'title_code', 'title_name', 'active_players']);
  });

  it('bolds the measure the summary names, which the step declares further down', () => {
    expect(
      planRuns(SUMMARY)
        .filter((run) => run.emphasis)
        .map((run) => run.text)
    ).toEqual(['active_players']);
  });

  it('gives a column nothing to click, because no page here documents one', () => {
    expect(planRuns(STEP).filter((run) => run.emphasis && run.entity)).toEqual([]);
  });

  it('leaves the ordinary words of the sentence unmarked', () => {
    // `title` is a word in the summary and `title_code` is a column two lines
    // below it. One false mark on a word like this costs more than every true
    // one buys, which is why a bare name has to carry an underscore.
    const marked = planRuns(SUMMARY).filter((run) => run.entity ?? run.emphasis);
    expect(marked.map((run) => run.text)).toEqual(['active_players', DAILY]);
    expect(
      planRuns(SUMMARY)
        .map((run) => run.text)
        .join('')
    ).toBe(SUMMARY);
  });
});

describe('the plan card asks for that treatment on every line it draws', () => {
  it('routes the summary, each step title and each step detail through the helper', () => {
    expect(PLAN).toContain('<PlanText text={plan.summary} columns={columns} />');
    expect(PLAN).toContain('<PlanText text={step.title} columns={columns} />');
    expect(PLAN).toContain('<PlanText text={step.description} columns={columns} />');
  });

  it('declares no candidate set of its own', () => {
    // One implementation. The card states which columns the plan declared and
    // nothing else about matching; the rules live in data-entities.ts and the
    // rendering in DataEntityLinks.tsx.
    expect(PLAN).toContain('declaredColumns([plan.summary');
    // The empty candidate set this replaces. `EntityText` is the right helper
    // for a surface that declares its own sources, and a plan declares none.
    expect(PLAN).not.toContain('<EntityText');
    expect(PLAN).not.toMatch(/RegExp|replace\(|entityHref/);
  });

  it('lets the header column shrink to the card it is in', () => {
    // A fully-qualified table name is one word and wider than the column it
    // lands in, and a flex child's floor is its content until it is told
    // otherwise. The mark beside it is `flex: none` in shell.css, so without
    // this the row grows instead and the summary runs past the card edge.
    expect(PLAN).toContain('className="min-w-0 space-y-2"');
    const rule = ANSWER_CSS.slice(ANSWER_CSS.indexOf('\n.plan-card [data-slot='));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('overflow-wrap: anywhere');
  });
});

describe('every surface that names a source names it the same way', () => {
  it('names a source once per answer, in the module and nowhere else', () => {
    // The card used to name every cited table twice: once in the strip under
    // the figures and again in an "All sources" tab, each with its own link.
    // The second list is gone, so the card no longer builds a source row of any
    // kind and there is nothing left for the two to disagree about.
    const code = CARD.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
    expect(code).not.toContain('<SourceEntityName');
    expect(code).not.toContain('<OpenInDatabricks');
    expect(code).not.toContain('className="source-line"');
  });

  it('draws that row from the shared module on both surfaces, not its own copy', () => {
    // The stronger form of "the row is linked", and the one that had to be
    // written after the two copies of it were found disagreeing about
    // punctuation: neither file owns the markup now. See SourcesModule.tsx and
    // sources-module-render.test.tsx.
    for (const source of [CARD, FINAL_ANSWER]) {
      // The whole list, not its first entry. Both surfaces passed the first
      // element, which is how an answer that read five tables cited one of them.
      // Read with the comments dropped, because both files now carry a note
      // naming the expression that was removed.
      const code = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
      // Whitespace-tolerant because the element takes a third prop now, the
      // run's provenance, so both call sites wrap their props one per line.
      expect(code).toMatch(/<SourcesModule[\s\S]*sources=\{/);
      expect(code).not.toMatch(/sources\[0\]/);
      expect(source).not.toContain('className="sources-row"');
    }
    expect(MODULE).toContain('<SourceEntityName name={row.name} />');
    expect(MODULE).toContain('<OpenInDatabricks name={name} />');
  });

  it('keeps answer entities lazy while the approval plan uses the lightweight renderer', () => {
    for (const source of [CARD, MODULE, FINAL_ANSWER]) {
      expect(source).toContain("from './DataEntityLinks'");
    }
    expect(PLAN).toContain("from './InlineEntityText'");
    expect(INLINE_LINKS).toContain('className="entity-table text-primary');
    expect(LINKS).toContain('className="entity-table text-primary');
  });
});
