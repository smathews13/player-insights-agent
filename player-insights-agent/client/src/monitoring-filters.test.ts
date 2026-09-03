import { describe, expect, it } from 'vitest';

import {
  applyFilters,
  backToUserBrowser,
  chipsActive,
  clearedFilters,
  closedDrawer,
  closedFeedbackBrowser,
  closedUserMonitoring,
  drawerFromParams,
  feedbackBrowserFromParams,
  filtersActive,
  filtersFromParams,
  NO_FILTERS,
  onlyDrawerChanged,
  openFeedbackBrowser,
  openPerson,
  openQuestion,
  openUserBrowser,
  openUserFromBrowser,
  scrollMemory,
  withFilters,
  withUserBrowserFilters,
  userBrowserFromParams,
} from './monitoring-filters';
import type { MonitoringQuestion } from '../../shared/monitoring-contract';

/**
 * The filter set as it lives in the URL, and the promise closing the drawer
 * makes: the reader gets back their filters and their place.
 */

const params = (search: string) => new URLSearchParams(search);

describe('feedback browser navigation state', () => {
  it('opens over the current filters and closes without disturbing them', () => {
    const opened = openFeedbackBrowser('range=30d&person=coach%40example.com');
    expect(feedbackBrowserFromParams(params(opened))).toBe(true);
    expect(opened).toContain('range=30d');
    expect(opened).toContain('person=coach%40example.com');
    expect(closedFeedbackBrowser(`${opened}&question=q1`)).toBe('range=30d&person=coach%40example.com');
  });

  it('keeps the browser marker behind question and user detail links for Back', () => {
    const feedback = openFeedbackBrowser('range=7d');
    expect(openQuestion(feedback, 'q1')).toContain('feedbacks=1');
    expect(openPerson(feedback, 'coach@example.com')).toContain('feedbacks=1');
  });
});

function question(overrides: Partial<MonitoringQuestion> = {}): MonitoringQuestion {
  return {
    id: 'q1',
    conversationId: 'c1',
    question: 'A question.',
    askedBy: 'first.person@example.test',
    askedAt: '2026-08-15T10:00:00Z',
    outcome: 'completed',
    outcomeDetail: null,
    durationMs: 1000,
    toolCalls: 1,
    totalTokens: 120,
    feedback: null,
    tables: ['a_catalog.a_schema.a_table'],
    ...overrides,
  };
}

describe('the filters live in the URL', () => {
  it('reads every filter back out of a search string', () => {
    const filters = filtersFromParams(
      params('person=first.person@example.test&outcome=refused&feedback=down&table=a.b.c&q=spending')
    );

    expect(filters).toEqual({
      person: 'first.person@example.test',
      outcome: 'refused',
      feedback: 'down',
      table: 'a.b.c',
      search: 'spending',
    });
    expect(filtersActive(filters)).toBe(true);
  });

  it('reports no filters on a bare URL', () => {
    expect(filtersFromParams(params(''))).toEqual(NO_FILTERS);
    expect(filtersActive(NO_FILTERS)).toBe(false);
  });

  /**
   * These values reach a chip label. An `outcome=banana` that survived would
   * render a filter for something that does not exist and show an empty list with
   * no explanation.
   */
  it('drops a value it does not recognise rather than passing it through', () => {
    const filters = filtersFromParams(params('outcome=banana&feedback=sideways'));

    expect(filters.outcome).toBe('');
    expect(filters.feedback).toBe('');
  });

  /**
   * Including the search text, which is a filter like the others: sending the
   * link has to send the typed word too, or the recipient opens a view that is
   * not the one that was shared.
   */
  it('round trips through the writer', () => {
    const filters = {
      person: 'a@b.test',
      outcome: 'failed',
      feedback: 'up',
      table: 'a.b.c',
      search: 'net bookings',
    } as const;
    const search = withFilters('', filters);

    expect(search).toContain('q=net+bookings');
    expect(filtersFromParams(params(search))).toEqual(filters);
  });

  /**
   * THE CONTRACT WITH THE SHARED RANGE CONTROL. A filter change may not disturb
   * anything it does not own, which includes the preset range and an open drawer.
   */
  it('leaves every parameter it does not own untouched', () => {
    const before = 'range=30d&question=q9&other=keep';
    const after = params(withFilters(before, { ...NO_FILTERS, outcome: 'refused' }));

    expect(after.get('range')).toBe('30d');
    expect(after.get('question')).toBe('q9');
    expect(after.get('other')).toBe('keep');
    expect(after.get('outcome')).toBe('refused');
  });

  it('clears the filter row and only the filter row', () => {
    const before = 'range=30d&person=a@b.test&outcome=failed&question=q9';
    const after = params(clearedFilters(before));

    expect(after.get('person')).toBeNull();
    expect(after.get('outcome')).toBeNull();
    // The range survives clearing a filter. Clearing filters is not resetting
    // the window somebody chose.
    expect(after.get('range')).toBe('30d');
    expect(after.get('question')).toBe('q9');
  });
});

describe('the User Monitoring modal lives in the URL', () => {
  it('deep-links the browser with its selected cost unit and preserves the period', () => {
    const opened = params(openUserBrowser('range=30d&outcome=failed', 'DBU'));
    expect(opened.get('users')).toBe('1');
    expect(opened.get('userUnit')).toBe('DBU');
    expect(opened.get('range')).toBe('30d');
    expect(opened.get('outcome')).toBe('failed');
    expect(userBrowserFromParams(opened)).toMatchObject({ open: true, unit: 'DBU' });
  });

  it('moves browser to profile and back without losing search, role, persona, organization, unit, or cursor', () => {
    const browser =
      'users=1&userSearch=ada&userRole=admin&userPersona=analyst&userOrganization=2k%2Cnorthwind-games&userUnit=USD&userCursor=next';
    const profile = params(openUserFromBrowser(browser, 'ada@example.test'));
    expect(profile.get('who')).toBe('ada@example.test');
    const returned = params(backToUserBrowser(profile.toString()));
    expect(returned.get('who')).toBeNull();
    expect(returned.get('userSearch')).toBe('ada');
    expect(returned.get('userRole')).toBe('admin');
    expect(returned.get('userPersona')).toBe('analyst');
    expect(returned.get('userOrganization')).toBe('2k,northwind-games');
    expect(returned.get('userCursor')).toBe('next');
    expect(userBrowserFromParams(returned).persona).toBe('analyst');
    expect(userBrowserFromParams(returned).organizations).toEqual(['2k', 'northwind-games']);
  });

  it('round-trips organization multiselect filters and clears stale cursors', () => {
    const written = params(
      withUserBrowserFilters('users=1&range=7d&userCursor=stale', {
        search: 'sam',
        role: 'admin',
        persona: 'analyst',
        organizations: ['acme-interactive', '2k'],
        unit: 'DBU',
      })
    );
    expect(userBrowserFromParams(written)).toMatchObject({
      search: 'sam',
      role: 'admin',
      persona: 'analyst',
      organizations: ['acme-interactive', '2k'],
      unit: 'DBU',
    });
    expect(written.get('userCursor')).toBeNull();
    expect(written.get('range')).toBe('7d');
  });

  it('closes the whole modal without clearing Monitoring filters or period', () => {
    const closed = params(
      closedUserMonitoring(
        'range=24h&outcome=partial&users=1&who=a%40b.test&userPersona=analyst&userOrganization=2k&userUnit=DBU'
      )
    );
    expect(closed.get('users')).toBeNull();
    expect(closed.get('who')).toBeNull();
    expect(closed.get('userUnit')).toBeNull();
    expect(closed.get('userPersona')).toBeNull();
    expect(closed.get('userOrganization')).toBeNull();
    expect(closed.get('range')).toBe('24h');
    expect(closed.get('outcome')).toBe('partial');
  });
});

/**
 * Removing a filter, one at a time and all at once.
 *
 * Every clear in the row goes through `withFilters` or `clearedFilters`, so these
 * are the assertions that a cleared view is what a shared link reproduces: the
 * parameter has to leave the URL, not be set to an empty value. A `person=` left
 * behind is a link that carries a filter nobody can see.
 */
describe('clearing a filter round-trips through the URL', () => {
  const everything =
    'range=30d&person=a@b.test&outcome=failed&feedback=down&table=cat.sch.tbl&q=refund&question=q9&other=keep';

  /** Each one on its own, which is what a chip's ✕ and its All option both do. */
  it('removes each filter individually and leaves the others alone', () => {
    const set = filtersFromParams(params(everything));

    for (const [key, blank] of [
      ['person', ''],
      ['outcome', ''],
      ['feedback', ''],
      ['table', ''],
      ['search', ''],
    ] as const) {
      const cleared = params(withFilters(everything, { ...set, [key]: blank }));
      // The parameter is gone, not present and empty.
      expect(cleared.get(key === 'search' ? 'q' : key)).toBeNull();
      // And nothing else moved, including the window and the open drawer.
      expect(cleared.get('range')).toBe('30d');
      expect(cleared.get('question')).toBe('q9');
      expect(cleared.get('other')).toBe('keep');
      // Exactly one filter left, so clearing one cannot clear another.
      const still = filtersFromParams(cleared);
      expect(Object.entries(still).filter(([, value]) => value !== '')).toHaveLength(4);
    }
  });

  /** And all five at once, which is what the row's Clear filters button does. */
  it('removes all five at once without touching the window or the drawer', () => {
    const after = params(clearedFilters(everything));

    expect(filtersFromParams(after)).toEqual(NO_FILTERS);
    for (const name of ['person', 'outcome', 'feedback', 'table', 'q']) {
      expect(after.get(name)).toBeNull();
    }
    expect(after.get('range')).toBe('30d');
    expect(after.get('question')).toBe('q9');
    expect(after.get('other')).toBe('keep');
  });

  /**
   * Emptying the search restores the full list, which is the claim behind the
   * clear button in the field. Asserted against `applyFilters` rather than
   * inferred from the URL, because "the parameter is gone" and "the rows came
   * back" are two different promises.
   */
  it('brings every row back when the search is emptied', () => {
    const rows = [
      question({ id: 'a', question: 'how many refunds' }),
      question({ id: 'b', question: 'what is the retention curve' }),
    ];

    expect(applyFilters(rows, { ...NO_FILTERS, search: 'refund' }).map((row) => row.id)).toEqual(['a']);
    expect(applyFilters(rows, { ...NO_FILTERS, search: '' }).map((row) => row.id)).toEqual(['a', 'b']);
  });

  /**
   * Clearing the row does not clear the period, and there is no filter parameter
   * that could. The period lives in `range`, which this module does not own and
   * `clearedFilters` therefore cannot reach.
   */
  it('cannot remove the period, because the period is not one of its filters', () => {
    const after = params(clearedFilters('range=30d&person=a@b.test'));

    expect(after.get('range')).toBe('30d');
    expect(after.get('person')).toBeNull();
  });
});

describe('the filters combine with AND', () => {
  const rows = [
    question({ id: 'a', outcome: 'completed', feedback: 'up', askedBy: 'one@example.test' }),
    question({ id: 'b', outcome: 'refused', feedback: null, askedBy: 'one@example.test' }),
    question({ id: 'c', outcome: 'failed', feedback: 'down', askedBy: 'two@example.test', tables: ['x.y.z'] }),
  ];

  it('narrows on each filter and on all of them together', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, outcome: 'refused' }).map((row) => row.id)).toEqual(['b']);
    expect(applyFilters(rows, { ...NO_FILTERS, person: 'ONE@EXAMPLE.TEST' }).map((row) => row.id)).toEqual(['a', 'b']);
    expect(applyFilters(rows, { ...NO_FILTERS, table: 'x.y.z' }).map((row) => row.id)).toEqual(['c']);
    expect(
      applyFilters(rows, { ...NO_FILTERS, person: 'one@example.test', outcome: 'completed' }).map((r) => r.id)
    ).toEqual(['a']);
  });

  /** "Show me what has no feedback" is different from "show me all". */
  it('treats No feedback as a filter rather than as the absence of one', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, feedback: 'none' }).map((row) => row.id)).toEqual(['b']);
    expect(applyFilters(rows, NO_FILTERS)).toHaveLength(3);
  });
});

describe('the search box is a filter like the others', () => {
  const rows = [
    question({ id: 'a', question: 'Compare net bookings by title', askedBy: 'ada.reader@example.test' }),
    question({ id: 'b', question: 'Weekly active players', askedBy: 'ada.reader@example.test' }),
    question({ id: 'c', question: 'Net bookings last quarter', askedBy: 'bo.other@example.test' }),
  ];

  it('matches the question text, ignoring case', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, search: 'NET BOOKINGS' }).map((row) => row.id)).toEqual(['a', 'c']);
  });

  /**
   * The list shows the local part, so typing what is on screen has to work. The
   * whole address has to work too, because that is what gets pasted in.
   */
  it('matches the person by what is on screen and by the whole address', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, search: 'ada.reader' }).map((row) => row.id)).toEqual(['a', 'b']);
    expect(applyFilters(rows, { ...NO_FILTERS, search: 'bo.other@example.test' }).map((row) => row.id)).toEqual(['c']);
  });

  /** Combined with the chips by AND, like every other filter. */
  it('narrows further rather than replacing the other filters', () => {
    const both = { ...NO_FILTERS, search: 'net bookings', person: 'ada.reader@example.test' };

    expect(applyFilters(rows, both).map((row) => row.id)).toEqual(['a']);
  });

  /**
   * Deliberately not the table names. The Table chip already matches those
   * exactly, from the list the range actually read, and a free-text match over
   * them as well would let a row match for a reason the reader cannot see.
   */
  it('does not match on table names, which have their own filter', () => {
    const withTable = [question({ id: 'd', question: 'Anything', tables: ['a_catalog.a_schema.a_table'] })];

    expect(applyFilters(withTable, { ...NO_FILTERS, search: 'a_schema' })).toHaveLength(0);
    expect(applyFilters(withTable, { ...NO_FILTERS, table: 'a_catalog.a_schema.a_table' })).toHaveLength(1);
  });

  /** Which of the two is narrowing, so the empty state can name the right one. */
  it('reports the chips separately from the search', () => {
    expect(chipsActive({ ...NO_FILTERS, search: 'anything' })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: 'anything' })).toBe(true);
    expect(chipsActive({ ...NO_FILTERS, outcome: 'failed' })).toBe(true);
  });
});

describe('closing the drawer restores the filters and the place', () => {
  it('opens on a question without disturbing the filters or the range', () => {
    const before = 'range=30d&person=a@b.test&outcome=failed';
    const after = params(openQuestion(before, 'q7'));

    expect(after.get('question')).toBe('q7');
    expect(after.get('person')).toBe('a@b.test');
    expect(after.get('outcome')).toBe('failed');
    expect(after.get('range')).toBe('30d');
  });

  /**
   * THE PROMISE THE DESIGN MAKES. Closing is removing two parameters and copying
   * the rest, so it cannot drop a filter: it never enumerates them.
   */
  it('returns exactly the search string the drawer was opened from', () => {
    const before = 'range=30d&person=a@b.test&outcome=failed&rating=up&table=a.b.c';
    const opened = openQuestion(before, 'q7');

    expect(params(closedDrawer(opened)).toString()).toBe(params(before).toString());
  });

  it('restores the filters when the person panel is closed as well', () => {
    const before = 'range=24h&table=a.b.c';
    const opened = openPerson(before, 'a@b.test');

    expect(params(opened).get('who')).toBe('a@b.test');
    expect(params(closedDrawer(opened)).toString()).toBe(params(before).toString());
  });

  it('swaps one drawer for the other rather than opening both', () => {
    const both = params(openPerson(openQuestion('', 'q7'), 'a@b.test'));

    expect(both.get('who')).toBe('a@b.test');
    expect(both.get('question')).toBeNull();
    expect(drawerFromParams(both)).toEqual({ question: '', person: 'a@b.test' });
  });

  /**
   * Opening a drawer is not a reason to re-read the range. Without this the page
   * ran a scan of every message in the range on every click.
   */
  it('knows a drawer change from a range or filter change', () => {
    expect(onlyDrawerChanged('range=7d', 'range=7d&question=q7')).toBe(true);
    expect(onlyDrawerChanged('range=7d&question=q7', 'range=7d&who=a@b.test')).toBe(true);
    expect(onlyDrawerChanged('range=7d', 'range=30d')).toBe(false);
    expect(onlyDrawerChanged('range=7d', 'range=7d&outcome=failed')).toBe(false);
  });

  it('gives back the scroll offset the drawer was opened at, once', () => {
    const memory = scrollMemory();
    memory.capture(842);

    expect(memory.take()).toBe(842);
    // Taken, so a second close does not scroll the reader somewhere they were
    // three drawers ago.
    expect(memory.take()).toBeNull();
  });

  /**
   * The capture is on open only. A second capture while the drawer is open would
   * record the drawer's own scroll position and return the reader to that.
   */
  it('keeps the first offset when something captures again mid-drawer', () => {
    const memory = scrollMemory();
    memory.capture(842);
    memory.capture(0);

    expect(memory.take()).toBe(842);
  });

  it('reports nothing when the drawer was never opened', () => {
    expect(scrollMemory().take()).toBeNull();
  });
});
