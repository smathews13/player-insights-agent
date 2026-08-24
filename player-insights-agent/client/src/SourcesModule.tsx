import { OpenInDatabricks, SourceEntityName } from './DataEntityLinks';
import { KeepInMind } from './KeepInMind';
import { sourceRows } from './source-rows';
import type { Derivation, SourceRef } from './answer-shape';

/**
 * The one place an answer says where it came from and what to watch for.
 *
 * It replaces the old multi-row Sources card with one wrapping provenance
 * sentence, followed by the compact Keep in mind box. The table names remain
 * links and every recorded role/derivation fact remains present; only repeated
 * chrome and repeated sentences are removed.
 *
 * THE ROLE FOLLOWS EACH NAME. That is the fact that differs between sources;
 * repeating a generic governance sentence around every source would bury it.
 *
 * IT TAKES THE WHOLE LIST, and it used to take one source. Both surfaces passed
 * `sources[0]`, so an answer that read four tables named one of them, and the
 * one it named was whichever the run read first -- a dictionary lookup, in the
 * report that started this. Deduplication, ordering and the chip vocabulary are
 * source-rows.ts's; the caveats are KeepInMind.tsx's; this file owns the line.
 */
export function SourcesModule({
  sources,
  caveats,
  derivation = [],
}: {
  sources: readonly SourceRef[];
  /**
   * The answer's caveats, drawn immediately after the provenance line.
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
}) {
  const rows = sourceRows(sources);
  const derived = derivation
    .map((entry) => ({
      key: `${entry.source}-${entry.metric}-${entry.window}-${entry.filter}`,
      facts: [
        { label: 'Metric', value: entry.metric, source: false, tone: 'neutral' },
        { label: 'Window', value: entry.window, source: false, tone: 'neutral' },
        { label: 'Filter', value: entry.filter, source: false, tone: 'neutral' },
        // The table is repeated here only when the run read more than one, which
        // is the one case where "which of these did this figure come from" is a
        // real question. On a single-source answer the row above answers it, and
        // this file's whole argument is that a fact true of every row belongs in
        // one place.
        {
          label: 'Source',
          value: rows.length > 1 ? entry.source : '',
          source: true,
          tone: rows.find((row) => row.name === entry.source)?.tone ?? 'neutral',
        },
      ].filter((fact) => fact.value),
    }))
    .filter((entry) => entry.facts.length > 0);

  if (rows.length === 0 && derived.length === 0 && !caveats.some((caveat) => caveat.trim()))
    return null;
  return (<>
      {(rows.length > 0 || derived.length > 0) ? (
        <section className="sources-module" aria-label="Sources and provenance">
          <p className="source-line">
            <strong className="source-line-label">Sources</strong>{' '}
            {rows.map((row, index) => (<span className="source-line-entry" key={row.name}>
                {index > 0 ? <span aria-hidden="true"> · </span> : null}
                <span
                  className="source-line-name source-name-pill"
                  data-tone={row.tone}
                  title={row.freshness ? `${row.name} · ${row.freshness}` : row.name}
                >
                  <SourceEntityName name={row.name} />
                </span>{' '}
                <span className="source-line-role">({row.chip})</span>{' '}
                <OpenInDatabricks name={row.name} />
              </span>
            ))}
            {derived.map((entry) => (<span className="source-line-derivation" key={entry.key}>
                {' · '}
                {entry.facts.map((fact, index) => (<span className="derivation-fact" key={fact.label}>
                    {index > 0 ? ', ' : null}
                    <span className="derivation-label">{fact.label.toLowerCase()} </span>
                    <code
                      className={`derivation-value${fact.source ? ' derivation-source source-name-pill' : ''}`}
                      data-tone={fact.source ? fact.tone : undefined}
                    >
                      {fact.source ? <SourceEntityName name={fact.value} /> : fact.value}
                    </code>
                  </span>
                ))}
              </span>
            ))}
          </p>
        </section>
      ) : null}
      <KeepInMind caveats={caveats} sources={rows} />
    </>
  );
}
