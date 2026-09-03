import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import {
  FilterRow,
  MonitoringBody,
  MONITORING_COMPACT_QUERY,
  MonitoringHeading,
  MonitoringPaginationControls,
  MonitoringPage,
  PersonPanel,
  PersonPanelShell,
  PersonSpend,
  QuestionList,
  QuestionDrawer,
  QuestionPanel,
  SummaryStrip,
  TablesReadMost,
  UserMonitoringPanel,
} from './MonitoringPage';
import { monitoringPageForOwner } from './monitoring-session';
import { GRANTS_UNRESOLVED_LINE, LIVE_VERSUS_RECORDED } from './monitoring-view';
import { NO_FILTERS, type MonitoringFilters } from './monitoring-filters';
import type {
  MonitoringDetail,
  MonitoringQuestion,
  MonitoringQuestionsPayload,
  PersonPanelPayload,
} from '../../shared/monitoring-contract';
import type { MonitoringState } from './monitoring-view';
import { beginPanelLoad, idlePanel, rejectPanelLoad } from './monitoring-detail-state';
import type { OpsCostPayload } from '../../shared/ops-contract';

const MONITORING_SOURCE = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');
const MONITORING_CSS = readFileSync(new URL('./styles/monitoring.css', import.meta.url), 'utf8');

/**
 * What a reader actually sees on Monitoring, asserted against rendered output.
 *
 * Rendered rather than inspected, in the pattern connections-render.test.tsx
 * established: this repository has been bitten by screens that were wrong while
 * every assertion about their source was true. The states are driven through
 * `MonitoringBody`, which takes a state rather than fetching into one, because
 * the alternative is a browser and there is not one here.
 *
 * PIXELS ARE NOT VERIFIED BY ANY OF THIS. These tests read the text a person
 * would read. Nothing here says the layout is right.
 */

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&middot;/g, '\u00b7')
    .replace(/&times;/g, '\u00d7')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

function renderAt(node: React.ReactElement, entry: string): string {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter>);
}

/** How many times a phrase appears, for the tests that care about duplicates. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const NOW = Date.parse('2026-08-15T12:00:00Z');

/** The filter row with nothing set, which several tests below assert against. */
function unfiltered(): string {
  return render(
    <FilterRow filters={NO_FILTERS} people={[]} tables={[]} onChange={() => {}} onClearFilters={() => {}} />
  );
}

function question(overrides: Partial<MonitoringQuestion> = {}): MonitoringQuestion {
  return {
    id: 'q1',
    conversationId: 'c1',
    question: 'Compare active players by title over the last 30 days',
    askedBy: 'first.person@example.test',
    askedAt: '2026-08-15T10:00:00Z',
    outcome: 'completed',
    outcomeDetail: null,
    durationMs: 76_200,
    toolCalls: 5,
    totalTokens: 84_576,
    feedback: 'up',
    tables: ['a_catalog.a_schema.a_table'],
    ...overrides,
  };
}

function payload(overrides: Partial<MonitoringQuestionsPayload> = {}): MonitoringQuestionsPayload {
  return {
    readState: 'ok',
    readAt: '2026-08-15T11:58:00Z',
    summary: {
      questionsAsked: 214,
      userThreads: 17,
      completed: 190,
      partial: 6,
      refused: 11,
      failed: 7,
      helpful: 36,
      feedbackTotal: 46,
      medianMs: 41_000,
      timedCount: 214,
    },
    questions: [question()],
    people: ['first.person@example.test'],
    tables: ['a_catalog.a_schema.a_table'],
    grantsResolution: 'ok',
    pagination: { pageSize: 50, total: 214, hasMore: false, nextCursor: null },
    ...overrides,
  };
}

function body(
  state: MonitoringState,
  over: Partial<MonitoringQuestionsPayload> = {},
  filters: MonitoringFilters = NO_FILTERS
) {
  const data = state === 'unavailable' ? null : payload(over);
  return render(
    <MonitoringBody
      state={state}
      payload={data}
      questions={data?.questions ?? []}
      filters={filters}
      rangeLabel="7 days"
      selectedId=""
      now={NOW}
      onOpen={() => {}}
      onChangeFilters={() => {}}
      onClearFilters={() => {}}
      onRetry={() => {}}
    />
  );
}

describe('who asked, in the list', () => {
  it('uses the shared identity chip and renders no initials circle', () => {
    const markup = body('ready');

    expect(markup).toContain('identity-chip identity-chip--compact monitoring-asker-who');
    expect(markup).toContain('lucide-user-round');
    expect(markup).not.toContain('>FP<');
    expect(markup).not.toContain('monitoring-initials');
    expect(markup).toContain('title="first.person@example.test"');
    expect(markup).toContain('first.person');
  });

  it('keeps the mark and the name inside the cell rather than making the cell a flex row', () => {
    // A `td` given `display: flex` leaves the table's column sizing, which is
    // the trap the question column next door is commented for. The layout lives
    // on a span inside the cell.
    expect(body('ready')).toMatch(
      /<td class="monitoring-asker"[^>]*><span class="identity-chip[^"]*monitoring-asker-who"/
    );
  });
});

describe('the summary strip', () => {
  it.each(['24h', '7 days', '30 days', 'All time'])(
    'puts the active %s badge on every KPI card without repeating it in each accessible name',
    (periodLabel) => {
      const markup = render(<SummaryStrip payload={payload()} periodLabel={periodLabel} />);
      const cards = markup.match(/<div class="monitoring-tile[^"]*"[^>]*aria-label="[^"]*"[\s\S]*?<\/div>/g) ?? [];

      expect(markup.match(/monitoring-period-badge/g)).toHaveLength(5);
      expect(markup.match(/monitoring-period-badge" aria-hidden="true"/g)).toHaveLength(5);
      expect(cards).toHaveLength(5);
      for (const card of cards) {
        const openingTag = card.slice(0, card.indexOf('>') + 1);
        expect(occurrences(openingTag, periodLabel)).toBe(1);
      }
    }
  );

  it('does not turn All time into a fixed-day label', () => {
    const rendered = text(render(<SummaryStrip payload={payload()} periodLabel="All time" />));

    expect(rendered).toContain('All time');
    expect(rendered).not.toMatch(/(?:last|past)\s+\d+\s+days/i);
  });

  it('labels and counts distinct conversation threads, not distinct people', () => {
    const rendered = text(render(<SummaryStrip payload={payload()} periodLabel="7 days" />));

    expect(rendered).toContain('User threads 7 days 17');
    expect(rendered).toContain('Distinct conversation threads');
    expect(rendered).not.toContain('People asking');
  });

  it('shows each outcome as its own labelled metric and never merges refused with failed', () => {
    const markup = render(<SummaryStrip payload={payload()} periodLabel="7 days" />);
    const rendered = text(markup);

    expect(markup).toContain('aria-label="Final run outcomes"');
    expect(markup).toContain('aria-label="Completed: 190"');
    expect(markup).toContain('aria-label="Partial: 6"');
    expect(markup).toContain('aria-label="Refused: 11"');
    expect(markup).toContain('aria-label="Failed: 7"');
    expect(rendered).toContain('Completed 190 Partial 6 Refused 11 Failed 7');
    expect(rendered).toContain('214 finished questions');
    expect(rendered).not.toContain('sum to questions asked');
    // 11 refused + 7 failed. The page must never show the two added up.
    expect(rendered).not.toMatch(/\b18\b/);
  });

  it('carries the word for each outcome, so nothing rides on colour alone', () => {
    const markup = render(<SummaryStrip payload={payload()} periodLabel="7 days" />);

    // The colours are applied to spans whose meaning is in the label above them.
    expect(markup).toContain('monitoring-refused');
    expect(markup).toContain('monitoring-failed');
    expect(text(markup)).toContain('Refused');
    expect(text(markup)).toContain('Failed');
  });

  it('shows both feedback direction counts', () => {
    expect(text(render(<SummaryStrip payload={payload()} periodLabel="7 days" />))).toContain(
      '36 Helpful · 10 Not helpful'
    );
  });

  it('gives every KPI a concise information line', () => {
    const rendered = text(render(<SummaryStrip payload={payload()} periodLabel="7 days" />));

    expect(rendered).toContain('Submitted in this period');
    expect(rendered).toContain('Distinct conversation threads');
    expect(rendered).toContain('214 finished questions');
    expect(rendered).toContain('36 Helpful · 10 Not helpful');
    expect(rendered).toContain('Over 214 of 214 runs');
  });

  it('shows no percentage when there is no feedback', () => {
    const withoutFeedback = payload({
      summary: { ...payload().summary, helpful: 0, feedbackTotal: 0 },
    });
    const rendered = text(render(<SummaryStrip payload={withoutFeedback} periodLabel="7 days" />));

    expect(rendered).toContain('No feedback');
    expect(rendered).toContain('No feedback in this period');
    expect(rendered).not.toContain('0%');
  });

  it('keeps zero outcome buckets visible but marked as quiet', () => {
    const empty = payload({
      summary: {
        ...payload().summary,
        questionsAsked: 0,
        completed: 0,
        partial: 0,
        refused: 0,
        failed: 0,
      },
    });
    const markup = render(<SummaryStrip payload={empty} periodLabel="7 days" />);

    expect(markup.match(/monitoring-outcome-value-zero/g)).toHaveLength(4);
    for (const label of ['Completed', 'Partial', 'Refused', 'Failed']) {
      expect(markup).toContain(`aria-label="${label}: 0"`);
    }
    expect(text(markup)).toContain('0 finished questions');
  });

  it.each([
    {
      label: 'zero',
      counts: { questionsAsked: 0, completed: 0, partial: 0, refused: 0, failed: 0 },
      expected: '0 finished questions',
    },
    {
      label: 'one',
      counts: { questionsAsked: 1, completed: 0, partial: 1, refused: 0, failed: 0 },
      expected: '1 finished question',
    },
    {
      label: 'many',
      counts: { questionsAsked: 214, completed: 190, partial: 6, refused: 11, failed: 7 },
      expected: '214 finished questions',
    },
  ])('renders plain finished-question copy for $label outcomes', ({ counts, expected }) => {
    const rendered = text(
      render(<SummaryStrip payload={payload({ summary: { ...payload().summary, ...counts } })} periodLabel="7 days" />)
    );

    expect(rendered).toContain(expected);
    expect(rendered).not.toContain('terminal outcome');
  });

  it('keeps large grouped outcome values associated with their labels', () => {
    const large = payload({
      summary: {
        ...payload().summary,
        questionsAsked: 91_234,
        completed: 81_234,
        partial: 4_000,
        refused: 3_000,
        failed: 3_000,
      },
    });
    const markup = render(<SummaryStrip payload={large} periodLabel="7 days" />);

    expect(markup).toContain('aria-label="Completed: 81,234"');
    expect(markup).toContain('aria-label="Partial: 4,000"');
    expect(markup).toContain('aria-label="Refused: 3,000"');
    expect(markup).toContain('aria-label="Failed: 3,000"');
  });

  it('keeps missing feedback and median coverage explicit', () => {
    const missing = payload({
      summary: {
        ...payload().summary,
        questionsAsked: 12,
        helpful: 0,
        feedbackTotal: 0,
        medianMs: null,
        timedCount: 0,
      },
    });
    const rendered = text(render(<SummaryStrip payload={missing} periodLabel="7 days" />));

    expect(rendered).toContain('No feedback No feedback in this period');
    expect(rendered).toContain('No run times recorded Over 0 of 12 runs');
  });
});

describe('the filter row is built from the app, not from the platform', () => {
  const row = () =>
    render(
      <FilterRow
        filters={{ ...NO_FILTERS, table: 'a_catalog.a_schema.gold_title_daily_summary' }}
        people={['ada.reader@example.test']}
        tables={['a_catalog.a_schema.gold_title_daily_summary']}
        onChange={() => {}}
        onClearFilters={() => {}}
      />
    );

  it('seats the controls directly on the page without a boxed surface wrapper', () => {
    const markup = row();
    const wrapper = markup.match(/<div class="monitoring-filters[^"]*"/)?.[0] ?? '';

    expect(wrapper).toBe('<div class="monitoring-filters"');
    expect(markup).not.toContain('monitoring-filters ast-surface-primary');
    expect(markup.match(/data-slot="select-trigger"/g)).toHaveLength(4);
    expect(markup).toContain('run-search monitoring-search');
  });

  /**
   * These were native `<select>` elements. A native select opens the operating
   * system's own menu, which is drawn by the platform and cannot be styled where
   * it matters, so it looked like nothing else in the app and read as detached
   * from the control that opened it.
   */
  it('opens the app\u2019s own dropdown rather than a native select', () => {
    const markup = row();

    // Every control a reader can reach is the app's own. Radix does emit one
    // hidden native select per Select, for form bubbling, and that one is
    // aria-hidden and out of the tab order, so it is not a control: asserting
    // there is no `<select>` at all would be asserting against the library.
    for (const tag of markup.match(/<select[^>]*>/g) ?? []) {
      expect(tag).toContain('aria-hidden="true"');
      expect(tag).toContain('tabindex="-1"');
    }
    expect(markup).not.toContain('<option');
    // The app's Select, through ./ui, which marks its parts with data-slot.
    expect(markup).toContain('data-slot="select-trigger"');
    expect(markup.match(/data-slot="select-trigger"/g)).toHaveLength(4);
  });

  /**
   * Appearance is not traded for the keyboard. Each trigger is a combobox whose
   * accessible name is its own text, so both the filter and its current value are
   * announced. An `aria-label` naming only the filter would have replaced the
   * name and taken the value out of what a reader hears.
   */
  it('keeps each trigger a combobox that announces its value', () => {
    const markup = row();

    expect(markup.match(/role="combobox"/g)).toHaveLength(4);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('aria-label="User"');
  });

  /**
   * The label and the current value on one line, as the design shows, and present
   * on first paint. Rendered from the options rather than resolved out of the open
   * menu, which is empty until Radix mounts and left the chip reading "User ·".
   */
  it('reads label and value together on the trigger', () => {
    const rendered = text(row());

    expect(rendered).toContain('User · All');
    expect(rendered).toContain('Outcome · All');
    expect(rendered).toContain('Feedback · All');
  });

  it('offers the primary User Monitoring action without changing the secondary filters', () => {
    const markup = render(
      <FilterRow
        filters={NO_FILTERS}
        people={[]}
        tables={[]}
        onChange={() => {}}
        onClearFilters={() => {}}
        onOpenUsers={() => {}}
      />
    );
    expect(text(markup)).toContain('User · All');
    expect(text(markup)).toContain('User Monitoring');
    expect(markup).toContain('monitoring-user-browser-trigger');
    expect(markup).toContain('lucide-users');
    expect(markup.indexOf('monitoring-user-browser-trigger')).toBeLessThan(
      markup.indexOf('run-search monitoring-search')
    );
    expect(markup.match(/lucide-search monitoring-search-icon/g)).toHaveLength(1);
  });

  /**
   * A set filter is a chip: the app's selection blue, the value in full, and an
   * ✕ to clear it. The value is not abbreviated, because a table name a reader
   * cannot read whole is a filter they cannot confirm.
   */
  it('renders a set filter as a clearable chip showing the whole value', () => {
    const markup = row();

    expect(markup).toContain('monitoring-chip-active');
    expect(text(markup)).toContain('Table · a_catalog.a_schema.gold_title_daily_summary');
    expect(markup).toContain('aria-label="Clear the table filter"');
  });

  /** Nothing to clear on an unset filter, so no button offering to. */
  it('offers no clear button on a filter nobody set', () => {
    const markup = unfiltered();

    expect(markup).not.toContain('monitoring-chip-active');
    expect(markup).not.toContain('aria-label="Clear the person filter"');
    // And the unset Table filter reads "Any", not "All": there is one table per
    // row and the question is whether a run touched it.
    expect(text(markup)).toContain('Table · Any');
  });

  /**
   * Run Explorer's search box, by the same class and the same input, so the two
   * surfaces cannot drift into looking like two different products.
   */
  it('carries Run Explorer\u2019s search box', () => {
    const markup = row();

    expect(markup).toContain('run-search');
    expect(markup).toContain('aria-label="Search questions or users"');
  });

  it('renders the standard Search glyph as labelled-input decoration', () => {
    const markup = row();
    const icon = markup.match(/<svg[^>]*monitoring-search-icon[^>]*>/)?.[0] ?? '';

    expect(icon).toContain('lucide-search');
    expect(icon).toContain('monitoring-search-icon');
    expect(icon).toContain('aria-hidden="true"');
    expect(icon).toContain('focusable="false"');
    expect(icon).not.toContain('role="button"');
    expect(markup).toContain('aria-label="Search questions or users"');
  });
});

/**
 * Every filter can be removed, and the one control that cannot is drawn as such.
 *
 * Sam tried to unclick the active segment of the time range to remove the period
 * and nothing happened, and read that as there being no way to remove a filter
 * anywhere in the row. Two separate problems: the period genuinely has no off
 * state, and two of the things beside it were harder to clear than they looked.
 *
 * The URL round trip is asserted in monitoring-filters.test.ts, which owns
 * `withFilters` and `clearedFilters`. These tests own the affordances: that a
 * reader can SEE the way back to no constraint.
 */
describe('removing a filter', () => {
  const withEverythingSet = (over: Partial<MonitoringFilters> = {}) =>
    render(
      <FilterRow
        filters={{
          person: 'ada.reader@example.test',
          outcome: 'refused',
          feedback: 'down',
          table: 'a_catalog.a_schema.gold_title_daily_summary',
          search: 'refund',
          ...over,
        }}
        people={['ada.reader@example.test']}
        tables={['a_catalog.a_schema.gold_title_daily_summary']}
        onChange={() => {}}
        onClearFilters={() => {}}
      />
    );

  /** One rule for the whole row: if it is set, it has a cross. */
  it('gives every set filter its own labelled clear button', () => {
    const markup = withEverythingSet();

    expect(markup).toContain('aria-label="Clear the user filter"');
    expect(markup).toContain('aria-label="Clear the outcome filter"');
    expect(markup).toContain('aria-label="Clear the feedback filter"');
    expect(markup).toContain('aria-label="Clear the table filter"');
    expect(markup).toContain('aria-label="Clear the search"');
  });

  /**
   * Each dropdown reads its own off state on the closed chip, which is the other
   * half of "there is a way back": a reader can see the filter is not narrowing
   * anything without opening it.
   *
   * The MENU's items are not asserted here and cannot be. Radix mounts
   * `SelectContent` only while the menu is open, so a static render contains the
   * trigger and nothing else. Whether "All" is in each list is unverified without
   * a browser; that the chip reads "All" when nothing is set is not.
   */
  it('reads its own off state on each closed chip', () => {
    const rendered = text(unfiltered());

    expect(rendered).toContain('User · All');
    expect(rendered).toContain('Outcome · All');
    expect(rendered).toContain('Feedback · All');
    expect(rendered).toContain('Table · Any');
  });

  /**
   * "No feedback" is a filter VALUE, not the absence of one, and the two must not
   * collapse into each other. "Show me answers with no feedback" is a different question
   * from "show me everything", and while an empty string meant both they were
   * indistinguishable. A reader who picks it must be able to tell they did.
   */
  it('tells a No feedback filter apart from an unset one', () => {
    expect(text(withEverythingSet({ feedback: 'none' }))).toContain('Feedback · No feedback');
    expect(text(unfiltered())).toContain('Feedback · All');
    // And it is a set filter, so it clears like one.
    expect(withEverythingSet({ feedback: 'none' })).toContain('aria-label="Clear the feedback filter"');
  });

  /**
   * The search box gets the app's own cross rather than the browser's.
   *
   * `input[type=search]` draws a cancel button in Chrome and Safari and nothing
   * at all in Firefox, so before this the only way to empty the field was a
   * browser feature a third of readers do not have.
   */
  it('draws its own clear inside the search field, not the browser\u2019s', () => {
    expect(withEverythingSet()).toContain('monitoring-search-clear');
    // Nothing typed, nothing to clear.
    expect(unfiltered()).not.toContain('monitoring-search-clear');
  });

  /**
   * Clearing everything at once, offered from the row and not only from the
   * empty state.
   *
   * It used to appear only when the filters excluded every row, which gave a way
   * out to the reader who had narrowed to nothing and none to the reader who had
   * narrowed to two. Same words as the empty state's button, because two
   * controls doing one thing under two names read as two things.
   */
  it('offers one control that clears the whole row when anything is set', () => {
    expect(text(withEverythingSet())).toContain('Clear filters');
    expect(text(unfiltered())).not.toContain('Clear filters');
  });

  /** Including when the only thing set is the search text. */
  it('offers it for a typed search alone', () => {
    const markup = withEverythingSet({ person: '', outcome: '', feedback: '', table: '' });

    expect(text(markup)).toContain('Clear filters');
  });

  it('contains only secondary filters, with no old Period field or divider', () => {
    for (const markup of [withEverythingSet(), unfiltered()]) {
      expect(text(markup)).not.toContain('Period');
      expect(markup).not.toContain('role="radiogroup"');
      expect(markup).not.toContain('monitoring-heading-period');
      expect(markup).not.toContain('monitoring-filters-rule');
      expect(markup).not.toContain('aria-label="Clear the period filter"');
      expect(markup).not.toContain('aria-label="Clear the time range"');
    }
  });
});

describe('the Monitoring heading actions', () => {
  it.each([
    ['/monitoring?range=24h', '24h'],
    ['/monitoring', '7 days'],
    ['/monitoring?range=30d', '30 days'],
    ['/monitoring?range=all', 'All time'],
  ])('selects %s in the heading before the KPI DOM', (entry, selected) => {
    const markup = renderAt(
      <>
        <MonitoringHeading loading={false} checkedAt="" now={NOW} onRefresh={() => {}} />
        <SummaryStrip payload={payload()} periodLabel={selected} />
      </>,
      entry
    );

    expect(markup.indexOf('<h2>Monitoring</h2>')).toBeLessThan(markup.indexOf('monitoring-strip'));
    expect(markup.indexOf('monitoring-heading-actions')).toBeLessThan(markup.indexOf('monitoring-strip'));
    expect(markup).toContain('aria-label="Time range for Monitoring"');
    expect(markup).toMatch(new RegExp(`aria-checked="true"[^>]*>${selected}</button>`));
    expect(text(markup)).toContain('Refresh');
  });

  it('keeps Period visual-only because the radio group already has the accessible name', () => {
    const markup = render(<MonitoringHeading loading={false} checkedAt="" now={NOW} onRefresh={() => {}} />);

    expect(markup).toContain('monitoring-heading-period-label" aria-hidden="true">Period');
    expect(markup.match(/aria-label="Time range for Monitoring"/g)).toHaveLength(1);
  });

  it('shows a subtle refresh state without replacing retained KPIs or rows with skeletons', () => {
    const data = payload();
    const markup = render(
      <>
        <MonitoringHeading loading checkedAt={data.readAt} now={NOW} onRefresh={() => {}} />
        <MonitoringBody
          state="ready"
          payload={data}
          questions={data.questions}
          filters={NO_FILTERS}
          rangeLabel="7 days"
          selectedId=""
          now={NOW}
          onOpen={() => {}}
          onChangeFilters={() => {}}
          onClearFilters={() => {}}
          onRetry={() => {}}
        />
      </>
    );

    expect(text(markup)).toContain('Refreshing…');
    expect(text(markup)).toContain('Questions asked 7 days 214');
    expect(text(markup)).toContain('Compare active players by title over the last 30 days');
    expect(markup).not.toContain('animate-pulse');
  });
});

describe('period-change pagination', () => {
  it('returns to page one when the normalized range changes the request owner', () => {
    const pages = { owner: '7d|from-a|to-a|filters', cursors: ['', 'page-2', 'page-3'], index: 2 };

    expect(monitoringPageForOwner(pages.owner, pages)).toBe(2);
    expect(monitoringPageForOwner('30d|from-b|to-b|filters', pages)).toBe(0);
    expect(monitoringPageForOwner('all|1970-01-01|to-b|filters', pages)).toBe(0);
  });
});

/**
 * The sentence "Filters live in the URL. Send the link, send the view." is gone.
 *
 * Deleted at Sam's request: it told a reader something true that they could not
 * act on, and it held the right end of the row that the search box now takes.
 * Anchor #7a still draws it, so this test is what stops the next audit restoring
 * it as a missing element. The BEHAVIOUR is unchanged and is covered by
 * monitoring-filters.test.ts.
 */
describe('the deleted filter-row note', () => {
  it('says nothing about the URL in the filter row', () => {
    const rendered = text(unfiltered());

    expect(rendered).not.toContain('Filters live in the URL');
    expect(rendered).not.toContain('Send the link');
  });
});

describe('every state in the list', () => {
  /**
   * The filter row is live in every state that has one, including while the list
   * is skeletons. A reader who knows what they want should not wait for a read.
   */
  it('renders the live filter row while loading, and no numbers', () => {
    const markup = body('loading');
    const rendered = text(markup);

    expect(rendered).toContain('User');
    expect(rendered).toContain('Outcome');
    expect(rendered).toContain('Feedback');
    expect(rendered).toContain('Table');
    // The attribute, not the word. The app's own Select carries Tailwind classes
    // named `disabled:opacity-50`, so a substring match on "disabled" passed
    // judgement on a class list rather than on whether anything is switched off.
    expect(markup).not.toMatch(/\sdisabled[=\s>]/);
    expect(markup).not.toMatch(/aria-disabled="true"/);
    // Skeletons, not figures, and not a zero.
    expect(rendered).not.toContain('214');
    expect(rendered).not.toContain('sum to questions asked');
  });

  it('says the range is empty without offering to clear filters', () => {
    const rendered = text(body('empty-range', { questions: [] }));

    expect(rendered).toContain('No questions in this range.');
    expect(rendered).not.toContain('No questions match these filters.');
    expect(rendered).not.toContain('Clear filters');
  });

  it('says the filters exclude everything, and offers to clear them', () => {
    const rendered = text(body('empty-filters', { questions: [] }, { ...NO_FILTERS, outcome: 'failed' }));

    expect(rendered).toContain('No questions match these filters.');
    expect(rendered).not.toContain('No questions in this range.');
    expect(rendered).toContain('Clear filters');
  });

  /**
   * A typed word that matches nothing is a different emptiness from a chip that
   * excludes everything, and it is undone differently. The word is quoted back so
   * a reader who mistyped can see that they did.
   */
  it('says a search matched nothing, distinctly, and offers to clear the search', () => {
    const rendered = text(body('empty-search', { questions: [] }, { ...NO_FILTERS, search: 'net bokings' }));

    expect(rendered).toContain('Nothing matches "net bokings".');
    expect(rendered).not.toContain('No questions match these filters.');
    expect(rendered).not.toContain('No questions in this range.');
    expect(rendered).toContain('Clear search');
    // No chip is set, so the empty state does not claim otherwise.
    expect(rendered).not.toContain('The other filters are narrowing this list too');
    // ONCE, from the filter row. The empty state does not add a second copy of a
    // button that is already on screen: a search IS one of the filters the row's
    // Clear filters button clears, so the reader already has that route.
    expect(occurrences(rendered, 'Clear filters')).toBe(1);
  });

  /**
   * Clearing the word alone would leave the reader still looking at nothing, so
   * the sentence says a chip is narrowing too and both ways out are offered.
   */
  it('names the chips as well when both are narrowing', () => {
    const rendered = text(
      body('empty-search', { questions: [] }, { ...NO_FILTERS, search: 'spending', outcome: 'failed' })
    );

    expect(rendered).toContain('Nothing matches "spending".');
    expect(rendered).not.toContain('The other filters are narrowing this list too');
    expect(rendered).toContain('Clear search');
    expect(rendered).toContain('Clear filters');
  });

  /**
   * The page body is replaced, not half-populated. The sentence has to say the
   * list is blank because nobody could read it, which is the opposite of what an
   * empty list would have said.
   */
  it('swaps the body for the storage-failure panel when the store is unreachable', () => {
    const rendered = text(body('unavailable'));

    expect(rendered).toContain('Conversations could not be read');
    expect(rendered).toContain('not because you have no history');
    // No strip, no filter row, no list over an outage.
    expect(rendered).not.toContain('Questions asked');
    expect(rendered).not.toContain('No questions in this range.');
    // Re-reading is the one useful action, and it uses the shared control's word.
    expect(rendered).toContain('Refresh');
  });

  it('says how many questions a partial read counted', () => {
    const rendered = text(body('partial', { readState: 'partial', countedQuestions: 2000, foundQuestions: 5312 }));

    expect(rendered).toContain('Counted 2,000 of 5,312 questions');
    // The strip still renders, over the stated number rather than over nothing.
    expect(rendered).toContain('Questions asked');
  });

  /**
   * No warning about the size of the window, at any size.
   *
   * A line here used to say "N questions in this range. This read slows as that
   * number grows." past 500 questions, standing in for a guard while the read
   * really was quadratic in the range. The query now pages first and pairs per
   * page, so an all-time window costs a page what a day costs, and a warning
   * about a cost nobody pays only teaches a reader to narrow a range for no
   * reason. 4,212 is the volume that used to print it.
   */
  it('says nothing about speed at any volume, including one that used to warn', () => {
    for (const asked of [13, 214, 4212, 40_000]) {
      const rendered = text(body('ready', { summary: { ...payload().summary, questionsAsked: asked } }));

      expect(rendered).not.toContain('slows as that number grows');
      expect(rendered).not.toContain('questions in this range.');
    }
  });

  /**
   * And the limit that IS load-bearing still speaks. Removing the stale line must
   * not have taken the read cap's sentence with it: a truncated read still states
   * its own denominator.
   */
  it('still says what a partial read counted, over a window that was truncated', () => {
    const rendered = text(body('partial', { readState: 'partial', countedQuestions: 2000, foundQuestions: 40_000 }));

    expect(rendered).toContain('Counted 2,000 of 40,000 questions');
  });

  /**
   * An all-time window holding nothing is a fact about the deployment, not a
   * failure of it. This is the distinction a recent bug got backwards, reporting
   * an unreadable store as an empty one, and All time is the range most likely to
   * be pressed by somebody checking whether anything is recorded at all.
   */
  it('separates an empty all-time range from a store it could not read', () => {
    const markup = body('empty-range', { summary: { ...payload().summary, questionsAsked: 0 } });
    // The empty block on its own. The strip above it prints all four outcomes as
    // a column label whatever the state, and reading the whole page
    // would catch that word and call it a claim of failure.
    const empty = text(/<div class="monitoring-empty">[\s\S]*?<\/div><\/div>/.exec(markup)?.[0] ?? '');

    expect(empty).toContain('No questions in this range.');
    for (const banned of ['could not', 'unavailable', 'failed', 'error', 'try again', 'refresh']) {
      expect(empty.toLowerCase(), banned).not.toContain(banned);
    }
    // Nothing to undo, so nothing is offered. A button here would suggest the
    // reader had done something to cause this.
    expect(empty).not.toContain('Clear filters');

    // And the other way round: an unreadable store never claims to be empty.
    const broken = text(body('unavailable'));
    expect(broken).not.toContain('No questions in this range.');
    expect(broken).toContain('Conversations could not be read');
  });

  it('renders the list when there is one', () => {
    const rendered = text(body('ready'));

    expect(rendered).toContain('Compare active players by title over the last 30 days');
    expect(rendered).toContain('first.person');
    expect(rendered).toContain('Completed');
    expect(rendered).toContain('76.2s');
  });

  /**
   * The page a reader first meets: mounted, nothing fetched. Its title and its
   * one control, and no sub-headline -- the page used to explain itself in a
   * sentence under the title, which was deleted from every page in the app.
   */
  it('opens on the loading state with its heading and its control', () => {
    const rendered = text(render(<MonitoringPage />));

    expect(rendered).toContain('Monitoring');
    expect(rendered).not.toContain('Every question asked');
    expect(rendered).toContain('Refresh');
  });
});

describe('the question list', () => {
  it('makes the native table row the single question activation target', () => {
    const markup = body('ready');
    const row = markup.match(/<tr[^>]*class="monitoring-row[^"]*"[^>]*>/)?.[0] ?? '';

    expect(row).toContain('tabindex="0"');
    expect(row).toContain('aria-haspopup="dialog"');
    expect(row).toContain('aria-label="Open question details: Compare active players by title over the last 30 days"');
    expect(markup).not.toContain('<tr role="button"');
    expect(markup).not.toContain('monitoring-question-button');
    expect(markup).toMatch(
      /<td class="monitoring-question"><span class="monitoring-question-text">Compare active players/
    );
  });

  it('puts the full address on the asker cell and shows the local part', () => {
    const markup = body('ready');

    expect(markup).toContain('title="first.person@example.test"');
    expect(text(markup)).toContain('first.person');
  });

  it('makes the person mark open the shared profile contract without replacing the row action', () => {
    const markup = render(
      <QuestionList questions={[question()]} selectedId="" now={NOW} onOpen={() => {}} onOpenPerson={() => {}} />
    );

    expect(markup).toContain('class="user-drilldown-link user-drilldown-link--chip"');
    expect(markup).toContain('aria-label="Open user overview for first.person"');
    expect(markup).toContain('identity-chip-link-arrow');
    expect(markup).not.toContain('monitoring-question-button');
    expect(markup).not.toContain('<button');
  });

  it('renders one focusable card row below 800px instead of the clipped table', () => {
    expect(MONITORING_COMPACT_QUERY).toBe('(max-width: 799px)');
    const markup = render(<QuestionList questions={[question()]} selectedId="" now={NOW} onOpen={() => {}} compact />);
    const card = markup.match(/<li[^>]*class="monitoring-question-card[^"]*"[^>]*>/)?.[0] ?? '';

    expect(markup).toContain('class="monitoring-card-list"');
    expect(markup).toContain('aria-label="Questions"');
    expect(card).toContain('tabindex="0"');
    expect(card).toContain('aria-haspopup="dialog"');
    expect(card).toContain('aria-label="Open question details: Compare active players by title over the last 30 days"');
    expect(markup).not.toContain('monitoring-question-card-button');
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('<tr');
    expect(text(markup)).toContain('Time 76.2s');
    expect(text(markup)).toContain('Tools 5');
  });

  it('keeps the selected row identifiable while its dialog is open', () => {
    const desktop = render(
      <QuestionList questions={[question()]} selectedId="q1" now={NOW} onOpen={() => {}} onOpenPerson={() => {}} />
    );
    const compact = render(
      <QuestionList questions={[question()]} selectedId="q1" now={NOW} onOpen={() => {}} compact />
    );

    for (const markup of [desktop, compact]) {
      expect(markup).toContain('monitoring-row-selected');
      expect(markup).toContain('aria-current="true"');
    }
  });

  it('carries the refusal sentence on the row rather than only a colour', () => {
    const markup = body('ready', {
      questions: [
        question({
          outcome: 'refused',
          outcomeDetail: 'You do not have access to one or more data products required by this question.',
          feedback: null,
        }),
      ],
    });

    expect(text(markup)).toContain('Refused');
    expect(markup).toContain('title="You do not have access to one or more data products required by this question."');
  });

  /**
   * A MEASUREMENT THIS LIST DOES NOT HAVE IS NOT A MEASUREMENT NOBODY TOOK.
   *
   * These two cells said "Not recorded", which is a claim about the world rather
   * than about the query behind the table, and it contradicted the tab next door.
   * Both tabs read the same two JSON keys, off different rows. Monitoring takes
   * `response_json->'trace'->>'totalMs'` and `->>'toolCalls'` from the FIRST
   * assistant message after the question; because the lateral join does not let
   * a plan approval close the window, on a plan-approval turn that first message
   * is the plan, whose trace carries neither key. Run Explorer lists the final
   * answer, whose trace carries both. Same run, a wall time on one tab and "Not
   * recorded" on the other. The exact line numbers are in MonitoringPage.tsx
   * beside the cells; reconciling them is a server change.
   *
   * The list cannot reconcile them from here, so it stops asserting instead. The
   * row opens the drawer, which loads the trace, so the figure is one click away
   * rather than denied.
   */
  it('makes no claim about a measurement this list was not sent', () => {
    const rendered = text(body('ready', { questions: [question({ durationMs: null, toolCalls: null })] }));

    expect(rendered).not.toContain('Not recorded');
    // The original point of this test, which still holds: an unmeasured run must
    // never be rendered as a measured zero.
    expect(rendered).not.toMatch(/\b0\.0s\b/);
    expect(rendered).not.toMatch(/\b0 tool/);
  });

  /** And a run that WAS measured still prints both figures, in the mono face. */
  it('prints the figures it does have, tabular', () => {
    const markup = body('ready', { questions: [question({ durationMs: 12_400, toolCalls: 3 })] });
    expect(markup).toMatch(/class="monitoring-numeric ast-num">12\.4s</);
    expect(markup).toMatch(/class="monitoring-numeric ast-num">3</);
  });
});

/* ── The question modal ──────────────────────────────────────────────────── */

function detail(overrides: Partial<MonitoringDetail> = {}): MonitoringDetail {
  return {
    id: 'q1',
    conversationId: 'c1',
    question: 'Which countries grew fastest this quarter?',
    askedBy: 'first.person@example.test',
    askedAt: '2026-08-15T06:40:00Z',
    outcome: 'completed',
    outcomeDetail: null,
    outcomeCode: null,
    answer: {
      type: 'answer',
      mode: 'live',
      takeaway: 'The leading title is ahead on daily active players.',
      narrative: 'A narrative sentence.',
      figures: [],
      sources: [{ name: 'a_catalog.a_schema.a_table', freshness: 'today' }],
      caveats: [],
      sql: 'SELECT 1',
      trace: { id: 'tr-1', totalMs: 8100, toolCalls: 2, stages: [] },
    },
    conditioning: null,
    trace: { id: 'tr-1', totalMs: 8100, toolCalls: 2, stages: [] },
    tokens: { prompt: 900, completion: 300, total: 1200 },
    execution: { mode: 'signed_in_user', verified: true },
    feedback: 'down',
    comment: 'Exactly what I needed.',
    mlflowUrl: 'https://example.test/ml/experiments/1/traces',
    runId: 'a1',
    ...overrides,
  };
}

describe('the detail modal', () => {
  it('uses the shared dialog contract for every question and person state', () => {
    expect(MONITORING_SOURCE).toContain("import { Dialog } from './Dialog'");
    expect(MONITORING_SOURCE.match(/<Dialog/g)).toHaveLength(5);
    expect(MONITORING_SOURCE).not.toContain("window.addEventListener('keydown'");

    const readyQuestion = render(<QuestionDrawer detail={detail()} onClose={() => {}} canOpenUser />);
    const readyPerson = render(
      <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
    );
    for (const markup of [readyQuestion, readyPerson]) {
      expect(markup).toContain('role="dialog"');
      expect(markup).toContain('aria-modal="true"');
      expect(markup).toContain('tabindex="-1"');
    }
  });

  it('mounts immediately with explicit idle, loading, and error states', () => {
    const idle = render(
      <QuestionPanel
        state={idlePanel<MonitoringDetail>()}
        title="Question details"
        onClose={() => {}}
        canOpenUser
        onRetry={() => {}}
      />
    );
    const loading = render(
      <QuestionPanel
        state={beginPanelLoad<MonitoringDetail>('question|q1|from|to|', 1)}
        title="Question details"
        onClose={() => {}}
        canOpenUser
        onRetry={() => {}}
      />
    );
    const error = render(
      <QuestionPanel
        state={rejectPanelLoad(
          beginPanelLoad<MonitoringDetail>('question|q1|from|to|', 1),
          'question|q1|from|to|',
          1,
          'Could not load.'
        )}
        title="Question details"
        onClose={() => {}}
        canOpenUser
        onRetry={() => {}}
      />
    );

    for (const markup of [idle, loading, error]) {
      expect(markup).toContain('role="dialog"');
      expect(markup).toContain('Question details');
      expect(markup).toContain('Close');
    }
    expect(loading).toContain('role="status"');
    expect(error).toContain('role="alert"');
    expect(text(error)).toContain('Could not load. Retry');
  });

  it('names who asked and whose grants the data was read under', () => {
    const rendered = text(render(<QuestionDrawer detail={detail()} onClose={() => {}} canOpenUser />));

    expect(rendered).toContain('Asked by first.person');
    expect(rendered).toContain("Data read under first.person's own Unity Catalog grants.");
  });

  it('says nothing about identity when the run recorded none, and leaves no dangling separator', () => {
    const rendered = text(
      render(<QuestionDrawer detail={detail({ execution: null })} onClose={() => {}} canOpenUser />)
    );

    expect(rendered).not.toMatch(/unconfirmed/i);
    // And the asker is not borrowed to fill the gap: this is precisely the run
    // whose identity might not have been theirs.
    expect(rendered).not.toContain("first.person's own Unity Catalog grants");
    // Who asked and when still print, with the meta line ending on the stamp
    // rather than on the middot that used to join the third segment.
    expect(rendered).toContain('Asked by first.person');
    expect(rendered).not.toMatch(/·\s*$/m);
  });

  /**
   * WHERE THE THREE ONWARD LINKS ARE, which is the whole of this claim.
   *
   * They were the last thing in the old drawer, under the answer, the timeline,
   * the token count and the feedback -- so on a real run an admin scrolled a
   * full answer and a ten-step trace before reaching the trace link they opened
   * the question to follow. Asserted as an ORDERING rather than as presence,
   * because every presence assertion in this file passed while they were at the
   * bottom.
   */
  it('puts the three onward links at the top, above the answer and the trace', () => {
    const markup = render(<QuestionDrawer detail={detail()} onClose={() => {}} canOpenUser />);

    const mlflow = markup.indexOf('Open the MLflow trace');
    const runs = markup.indexOf('Open in Run Explorer');
    const person = markup.indexOf('aria-label="Open user overview for first.person"');
    expect(mlflow).toBeGreaterThan(-1);

    // Still the same three, still in the same order across the row.
    expect(mlflow).toBeLessThan(runs);
    expect(runs).toBeLessThan(person);

    // And all three above everything a reader would have had to scroll past.
    expect(person).toBeLessThan(markup.indexOf('The leading title is ahead on daily active players.'));
    expect(person).toBeLessThan(markup.indexOf('Run process'));
    expect(person).toBeLessThan(markup.indexOf('1,200 tokens recorded on this run.'));
    expect(person).toBeLessThan(markup.indexOf('Not helpful'));
  });

  it('keeps the links above the answer on a run that recorded no trace id', () => {
    // The MLflow link is absent rather than dead, and its absence must not drop
    // the other two back under the answer.
    const rendered = text(
      render(<QuestionDrawer detail={detail({ mlflowUrl: null })} onClose={() => {}} canOpenUser />)
    );

    expect(rendered).not.toContain('Open the MLflow trace');
    expect(rendered.indexOf('Open in Run Explorer')).toBeLessThan(
      rendered.indexOf('The leading title is ahead on daily active players.')
    );
  });

  it('renders the answer with Ask PIA\u2019s own card when nothing is conditioned', () => {
    const markup = render(<QuestionDrawer detail={detail()} onClose={() => {}} canOpenUser />);
    const rendered = text(markup);

    expect(markup).toContain('class="answer-card');
    expect(rendered).toContain('The leading title is ahead on daily active players.');
    expect(rendered).toContain('Run process');
    expect(rendered).not.toContain('What ran');
  });

  it('replaces the answer with one line and keeps everything always shown', () => {
    const conditioned = detail({
      answer: null,
      conditioning: { table: 'a_catalog.a_schema.a_table', permission: 'SELECT' },
    });
    const markup = render(<QuestionDrawer detail={conditioned} onClose={() => {}} canOpenUser />);
    const rendered = text(markup);

    expect(rendered).toContain('a_catalog.a_schema.a_table: you do not have SELECT on this table.');
    // The answer body is gone.
    expect(rendered).not.toContain('The leading title is ahead on daily active players.');
    // The always-shown set is not.
    expect(rendered).toContain('Asked by first.person');
    expect(rendered).toContain("Data read under first.person's own Unity Catalog grants.");
    expect(rendered).toContain('1,200 tokens recorded on this run.');
    expect(rendered).toContain('Not helpful');
    expect(rendered).toContain('Exactly what I needed.');
    expect(rendered).toContain('Open the MLflow trace');
    // No tone on the note: it is body text in the same type as the prose.
    expect(markup).toContain('class="monitoring-conditioned"');
    expect(markup).not.toMatch(/monitoring-conditioned[^>]*destructive/);
  });

  /**
   * The resolution-failure fallback, which is the one that must not fail closed.
   * When the check could not run, nothing is conditioned and one line sits above
   * the list saying so.
   */
  it('shows everything and says so when the permissions check could not run', () => {
    const rendered = text(body('ready', { grantsResolution: 'failed' }));

    expect(rendered).toContain(GRANTS_UNRESOLVED_LINE);
    expect(rendered).toContain('Could not check your table permissions just now, so everything is shown.');
    // The list is still there. Nothing was hidden.
    expect(rendered).toContain('Compare active players by title over the last 30 days');
  });

  it('says nothing about permissions when the check ran', () => {
    expect(text(body('ready'))).not.toContain(GRANTS_UNRESOLVED_LINE);
  });

  it('omits the MLflow link rather than offering a dead one', () => {
    const rendered = text(
      render(<QuestionDrawer detail={detail({ mlflowUrl: null })} onClose={() => {}} canOpenUser />)
    );

    expect(rendered).not.toContain('Open the MLflow trace');
    // The other two links are unaffected.
    expect(rendered).toContain('Open in Run Explorer');
    expect(rendered).toContain('first.person');
  });

  it('uses one shared user badge as the canonical profile link without duplicate controls or possessive copy', () => {
    const markup = renderAt(
      <QuestionDrawer detail={detail({ askedBy: '<your-username>@example.test' })} onClose={() => {}} canOpenUser />,
      '/monitoring?question=q1&range=7d&userSearch=sam'
    );
    const rendered = text(markup);
    expect(markup).toContain('class="user-drilldown-link user-drilldown-link--chip"');
    expect(markup).toContain('class="identity-chip identity-chip--compact"');
    expect(markup).toContain('lucide-user-round');
    expect(markup).toContain('aria-label="Open user overview for <your-username>"');
    expect(markup).toContain('href="/monitoring?range=7d&amp;userSearch=sam&amp;who=<your-username>%40example.test"');
    expect(occurrences(markup, 'aria-label="Open user overview for <your-username>"')).toBe(1);
    const overviewLink = markup.match(/<a[^>]*aria-label="Open user overview[^"]*"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
    expect(overviewLink).not.toContain('<button');
    expect(overviewLink.match(/<a /g)).toHaveLength(1);
    expect(rendered).toContain('<your-username>');
    expect(rendered).not.toMatch(/see sam\.mathews|sam\.mathews['’]s? activity|this person['’]s activity/i);
  });

  it('aligns and wraps the user badge beside Run Explorer without widening the modal', () => {
    expect(MONITORING_CSS).toMatch(
      /\.monitoring-drawer-links\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*flex-wrap:\s*wrap[^}]*min-width:\s*0/s
    );
    expect(MONITORING_CSS).toContain('.monitoring-drawer-links > a:not(.user-drilldown-link)');
  });

  it('keeps the user badge non-interactive when User Monitoring is unavailable', () => {
    const markup = render(
      <QuestionDrawer detail={detail({ askedBy: '<your-username>@example.test' })} onClose={() => {}} canOpenUser={false} />
    );

    expect(markup).toContain('class="identity-chip identity-chip--compact"');
    expect(markup).not.toContain('aria-label="Open user overview for <your-username>"');
    expect(markup).not.toContain('who=<your-username>%40example.test');
  });

  it('never links unknown, system, or service-principal actors', () => {
    for (const askedBy of ['', 'system', 'service-principal-id']) {
      const markup = render(<QuestionDrawer detail={detail({ askedBy })} onClose={() => {}} canOpenUser />);
      expect(markup).not.toContain('aria-label="Open user overview');
      expect(markup).not.toContain('/monitoring?who=');
    }
  });

  it('keeps the same badge footer for live, stored, and replayed answer shapes', () => {
    const live = detail();
    const stored = detail({
      answer: { ...(detail().answer as Record<string, unknown>), mode: 'representative', provenance: 'stored' },
    });
    const replayed = detail({
      answer: { ...(detail().answer as Record<string, unknown>), provenance: 'mixed' },
    });

    for (const state of [live, stored, replayed]) {
      const markup = render(<QuestionDrawer detail={state} onClose={() => {}} canOpenUser />);
      expect(markup).toContain('aria-label="Open user overview for first.person"');
      expect(occurrences(markup, 'aria-label="Open user overview for first.person"')).toBe(1);
    }
  });

  it('shows the taxonomy sentence and the code for a refusal', () => {
    const refused = detail({
      answer: null,
      outcome: 'refused',
      outcomeDetail: 'You do not have access to one or more data products required by this question.',
      outcomeCode: 'USER_NOT_AUTHORIZED',
      feedback: null,
      comment: null,
    });
    const rendered = text(render(<QuestionDrawer detail={refused} onClose={() => {}} canOpenUser />));

    expect(rendered).toContain('You do not have access to one or more data products required by this question.');
    expect(rendered).toContain('USER_NOT_AUTHORIZED');
  });

  it('says a run was not metred rather than reporting zero tokens', () => {
    const rendered = text(render(<QuestionDrawer detail={detail({ tokens: null })} onClose={() => {}} canOpenUser />));

    expect(rendered).toContain('This run was not metred, so no token count was recorded.');
    expect(rendered).not.toContain('0 tokens');
  });
});

describe('the User Monitoring browser', () => {
  const browser = {
    open: true,
    search: '',
    role: '',
    persona: '',
    unit: 'USD' as const,
    cursor: '',
    range: '7d' as const,
  };
  const noop = () => {};
  const payload = {
    userMonitoring: {
      schemaRevision: 2,
      readAt: '2026-08-15T12:00:00Z',
      range: { from: '2026-08-09', to: '2026-08-15' },
      unit: 'USD',
      state: 'partial',
      reason: 'Vector Search coverage is partial.',
      personas: [{ id: 'analyst', name: 'Analyst', count: 1 }],
      dataRevision: 7,
      users: [
        {
          email: 'ada.reader@example.test',
          role: 'admin',
          persona: { id: 'analyst', name: 'Analyst' },
          lastActive: '2026-08-15T10:00:00Z',
          questions: 12,
          runs: 12,
          spend: {
            usd: { amount: 8.5, quality: 'allocated' },
            dbu: { amount: 3.25, quality: 'allocated' },
          },
          coverage: 'allocated',
        },
        {
          email: 'no.cost@example.test',
          role: 'consumer',
          persona: null,
          lastActive: '2026-08-14T10:00:00Z',
          questions: 1,
          runs: 1,
          spend: {
            usd: { amount: null, quality: 'unavailable' },
            dbu: { amount: null, quality: 'unavailable' },
          },
          coverage: 'unavailable',
        },
      ],
      pagination: { total: 2, pageSize: 25, hasMore: false, nextCursor: null },
      reconciliation: {
        usd: { unit: 'USD', appTotal: 8.5, users: 8.5, unattributed: 0, difference: 0 },
        dbu: { unit: 'DBU', appTotal: 3.25, users: 3.25, unattributed: 0, difference: 0 },
      },
    },
  } as unknown as OpsCostPayload;

  it('renders one centered dialog with filters and spend-ordered user rows', () => {
    const markup = render(
      <UserMonitoringPanel
        state={{ status: 'ready', key: 'users', requestId: 1, data: payload, error: null }}
        browser={browser}
        rangeLabel="last 7 days"
        now={NOW}
        onClose={noop}
        onOpenUser={noop}
        onSearch={noop}
        onRole={noop}
        onUnit={noop}
        onRange={noop}
        onClear={noop}
        onNext={noop}
        onPrevious={noop}
      />
    );
    const visible = text(markup);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(visible).toContain('User Monitoring');
    expect(markup).toContain('placeholder="Search users…');
    expect(visible).toContain('ada.reader');
    expect(visible).toContain('$8.50');
    expect(visible).toContain('Admin');
    expect(visible).toContain('Analyst');
    expect(visible).toContain('–');
    expect(visible).not.toContain('Unavailable');
    expect(markup).not.toMatch(/>\s*Coverage\s*</);
    expect(markup).not.toContain('Attribution coverage');
    expect(visible).not.toContain('Allocated');
    expect(markup).toContain('data-unit-segmented-control="true"');
    expect(markup.match(/class="time-range-segment unit-segmented-option"/g)).toHaveLength(2);
    expect(markup).not.toContain('monitoring-users-unit');
    expect(markup.indexOf('>Persona<')).toBeLessThan(markup.indexOf('>Activity<'));
    expect(markup.indexOf('>Activity<')).toBeLessThan(markup.indexOf('>Questions / runs<'));
    expect(markup.indexOf('>Questions / runs<')).toBeLessThan(markup.indexOf('>Spend<'));
    expect(markup).toContain('aria-label="Open ada.reader User Overview"');
  });

  it('uses one centered users icon without fake rows before results arrive', () => {
    const markup = render(
      <UserMonitoringPanel
        state={beginPanelLoad<OpsCostPayload>('users', 1)}
        browser={browser}
        rangeLabel="last 7 days"
        now={NOW}
        onClose={noop}
        onOpenUser={noop}
        onSearch={noop}
        onRole={noop}
        onUnit={noop}
        onRange={noop}
        onClear={noop}
        onNext={noop}
        onPrevious={noop}
      />
    );
    expect(markup).toContain('monitoring-users-loading');
    expect(text(markup)).toContain('Loading users');
    expect(markup.match(/monitoring-users-loading-icon/g)).toHaveLength(1);
    expect(markup).toContain('lucide-users');
    expect(markup).not.toContain('monitoring-users-loading-list');
    expect(markup).not.toContain('monitoring-users-table-frame');
    expect(markup).not.toContain('data-slot="skeleton"');
  });
});

/* ── The per-user panel ──────────────────────────────────────────────────── */

function panel(overrides: Partial<PersonPanelPayload> = {}): PersonPanelPayload {
  return {
    email: 'first.person@example.test',
    role: 'consumer',
    persona: null,
    firstSeen: '2026-03-04T09:00:00Z',
    lastSeen: '2026-08-15T10:00:00Z',
    summary: {
      questionsAsked: 41,
      userThreads: 6,
      completed: 34,
      partial: 2,
      refused: 3,
      failed: 2,
      helpful: 7,
      feedbackTotal: 9,
      medianMs: 39_000,
      timedCount: 41,
    },
    durationsMs: Array.from({ length: 41 }, (_v, index) => (index + 1) * 2_000),
    tokens: { total: 412_000, metredRuns: 38, totalRuns: 41 },
    tokenCostUsd: 3.84,
    helpful: 7,
    notHelpful: 2,
    tablesReadMost: [{ table: 'a_catalog.a_schema.a_table', runs: 28 }],
    executionSplit: { asThemselves: 41, asApplication: 0, unrecorded: 0 },
    subjectSplit: { verified: 39, confirmedByEndpoint: 2, unrecorded: 0 },
    grants: [
      {
        table: 'a_catalog.a_schema.a_table',
        canRead: true,
        missing: null,
        rowFilter: true,
        maskedColumns: [],
        source: 'live-user-probe',
        verifiedRuns: 0,
        latestVerifiedReadAt: null,
      },
      {
        table: 'a_catalog.a_schema.b_table',
        canRead: false,
        missing: 'SELECT missing',
        rowFilter: false,
        maskedColumns: ['a_column'],
        source: 'live-user-probe',
        verifiedRuns: 0,
        latestVerifiedReadAt: null,
      },
    ],
    grantsMode: 'live-self',
    refusedMissingGrant: 2,
    refusedAgentRules: 1,
    questions: [question()],
    readState: 'ok',
    readAt: '2026-08-15T11:58:00Z',
    pagination: { pageSize: 50, total: 41, hasMore: false, nextCursor: null },
    ...overrides,
  };
}

describe('the per-user panel', () => {
  it('uses one dedicated question table that CSS turns into mobile cards', () => {
    const markup = render(
      <PersonPanel
        panel={panel()}
        now={NOW}
        rangeLabel="last 7 days"
        onClose={() => {}}
        onOpenQuestion={() => {}}
        compactQuestions
      />
    );
    const questions = markup.slice(markup.indexOf('Their questions'));
    expect(questions).toContain('user-profile-modal-question-table');
    expect(questions).toContain('<table');
  });

  it('is a labelled centered modal with no side-panel semantics', () => {
    const markup = render(
      <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
    );

    expect(markup).toContain('class="user-profile-modal ast-dialog-panel"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-describedby="user-profile-modal-description"');
    expect(markup).not.toContain('<aside');
    expect(markup).not.toContain('class="monitoring-drawer"');
  });

  it('uses the compact shared navigation treatment for cached back navigation', () => {
    const markup = render(
      <PersonPanel
        panel={panel()}
        now={NOW}
        rangeLabel="last 7 days"
        onClose={() => {}}
        onOpenQuestion={() => {}}
        onBack={() => {}}
      />
    );
    const back = markup.match(/<button[^>]*user-profile-modal-back[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(back).toContain('monitoring-link-arrow size-3.5');
    expect(back).toContain('Back to all users');
    expect(back.indexOf('lucide-arrow-left')).toBeLessThan(back.indexOf('Back to all users'));
    expect(back).not.toContain('tabindex="-1"');
  });

  it('shows only the selected attributable total and no component accounting detail', () => {
    const cost: OpsCostPayload = {
      state: 'ready',
      grant: null,
      reason: '',
      currency: 'USD',
      throughDay: '2026-08-31',
      range: { from: '2026-08-25', to: '2026-08-31' },
      billingLagDays: 0,
      readAt: '2026-09-01T12:00:00Z',
      tiles: [],
      perQuestion: {
        runs: [],
        runsInRange: 0,
        tokenCoveredRuns: 0,
        totalRecordedTokens: 0,
        limited: false,
        reason: '',
      },
      budgets: { total: { USD: null, DBU: null }, resources: {} },
      budgetsReadable: true,
      spendByUser: {
        dataRevision: 7,
        readAt: '2026-08-31T12:00:00Z',
        requestedRange: { from: '2026-08-25', to: '2026-08-31' },
        range: { from: '2026-08-25', to: '2026-08-31' },
        state: 'ready',
        reason: '',
        users: [
          {
            email: 'first.person@example.test',
            total: {
              usd: { amount: 12.5, quality: 'allocated' },
              dbu: { amount: 6.25, quality: 'allocated' },
            },
            metrics: {
              unit: 'USD',
              questions: 5,
              coveredDays: 4,
              costPerQuestion: { value: 2.5, state: 'value', subtitle: '5 submitted questions' },
              averageDaily: { value: 3.125, state: 'value', subtitle: '4 covered days' },
              appShare: { value: 25, state: 'value', subtitle: 'of comparable app spend' },
            },
            components: [
              {
                id: 'serving-endpoint',
                label: 'Serving endpoint',
                usd: { amount: 12.5, quality: 'allocated' },
                dbu: { amount: 6.25, quality: 'allocated' },
                reason: '',
              },
              {
                id: 'app-compute',
                label: 'App compute',
                usd: { amount: null, quality: 'unavailable' },
                dbu: { amount: null, quality: 'unavailable' },
                reason: 'Active-minute coverage is incomplete.',
              },
              {
                id: 'sql-warehouse',
                label: 'SQL warehouse',
                usd: { amount: 1.25, quality: 'joined' },
                dbu: { amount: 0.5, quality: 'joined' },
                reason:
                  'Joined through a durable query identifier for a very long catalog.schema.table_name_that_must_wrap_without_crossing_columns.',
              },
              {
                id: 'data-genie',
                label: 'Data Genie · sales-space',
                usd: { amount: null, quality: 'unavailable' },
                dbu: { amount: null, quality: 'unavailable' },
                reason: 'No charged usage was returned for this space.',
              },
              {
                id: 'dictionary-genie',
                label: 'Dictionary Genie · dictionary-space',
                usd: { amount: null, quality: 'unavailable' },
                dbu: { amount: null, quality: 'unavailable' },
                reason: 'No charged usage was returned for this separate space.',
              },
              {
                id: 'vector-search',
                label: 'Vector Search',
                usd: { amount: null, quality: 'unavailable' },
                dbu: { amount: null, quality: 'unavailable' },
                reason: 'Resource-scoped requester evidence was incomplete.',
              },
            ],
          },
        ],
        unattributed: [],
        reconciliation: {
          usd: { unit: 'USD', appTotal: 12.5, users: 12.5, unattributed: 0, difference: 0 },
          dbu: { unit: 'DBU', appTotal: 6.25, users: 6.25, unattributed: 0, difference: 0 },
        },
      },
    };
    const markup = render(
      <PersonPanel
        panel={panel()}
        spendState={{ status: 'ready', key: 'spend', requestId: 1, data: cost, error: null }}
        now={NOW}
        rangeLabel="last 7 days"
        onClose={() => {}}
        onOpenQuestion={() => {}}
      />
    );
    const rendered = text(markup);

    expect(rendered).toContain('Total user spend Estimated 12.50 USD');
    expect(rendered).toContain('Cost / question Estimated 2.50 USD 5 submitted questions');
    expect(rendered).toContain('Average tokens Estimated');
    expect(rendered).toContain('Average daily spend Estimated 3.125 USD 4 covered days');
    expect(rendered).toContain('Share of app spend Estimated 25% of comparable app spend');
    expect(rendered.match(/Estimated/g)).toHaveLength(5);
    expect(rendered).not.toMatch(/(?:submitted questions|\/ question|covered days|app spend) · Estimated/);
    expect(rendered).not.toMatch(/Week over week|Month over month|prior 7 days|prior matched month/i);
    expect(markup.match(/user-profile-modal-spend-kpi(?: |")/g)).toHaveLength(5);
    const cardOrder = [
      'Total user spend',
      'Cost / question',
      'Average tokens',
      'Average daily spend',
      'Share of app spend',
    ].map((label) => markup.indexOf(label));
    expect(cardOrder).toEqual([...cardOrder].sort((left, right) => left - right));
    expect(rendered).not.toContain('6.25 DBU');
    for (const banned of [
      'Resource',
      'Amount',
      'Attribution',
      'Serving endpoint',
      'App compute',
      'Data Genie',
      'Dictionary Genie',
      'Unavailable',
      'not an individual invoice',
    ]) {
      expect(rendered).not.toContain(banned);
    }
    expect(markup.indexOf('user-profile-modal-spend')).toBeLessThan(markup.indexOf('What they asked'));
    expect(markup.indexOf('What they asked')).toBeLessThan(markup.indexOf('user-profile-modal-kpi-grid'));
    expect(markup).not.toContain('user-profile-modal-spend-resource');
    expect(new Set(markup.match(/id="[^"]+"/g)).size).toBe(markup.match(/id="[^"]+"/g)?.length);

    const dbuMarkup = render(
      <PersonPanel
        panel={panel()}
        spendState={{ status: 'ready', key: 'spend', requestId: 1, data: cost, error: null }}
        spendUnit="DBU"
        now={NOW}
        rangeLabel="last 7 days"
        onClose={() => {}}
        onOpenQuestion={() => {}}
      />
    );
    const dbu = text(dbuMarkup);
    expect(dbu).toContain('Total user spend Estimated 6.25 DBU');
    expect(dbu).toContain('Cost / question Estimated Question count unavailable');
    expect(dbu).toContain('Average daily spend Estimated Covered days unavailable');
    expect(dbu.match(/Estimated/g)).toHaveLength(5);
    expect(dbu).not.toContain('12.50 USD');

    const noSpend: OpsCostPayload = structuredClone(cost);
    const noSpendProfile = noSpend.spendByUser!.users[0];
    noSpendProfile.total.usd = { amount: null, quality: 'unavailable' };
    const hidden = render(
      <PersonPanel
        panel={panel()}
        spendState={{ status: 'ready', key: 'spend', requestId: 1, data: noSpend, error: null }}
        now={NOW}
        rangeLabel="last 7 days"
        onClose={() => {}}
        onOpenQuestion={() => {}}
      />
    );
    expect(text(hidden)).toContain('Total user spend Estimated Spend not available yet');
    expect(text(hidden).match(/Estimated/g)).toHaveLength(5);
    expect(hidden.indexOf('user-profile-modal-spend"')).toBeLessThan(hidden.indexOf('What they asked'));

    const loading = render(
      <PersonPanel
        panel={panel()}
        spendState={beginPanelLoad<OpsCostPayload>('spend', 1)}
        now={NOW}
        rangeLabel="last 7 days"
        onClose={() => {}}
        onOpenQuestion={() => {}}
      />
    );
    expect(text(loading)).toContain('Loading user spend');
    expect(text(loading).match(/Estimated/g)).toHaveLength(5);
    expect(loading.match(/user-profile-modal-spend-kpi(?: |")/g)).toHaveLength(5);
    expect(loading.match(/ast-flick-slot--inline/g)).toHaveLength(1);
    expect(loading.match(/ast-anim-flick/g)).toHaveLength(4);
    expect(loading).toContain('data-ast-rest');
    expect(loading).not.toContain('lucide-wallet');
    expect(loading).not.toContain('user-profile-modal-spend-loading-icon');
    expect(loading).not.toContain('skeleton');

    for (const rangeLabel of ['last 24 hours', 'last 7 days', 'last 30 days', 'all time']) {
      for (const spendUnit of ['USD', 'DBU'] as const) {
        const variant = text(
          render(
            <PersonPanel
              panel={panel()}
              spendState={{ status: 'ready', key: `${rangeLabel}:${spendUnit}`, requestId: 1, data: cost, error: null }}
              spendUnit={spendUnit}
              now={NOW}
              rangeLabel={rangeLabel}
              onClose={() => {}}
              onOpenQuestion={() => {}}
            />
          )
        );
        expect(variant.match(/Estimated/g), `${rangeLabel} ${spendUnit}`).toHaveLength(5);
      }
    }
  });

  it('upgrades the production KPI shape from known totals and denominators', () => {
    const unavailable = (subtitle: string) => ({ value: null, state: 'unavailable' as const, subtitle });
    const data = {
      currency: 'USD',
      spendByUser: {
        users: [
          {
            email: 'first.person@example.test',
            total: {
              usd: { amount: 9.55, quality: 'partial' },
              dbu: { amount: 4.25, quality: 'partial' },
            },
            metrics: {
              unit: 'USD',
              questions: 25,
              coveredDays: 7,
              costPerQuestion: unavailable('25 submitted questions'),
              averageDaily: unavailable('7 covered days'),
              averageTokens: {
                totalTokens: 253_800,
                coveredRuns: 3,
                coveredQuestions: 2,
                perRun: 84_600,
                perQuestion: 126_900,
              },
              appShare: unavailable('No comparable app total'),
            },
            components: [],
          },
        ],
      },
    } as unknown as OpsCostPayload;
    const markup = render(
      <PersonSpend
        email="first.person@example.test"
        unit="USD"
        state={{ status: 'ready', key: 'production', requestId: 1, data, error: null }}
      />
    );
    const rendered = text(markup);
    expect(rendered).toContain('Total user spend Estimated 9.55 USD');
    expect(rendered).toContain('Cost / question Estimated 0.382 USD 25 submitted questions');
    expect(rendered).toContain('Average daily spend Estimated 1.364 USD 7 covered days');
    expect(rendered).toContain('Average tokens Estimated 84.6K / run 126.9K / question');
    expect(markup).toContain('253,800 tokens across 3 token-covered runs');
    expect(rendered).toContain('Share of app spend Estimated No comparable app total');
    expect(rendered.match(/Estimated/g)).toHaveLength(5);
    expect(rendered).not.toMatch(/No comparable period|Week over week|Month over month/i);
    expect(rendered).not.toContain('–');
  });

  it('keeps the final five-card footprint while a seeded total is being enriched', () => {
    const data = {
      currency: 'USD',
      spendByUser: {
        users: [
          {
            email: 'first.person@example.test',
            total: {
              usd: { amount: 62.61, quality: 'allocated' },
              dbu: { amount: null, quality: 'unavailable' },
            },
            components: [],
          },
        ],
      },
    } as unknown as OpsCostPayload;
    const markup = render(
      <PersonSpend
        email="first.person@example.test"
        unit="USD"
        refreshing
        state={{ status: 'ready', key: 'seeded', requestId: 1, data, error: null }}
      />
    );
    expect(text(markup)).toContain('Total user spend Estimated 62.61 USD');
    expect(text(markup).match(/Estimated/g)).toHaveLength(5);
    for (const label of [
      'Calculating cost per question',
      'Calculating average tokens',
      'Calculating daily spend',
      'Calculating share of app spend',
    ]) {
      expect(text(markup)).toContain(label);
    }
    expect(markup.match(/user-profile-modal-spend-kpi(?: |")/g)).toHaveLength(5);
    expect(markup.match(/ast-flick-slot--inline/g)).toHaveLength(1);
    expect(text(markup)).not.toContain('Refreshing');
    expect(text(markup)).not.toMatch(
      /week over week|month over month|comparable period|prior 7 days|prior matched month/i
    );
  });

  it('shows the authorized current role and only a real assigned persona', () => {
    for (const [role, label] of [
      ['super_admin', 'Super admin'],
      ['admin', 'Admin'],
      ['consumer', 'Consumer'],
    ] as const) {
      const markup = render(
        <PersonPanel
          panel={panel({ role, persona: { id: 'analyst', name: 'Business Analyst' } })}
          now={NOW}
          rangeLabel="last 7 days"
          onClose={() => {}}
          onOpenQuestion={() => {}}
        />
      );
      expect(markup).toContain(`aria-label="Role: ${label}"`);
      expect(markup).toContain('aria-label="Persona: Business Analyst"');
      expect(markup).toContain('title="Business Analyst"');
    }
    for (const persona of [null, { id: 'none', name: 'No persona' }, { id: 'blank', name: '  ' }]) {
      const markup = render(
        <PersonPanel
          panel={panel({ persona })}
          now={NOW}
          rangeLabel="last 7 days"
          onClose={() => {}}
          onOpenQuestion={() => {}}
        />
      );
      expect(markup).not.toContain('user-profile-modal-persona');
      expect(markup).not.toContain('No persona');
    }
  });

  it('mounts person status and retry states before data arrives', () => {
    const loading = render(
      <PersonPanelShell
        state={beginPanelLoad<PersonPanelPayload>('person|reader|from|to|', 1)}
        email="reader@example.test"
        now={NOW}
        rangeLabel="last 7 days"
        page={0}
        onClose={() => {}}
        onOpenQuestion={() => {}}
        onPreviousPage={() => {}}
        onNextPage={() => {}}
        onRetry={() => {}}
        identitySeed={{ role: 'admin', persona: { id: 'analyst', name: 'Business Analyst' } }}
      />
    );
    const failedState = rejectPanelLoad(
      beginPanelLoad<PersonPanelPayload>('person|reader|from|to|', 1),
      'person|reader|from|to|',
      1,
      'Person activity could not be loaded.'
    );
    const failed = render(
      <PersonPanelShell
        state={failedState}
        email="reader@example.test"
        now={NOW}
        rangeLabel="last 7 days"
        page={0}
        onClose={() => {}}
        onOpenQuestion={() => {}}
        onPreviousPage={() => {}}
        onNextPage={() => {}}
        onRetry={() => {}}
      />
    );
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-label="Role: Admin"');
    expect(loading).toContain('aria-label="Persona: Business Analyst"');
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('Person activity could not be loaded. Retry');
  });

  it('renders each ranked source table as a counted governed entity', () => {
    const rows = [
      { table: '<your_catalog>.<your_schema>.gold_title_daily_summary', runs: 20 },
      { table: '<your_catalog>.<your_schema>.data_dictionary', runs: 9 },
    ];
    const markup = render(<TablesReadMost rows={rows} />);
    const rendered = text(markup);

    expect(rendered).toContain('Tables read most');
    expect(rendered).toContain('gold_title_daily_summary 20 runs');
    expect(rendered).toContain('data_dictionary 9 runs');
    expect(markup.match(/data-entity-part="catalog"/g)).toHaveLength(2);
    expect(markup.match(/data-entity-part="schema"/g)).toHaveLength(2);
    expect(markup.match(/data-entity-part="table"/g)).toHaveLength(2);
  });

  it('keeps a long ranked name and its count in one row with the full name available', () => {
    const table =
      'a_very_long_catalog_name.a_very_long_schema_name.a_very_long_table_name_that_needs_controlled_truncation';
    const markup = render(<TablesReadMost rows={[{ table, runs: 12_345 }]} />);
    const row = markup.match(/<li>([\s\S]*?)<\/li>/)?.[1] ?? '';

    expect(row).toContain(`title="${table}"`);
    expect(row).toContain(`aria-label="${table}"`);
    expect(row).toContain('data-entity-part="catalog"');
    expect(row).toContain('data-entity-part="schema"');
    expect(row).toContain('data-entity-part="table"');
    expect(row).toContain('12,345 runs');
    expect(row.indexOf('user-profile-modal-table-name')).toBeLessThan(row.indexOf('user-profile-modal-table-runs'));
  });

  it('keeps the ranked-table section in flow when no run recorded a source', () => {
    expect(text(render(<TablesReadMost rows={[]} />))).toContain(
      'Tables read most No table reads were recorded in this range.'
    );
  });

  it('renders token cost only when the backend supplied a measured figure', () => {
    const measured = render(
      <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
    );
    const unavailable = render(
      <PersonPanel
        panel={panel({ tokenCostUsd: null })}
        now={NOW}
        rangeLabel="last 7 days"
        onClose={() => {}}
        onOpenQuestion={() => {}}
      />
    );

    expect(text(measured)).toContain('Token cost $3.84 at configured rate · USD');
    expect(measured).toContain('user-profile-modal-kpi-grid');
    expect(text(unavailable)).not.toContain('Token cost');
    expect(text(unavailable)).not.toContain('no price configured');
    expect(unavailable).toContain('user-profile-modal-kpi-grid');
  });

  /**
   * The floor rule is not restated under the tiles.
   *
   * It used to print on every range, in force or not. The Answer time tile's own
   * second line already names the slowest run as the slowest run on the ranges
   * where the rule bites, so the caption was the same sentence twice on a quiet
   * range and a rule about nothing on a busy one. This panel is over 41 runs.
   */
  it('does not restate the percentile floor rule under the tiles', () => {
    const rendered = text(
      render(
        <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
      )
    );

    expect(rendered).toContain('at the 95th percentile');
    expect(rendered).not.toContain('is replaced by the slowest run');
    expect(rendered).not.toContain('labeled as such');
  });

  it('says which window its figures and its questions are over', () => {
    // The panel is opened from a list the reader narrowed, and then covers the
    // control that narrowed it. Both sections that count something over the
    // range now name the range, so a figure on this panel is never read as an
    // all-time one.
    const markup = render(
      <PersonPanel panel={panel()} now={NOW} rangeLabel="last 30 days" onClose={() => {}} onOpenQuestion={() => {}} />
    );
    expect(occurrences(text(markup), 'last 30 days')).toBeGreaterThanOrEqual(2);
    // As a qualification beside the heading rather than as part of its name.
    expect(markup).toContain('user-profile-modal-range');
  });

  it('uses the shared identity chip for the person panel too', () => {
    const markup = render(
      <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
    );

    expect(markup).toContain('class="identity-chip"');
    expect(markup).toContain('lucide-user-round');
    expect(markup).not.toContain('>FP<');
  });

  it('keeps refusal detail out of the KPI grid and reports the aggregate once', () => {
    const rendered = text(
      render(
        <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
      )
    );

    expect(rendered).toContain('3 refused');
    expect(rendered).not.toContain('Refused for a missing grant');
    expect(rendered).not.toContain("Refused by the agent's own rules");
  });

  it('does not expose internal refusal codes in the summary layout', () => {
    const markup = render(
      <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
    );

    expect(markup).not.toContain('USER_NOT_AUTHORIZED');
    expect(markup).not.toContain('ASSET_NOT_IN_MANIFEST');
  });

  it('says what a row filter is, not what it did to a run', () => {
    const rendered = text(
      render(
        <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
      )
    );

    expect(rendered).toContain('Row filter applied.');
    expect(rendered).not.toContain('Two people with different group membership');
    // No claim about rows lost, which PIA cannot know.
    expect(rendered).not.toMatch(/rows (were )?(removed|hidden|lost|filtered out)/i);
    expect(rendered).toContain('Column mask on a_column.');
  });

  it('renders every declared table under the selected human identity', () => {
    const tables = Array.from({ length: 12 }, (_value, index) => `catalog.schema.table_${index + 1}`);
    const grants = tables.map((table, index) => ({
      table,
      canRead: index < 6 ? true : null,
      missing: null,
      rowFilter: null,
      maskedColumns: null,
      source: index < 6 ? ('verified-run' as const) : ('no-evidence' as const),
      verifiedRuns: index < 6 ? index + 1 : 0,
      latestVerifiedReadAt: index < 6 ? '2026-09-01T12:00:00Z' : null,
    }));
    const rendered = text(
      render(
        <PersonPanel
          panel={panel({ grants, grantsMode: 'historical' })}
          now={NOW}
          rangeLabel="last 7 days"
          onClose={() => {}}
          onOpenQuestion={() => {}}
        />
      )
    );
    expect(rendered).toContain('Declared tables · verified evidence from this user’s runs');
    expect(rendered.match(/catalog\.schema\.table_/g)).toHaveLength(12);
    expect(rendered.match(/Read in \d+ verified run/g)).toHaveLength(6);
    expect(rendered.match(/No verified read evidence/g)).toHaveLength(6);
    expect(rendered).not.toContain('as the application');
    expect(rendered).not.toContain('SELECT missing');
  });

  it('does not close with a live-versus-recorded lecture', () => {
    expect(
      text(
        render(
          <PersonPanel
            panel={panel()}
            now={NOW}
            rangeLabel="last 7 days"
            onClose={() => {}}
            onOpenQuestion={() => {}}
          />
        )
      )
    ).not.toContain(LIVE_VERSUS_RECORDED);
  });

  /**
   * The permissions section is badges and counts, and carries no prose.
   *
   * It was three paragraphs: which identity executed, whether the token subject
   * could be checked, and what the access gate had checked, each with a clause
   * explaining what it did not mean. The counts are the useful part and they are
   * now on the badges.
   */
  it('states each permission the runs carried as a badge with its run count', () => {
    const rendered = text(
      render(
        <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
      )
    );

    expect(rendered).toContain('Their own Unity Catalog grants 41 runs');
    expect(rendered).toContain('Sign-in verified on the token 39 runs');
    expect(rendered).toContain('Sign-in confirmed by the endpoint 2 runs');
    // The application's grants carried nothing here, so no badge claims they did.
    expect(rendered).not.toContain("The application's grants");
  });

  it('names the application only on a panel whose runs actually used it', () => {
    const shared = panel({ executionSplit: { asThemselves: 30, asApplication: 11, unrecorded: 0 } });
    const rendered = text(
      render(
        <PersonPanel panel={shared} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
      )
    );

    expect(rendered).toContain("The application's grants 11 runs");
    expect(rendered).toContain('Their own Unity Catalog grants 30 runs');
  });

  /**
   * THE SENTENCE WHOSE JOB WAS TO RAISE DOUBT. The prose read "1 did not record
   * which identity ran them", which is the answer footer's deleted "identity is
   * unconfirmed" claim wearing a count. Beside a person's name, on the one page
   * that knows who asked, it reads as a hint that their question was answered as
   * somebody else. The runs that recorded an identity say so; the rest say
   * nothing.
   */
  it('says nothing at all about runs that recorded no identity', () => {
    const some = panel({
      executionSplit: { asThemselves: 40, asApplication: 0, unrecorded: 1 },
      subjectSplit: { verified: 38, confirmedByEndpoint: 2, unrecorded: 1 },
    });
    const rendered = text(
      render(
        <PersonPanel panel={some} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
      )
    );

    expect(rendered).toContain('Their own Unity Catalog grants 40 runs');
    expect(rendered).not.toMatch(/did not record/i);
    expect(rendered).not.toMatch(/identity[^.]{0,40}\bis (?:unconfirmed|unverified|unknown)/i);
  });

  /**
   * The access gate is switched off, so a count of what it checked is a figure
   * about a feature nobody is running.
   */
  it('reports nothing about the access gate', () => {
    const rendered = text(
      render(
        <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
      )
    );

    expect(rendered).not.toMatch(/access gate/i);
    expect(rendered).not.toMatch(/skipped/i);
    expect(rendered).not.toContain('courtesy check');
  });

  /** The two explanations of hypotheticals that went with the prose. */
  it('explains no hypothetical about whose grants bounded an answer', () => {
    const rendered = text(
      render(
        <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
      )
    );

    expect(rendered).not.toContain('is not an answer bounded by what this person can see');
    expect(rendered).not.toContain('Both are ordinary.');
  });

  it('does not render an endpoint-confirmed subject as a problem', () => {
    const markup = render(
      <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
    );

    // Neutral, not the bad tone. Confirmation by the endpoint is ordinary.
    expect(markup).toMatch(/ast-pill--neutral-outline[^>]*>Sign-in confirmed by the endpoint/);
    expect(text(markup)).not.toMatch(/unverified|insecure|weaker/i);
  });

  /**
   * A reading that did not answer is not a denial.
   *
   * The row painted it the red "Cannot read" badge and put "Not checked" in grey
   * beside it: a permissions finding nobody established, contradicted by the
   * words next to it.
   */
  it('badges an unchecked table as not checked rather than as cannot read', () => {
    const unchecked = panel({
      grants: [
        {
          table: 'a_catalog.a_schema.a_table',
          canRead: false,
          missing: 'Not checked',
          rowFilter: null,
          maskedColumns: null,
          source: 'live-user-probe',
          verifiedRuns: 0,
          latestVerifiedReadAt: null,
        },
      ],
    });
    const markup = render(
      <PersonPanel panel={unchecked} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
    );

    expect(text(markup)).toContain('Not checked');
    expect(text(markup)).not.toContain('Cannot read');
    expect(markup).not.toContain('ast-pill--neg');
    // The badge it DOES take, so the assertion above cannot pass on a row that
    // rendered no pill at all.
    expect(markup).toContain('ast-pill--neutral-outline');
    // And the words are not printed twice, once as a badge and once beside it.
    expect(occurrences(text(markup), 'Not checked')).toBe(1);
  });

  /** The full table name is reachable where the line truncates it. */
  it('carries the whole table name on the elements that truncate it', () => {
    const markup = render(
      <PersonPanel panel={panel()} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
    );

    expect(markup).toContain('class="user-profile-modal-grant-table" title="a_catalog.a_schema.a_table"');
    expect(markup).toContain('user-profile-modal-tables');
  });

  it('says the grants could not be read rather than rendering an empty table', () => {
    const rendered = text(
      render(
        <PersonPanel
          panel={panel({ grants: null })}
          now={NOW}
          rangeLabel="last 7 days"
          onClose={() => {}}
          onOpenQuestion={() => {}}
        />
      )
    );

    expect(rendered).toContain('could not be read just now');
    expect(rendered).toContain('This says nothing about what they can reach.');
    expect(rendered).not.toContain('Cannot read');
  });

  it('names the token coverage on the tile', () => {
    expect(
      text(
        render(
          <PersonPanel
            panel={panel()}
            now={NOW}
            rangeLabel="last 7 days"
            onClose={() => {}}
            onOpenQuestion={() => {}}
          />
        )
      )
    ).toContain('over 38 of 41 runs');
  });

  it('replaces the percentile with the labelled slowest run under twenty runs', () => {
    const few = panel({ durationsMs: [3_000, 9_000, 41_000, 84_000] });
    const rendered = text(
      render(
        <PersonPanel panel={few} now={NOW} rangeLabel="last 7 days" onClose={() => {}} onOpenQuestion={() => {}} />
      )
    );

    expect(rendered).toContain('was the slowest run');
    expect(rendered).not.toContain('at the 95th percentile');
  });
});

describe('Monitoring pagination controls', () => {
  it('labels the current page and bounds both directions', () => {
    const markup = render(
      <MonitoringPaginationControls
        pagination={{ pageSize: 50, total: 214, hasMore: true, nextCursor: 'next' }}
        page={0}
        onPrevious={() => {}}
        onNext={() => {}}
      />
    );
    expect(markup).toContain('aria-label="Question pages"');
    expect(text(markup)).toContain('Page 1 · 214 matching questions');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Previous/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Next/);
  });
});

/**
 * The whole page, in the one state a server render can reach, checked for the
 * things that must never be on it.
 */
describe('the page never says the things that were removed from this app', () => {
  const STATES: MonitoringState[] = ['loading', 'empty-range', 'empty-filters', 'unavailable', 'partial', 'ready'];

  it.each(STATES)('%s carries no demo framing and no em dash', (state) => {
    const rendered = text(body(state, state === 'partial' ? { readState: 'partial', countedQuestions: 2000 } : {}));

    for (const banned of ['demo', 'sample data', 'synthetic', 'representative', 'placeholder', 'example data']) {
      expect(rendered.toLowerCase(), banned).not.toContain(banned);
    }
    expect(rendered).not.toContain('\u2014');
  });
});
