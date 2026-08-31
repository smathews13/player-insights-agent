import { OpenInDatabricks, SourceEntityName } from './DataEntityLinks';
import { KeepInMind } from './KeepInMind';
import { sourceRows } from './source-rows';
import type { SourceTone } from './source-rows';
import type { Derivation, SourceRef } from './answer-shape';

/**
 * The one place an answer says where it came from and what to watch for.
 *
 * Sources is a vertical list, one leftover table per bullet, matching Keep in
 * mind's `answer-list` (same blue dots, gap, and type). Filter, metric and
 * window sit inside that source's bullet so they cannot collapse into a wrapping
 * sentence of middle-dot separators.
 *
 * THE ROLE FOLLOWS EACH NAME. That is the fact that differs between sources;
 * repeating a generic governance sentence around every source would bury it.
 *
 * IT TAKES THE WHOLE LIST, and it used to take one source. Both surfaces passed
 * `sources[0]`, so an answer that read four tables named one of them, and the
 * one it named was whichever the run read first -- a dictionary lookup, in the
 * report that started this. Deduplication, ordering and the chip vocabulary are
 * source-rows.ts's; the caveats are KeepInMind.tsx's; this file owns the list.
 */

type DerivationFact = {
  label: string;
  value: string;
  source: boolean;
  tone: SourceTone;
};

type DerivedEntry = {
  key: string;
  source: string;
  facts: DerivationFact[];
};

function sourceKey(name: string): string {
  return name.trim().toLowerCase();
}

function SourceFreshness({ freshness }: { freshness: string }) {
  if (!freshness.trim()) return null;
  return (
    <>
      <span className="source-list-separator" aria-hidden="true">
        {' '}
        ·{' '}
      </span>
      <span className="source-list-freshness provenance-detail" tabIndex={0} aria-label={`Freshness: ${freshness}`}>
        {freshness}
      </span>
    </>
  );
}

function DerivationFacts({ facts }: { facts: readonly DerivationFact[] }) {
  const shown = facts.filter((fact) => fact.value);
  if (shown.length === 0) return null;
  return (
    <ul className="answer-list source-list-derivation">
      {shown.map((fact) => (
        <li className="derivation-fact" key={fact.label}>
          <span className="derivation-label">{fact.label} </span>
          <code
            className={`derivation-value${fact.source ? ' derivation-source source-name-pill' : ''}`}
            data-tone={fact.source ? fact.tone : undefined}
          >
            {fact.source ? <SourceEntityName name={fact.value} /> : fact.value}
          </code>
        </li>
      ))}
    </ul>
  );
}

export function SourcesModule({
  sources,
  caveats,
  derivation = [],
  hideWorkspaceLinks = [],
}: {
  sources: readonly SourceRef[];
  /**
   * The answer's caveats, drawn immediately after the provenance list.
   *
   * Passed in rather than fetched, because Ask PIA lifts a degradation out into
   * a banner above the figures and hands this only the rest, while the Run
   * Explorer has no banner to lift one into and passes everything.
   */
  caveats: readonly string[];
  /**
   * What each statement measured, over what window, with what filter.
   *
   * Defaulted to empty rather than required, because two of the three callers
   * genuinely have none: an answer from a model version logged before the agent
   * derived it, and a run reopened from a row written then. Empty draws nothing.
   */
  derivation?: readonly Derivation[];
  /**
   * Source names that already carry an Open-in-workspace control on a table or
   * chart header. Those drop out of this leftover list so the same table is not
   * named twice; Keep in mind still sees the full list, so a caveat can tag it.
   */
  hideWorkspaceLinks?: readonly string[];
}) {
  const hidden = new Set(hideWorkspaceLinks.map((name) => name.trim().toLowerCase()));
  const workspaceLink = (name: string) =>
    hidden.has(name.trim().toLowerCase()) ? null : <OpenInDatabricks name={name} />;
  const rows = sourceRows(sources);
  const derived: DerivedEntry[] = derivation
    .map((entry) => ({
      key: `${entry.source}-${entry.metric}-${entry.window}-${entry.filter}`,
      source: entry.source,
      facts: [
        { label: 'Metric', value: entry.metric, source: false, tone: 'neutral' as const },
        { label: 'Window', value: entry.window, source: false, tone: 'neutral' as const },
        { label: 'Filter', value: entry.filter, source: false, tone: 'neutral' as const },
        // The table is repeated here only when the run read more than one, which
        // is the one case where "which of these did this figure come from" is a
        // real question. Nested under a leftover bullet the name is already on
        // the row, so the leftover map strips this fact; unmatched bullets keep
        // it so a header-linked table's filter is still attributed.
        {
          label: 'Source',
          value: rows.length > 1 ? entry.source : '',
          source: true,
          tone: rows.find((row) => row.name === entry.source)?.tone ?? 'neutral',
        },
      ].filter((fact) => fact.value),
    }))
    .filter((entry) => entry.facts.length > 0);
  const leftover = rows.filter((row) => {
    const key = sourceKey(row.name);
    if (!hidden.has(key)) return true;
    // A table already named on a chart or table header drops out of this list
    // unless derivation still has something to say about it — filter, metric,
    // window — so those facts have a named bullet instead of an unlabeled one.
    return derived.some((entry) => sourceKey(entry.source) === key);
  });
  const leftoverKeys = new Set(leftover.map((row) => sourceKey(row.name)));
  const unmatched = derived.filter((entry) => !leftoverKeys.has(sourceKey(entry.source)));

  if (rows.length === 0 && derived.length === 0 && !caveats.some((caveat) => caveat.trim())) return null;
  const provenance =
    leftover.length > 0 || unmatched.length > 0 ? (
      <section className="sources-module" aria-label="Sources and provenance">
        <p className="source-list-heading">Sources</p>
        <ul className="answer-list source-list">
          {leftover.map((row) => (
            <li className="source-list-row" key={row.name}>
              <span className="source-list-name source-name-pill" data-tone={row.tone} title={row.name}>
                <SourceEntityName name={row.name} />
              </span>
              <SourceFreshness freshness={row.freshness} />{' '}
              {/* The chip names the role; the title says what the role MEANS for
                  the numbers on screen -- "Its data is not in the numbers shown"
                  is the distinction a reader is actually checking, and the
                  three-word chip cannot carry it. It had a line of its own on the
                  old Sources card and lost its seating when the card became one
                  compact line; source-rows.ts never stopped stating it. */}
              <span className="source-list-role" title={row.note}>
                ({row.chip})
              </span>{' '}
              {workspaceLink(row.name)}
              {derived
                .filter((entry) => sourceKey(entry.source) === sourceKey(row.name))
                .map((entry) => (
                  <DerivationFacts key={entry.key} facts={entry.facts.filter((fact) => !fact.source)} />
                ))}
            </li>
          ))}
          {unmatched.map((entry) => {
            const rest = entry.facts.filter((fact) => !fact.source);
            const row = rows.find((item) => sourceKey(item.name) === sourceKey(entry.source));
            const name = entry.source.trim();
            return (
              <li className="source-list-row" key={entry.key}>
                {name ? (
                  <>
                    <span className="source-list-name source-name-pill" data-tone={row?.tone ?? 'neutral'} title={name}>
                      <SourceEntityName name={name} />
                    </span>
                    {row ? <SourceFreshness freshness={row.freshness} /> : null}
                    {row ? (
                      <>
                        {' '}
                        <span className="source-list-role" title={row.note}>
                          ({row.chip})
                        </span>
                      </>
                    ) : null}
                  </>
                ) : null}
                <DerivationFacts facts={rest} />
              </li>
            );
          })}
        </ul>
      </section>
    ) : null;
  return (
    <>
      {provenance}
      <KeepInMind caveats={caveats} sources={rows} />
    </>
  );
}
