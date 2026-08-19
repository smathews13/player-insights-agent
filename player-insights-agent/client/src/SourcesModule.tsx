import { BrandIcon } from './BrandIcon';
import { OpenInDatabricks, SourceEntityName } from './DataEntityLinks';
import { KeepInMind } from './KeepInMind';
import { sourceFacts, sourceRows } from './source-rows';
import type { Derivation, SourceRef } from './answer-shape';

/**
 * The one place an answer says where it came from and what to watch for.
 *
 * It replaces three surfaces that were saying overlapping things in different
 * words. The "Queried for the figures" strip and the "All sources" tab under
 * Advanced trace details listed the same tables twice, each with its own "Open
 * in Databricks" link and its own repeat of "Governed Unity Catalog source ·
 * Read during this run" on every row; and the standalone amber "What to keep in
 * mind" box sat below both of them as a third panel in a column of panels,
 * where it went unnoticed for months. One card now: the tables, then the
 * qualifications on the numbers those tables produced.
 *
 * THE FACTS TRUE OF EVERY ROW ARE SAID IN THE HEADER AND NOWHERE ELSE. That the
 * tables are governed, and that this run read them, was previously printed once
 * per row per surface -- up to ten times under one answer -- which is how the
 * one fact that differs between rows, what each table was read FOR, ended up as
 * the least visible thing in the block. It is now the row's only qualifier, as
 * a chip.
 *
 * IT TAKES THE WHOLE LIST, and it used to take one source. Both surfaces passed
 * `sources[0]`, so an answer that read four tables named one of them, and the
 * one it named was whichever the run read first -- a dictionary lookup, in the
 * report that started this. Deduplication, ordering and the chip vocabulary are
 * source-rows.ts's; the caveats are KeepInMind.tsx's; this file owns the card.
 */
export function SourcesModule({
  sources,
  caveats,
  derivation = [],
}: {
  sources: readonly SourceRef[];
  /**
   * The answer's caveats, drawn as the card's footer.
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
  const facts = sourceFacts(rows);
  // What each entry will actually draw, decided before the emptiness check
  // below rather than inside the map, because an entry can arrive with fields
  // this card does not draw -- a source alone, on an answer that read one table,
  // which the row above already names. Deciding it in two places is how a
  // "nothing to draw" entry becomes an empty bordered row: the guard counts it
  // and the map renders no facts from it.
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
  // Nothing to say, so nothing is drawn. An empty bordered card under an answer
  // reads as a list that failed to load, which is the state a reader cannot
  // tell from a run that genuinely cited nothing.
  if (rows.length === 0 && derived.length === 0 && !caveats.some((caveat) => caveat.trim()))
    return null;
  return (<section className="sources-module">
      <div className="sources-module-head">
        {/* Unity Catalog's own mark, not a lucide database, and the recoloured
            cut rather than the published one: this header is white, so the mark
            takes the blue-light cut like every other product mark on a white
            surface. 18px is the detail spec's size for this one seating, above
            the 16px a row takes, because it heads a card rather than labelling a
            line in one. Decorative: "Sources" is right beside it. */}
        <BrandIcon product="unity-catalog" size={18} />
        <strong>Sources</strong>
        {/* The count, and nothing else. Omitted entirely for an answer that
            declared none, rather than printed as "0 tables". See sourceFacts for
            what this line used to say and why it stopped. */}
        {facts && <span className="sources-module-facts">{facts}</span>}
      </div>
      {rows.map((row) => (<div className="sources-row" data-tone={row.tone} key={row.name}>
          {/* One line, ellipsised, with the whole name in the tooltip: a
              three-part Unity Catalog name is longer than the column at most
              widths, and wrapping it put half an identifier on a line of its
              own. The freshness the server stated goes in the same tooltip
              rather than on the row -- see the header comment on why per-row
              text is spent only on the chip. */}
          <span
            className="sources-row-name source-name-pill"
            data-tone={row.tone}
            title={row.freshness ? `${row.name} · ${row.freshness}` : row.name}
          >
            <SourceEntityName name={row.name} />
          </span>
          {/* Exactly one chip. Never two: a row wearing "Queried for the
              figures" and "Definition validation" at once is a row a reader
              cannot answer their own question from, and the stronger claim
              already wins in source-rows.ts.

              The app's one pill recipe, in the family the row's role picks: info
              for a table the figures came from, neutral for one read only for
              its definitions. `ast-pill` carries the geometry and the tone class
              carries the two colours, so this chip cannot drift from the ones in
              the trace or on the Connections rows. */}
          <span className={`ast-pill sources-chip ast-pill--${row.tone === 'queried' ? 'info' : 'neutral'}`} title={row.note}>
            {row.chip}
          </span>
          {/* The object itself, in the workspace, beside the name rather than
              on it: the name goes to this app's own entry for the table, which
              works in every deployment, and this control is drawn only where a
              host and a three-level name are both known. Nothing is rendered
              when they are not. See DataEntityLinks.tsx. */}
          <OpenInDatabricks name={row.name} />
          {/* NOTHING HERE LABELS THE DATA AS SYNTHETIC OR AS DEMO CONTENT, and
              nothing should be added that does. A chip reading "Synthetic data"
              used to sit at the end of this row, decided in the browser from
              the wording of the answer's caveats. Two problems, and the second
              is the one that removed it. It was a claim about a named Unity
              Catalog table made by a surface that cannot see inside it: the app
              runs against whatever catalog the operator configured, so the chip
              was a guess printed as a fact next to a real table name. And where
              a deployment genuinely has something to disclose about its data,
              the answer's own caveats say so, in the agent's words, in the
              footer below -- so the chip was at best that disclosure repeated
              in a shorter and less careful form. Recorded as D1 in
              bundle/DECISIONS.md. */}
        </div>
      ))}
      {/* What each statement measured, under the tables it measured it from.
          Labelled facts and nothing else: the value is bold because it is the
          thing being read, and the label is small because it is the same word on
          every answer. No sentence explains the block, and none should — the
          agent derives these from the parse of the query that ran, and a
          paragraph around them would be the one part of it nothing checked. */}
      {derived.map((entry, index) => (<div className="sources-derivation" key={`${entry.key}-${index}`}>
          {entry.facts.map((fact) => (<span className="derivation-fact" key={fact.label}>
              <strong className="derivation-label">{fact.label}</strong>
              {/* The name goes through the same component the row above uses, so
                  the table is a link to this app's entry for it here too, and
                  the qualifier recesses the same way. */}
              <code
                className={`derivation-value${fact.source ? ' derivation-source source-name-pill' : ''}`}
                data-tone={fact.source ? fact.tone : undefined}
              >
                {fact.source ? <SourceEntityName name={fact.value} /> : fact.value}
              </code>
            </span>
          ))}
        </div>
      ))}
      <KeepInMind caveats={caveats} sources={rows} />
    </section>
  );
}
