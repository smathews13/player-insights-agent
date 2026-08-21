/**
 * A recorded step result, drawn as the shape it is.
 *
 * The Rendered view in Run Explorer used to be one reading for everything:
 * paragraphs, or a table when every line happened to be a consistent grid. So a
 * Genie result -- which carries the space that answered, how it read the
 * question, the rows, and a sentence about them -- arrived as a single paragraph
 * beginning "Asking Genie space Player Insights Data
 * (d00dfeedd00dfeedd00dfeedd00dfeed). Query
 * interpretation: You want to see…", and a semantic search arrived as a
 * five-thousand-character dash-run of column names.
 *
 * THE RENDERER IS CHOSEN BY THE TOOL, not sniffed out of the text. `data_genie`
 * and `dictionary_genie` write Genie's four parts, `search_semantics` writes
 * table blocks, an agent step writes Markdown; those are facts about the agent
 * rather than guesses about a string, and a heuristic would eventually promote a
 * result that merely looked like one of them.
 *
 * EVERY PATH DEGRADES, and that is the property to keep. Each parse in
 * `step-results.ts` returns null when it cannot find its shape, and every null
 * lands on rendered Markdown -- real bold, mono, lists -- which is still a
 * reading of the text rather than the text. Raw is one click away and byte-exact
 * either way, which is what makes attempting a reading safe at all.
 *
 * There is no `dangerouslySetInnerHTML` in this file and no node shape that could
 * carry one, for the reason `answer-markdown.ts` spells out: this is model
 * output, and the tree it parses into has no branch that holds markup.
 */
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { BrandIcon } from './BrandIcon';
import { parseAnswerMarkdown, type Block, type Inline } from './answer-markdown';
import {
  chipRuns,
  collapsedName,
  fieldDefinition,
  genieResult,
  semanticResult,
  truncatedId,
  type Fact,
  type ResultShape,
  type FieldDefinition,
  type GenieResult,
  type ReportSection,
  type ResultTable,
  type SemanticEntry,
  type SemanticResult,
} from './step-results';

/**
 * How many columns of a matched table show before the rest go behind a count.
 *
 * The point of an opened row is telling whether this is the table you want, which
 * the first few columns answer. A forty-column dictionary table opened flat is
 * the wall of names this view was built to replace.
 */
const COLUMN_PREVIEW = 5;

/**
 * A table or column name, in the mono chip every identifier in the app takes.
 *
 * Carries its own name in `title` because the chip truncates: a name cut at the
 * width of its row has to stay recoverable without leaving the panel.
 */
export function EntityName({ children }: { children: string }) {
  const parts = children.split('.');
  if (parts.length === 3 && parts.every(Boolean)) {
    return (<code className="dag-entity-name" title={children}>
        <span className="dag-entity-catalog">{parts[0]}</span>
        <span aria-hidden="true">.</span>
        <span className="dag-entity-schema">{parts[1]}</span>
        <span aria-hidden="true">.</span>
        <span className="dag-entity-table">{parts[2]}</span>
      </code>
    );
  }
  return (<code className="dag-name-chip" title={children}>{children}</code>);
}

function Name({ children }: { children: string }) {
  // Chips are labels, not containers. A whole sentence or pasted result wrapped
  // in backticks must remain readable code instead of becoming one blue slab.
  if (children.length > 72 || /\s/.test(children)) {
    return <code className="dag-inline-code">{children}</code>;
  }
  return <EntityName>{children}</EntityName>;
}

/** A sentence with the table and column names in it set as chips. */
export function ChipText({ text }: { text: string }) {
  return (<>
      {chipRuns(text).map((run) =>
        run.chip ? <Name key={run.start}>{run.text}</Name> : <span key={run.start}>{run.text}</span>
      )}
    </>
  );
}

/**
 * The inline half of a step's Markdown.
 *
 * The same tree the answer card renders, parsed by the same module, with two
 * differences that belong to this surface. A code span is a NAME chip rather than
 * the answer's code fill, because in a trace every backticked run is a table or a
 * column. And nothing links: a step panel is the record of what one call did, and
 * a link out of it would claim the step named an entity the app tracks when all
 * the step did was mention a word.
 */
function InlineRuns({ nodes }: { nodes: readonly Inline[] }) {
  return (<>
      {nodes.map((node) => {
        switch (node.kind) {
          case 'text':
            // The text itself rather than a span round it: a wrapper on every run
            // of prose is a span per sentence in the panel, and it is not carrying
            // anything -- the runs exist so a tracked entity can be linked, and
            // nothing links here.
            return node.runs.map((run) => run.text).join('');
          case 'code':
            return <Name key={node.start}>{node.runs.map((run) => run.text).join('')}</Name>;
          case 'strong':
            return (<strong key={node.start}>
                <InlineRuns nodes={node.children} />
              </strong>
            );
          case 'link':
            // Drawn as its text and not as a link. A step panel is the record of
            // what one call did; a link out of it would offer navigation the step
            // never performed.
            return <InlineRuns key={node.start} nodes={node.children} />;
          case 'break':
            return <br key={node.start} />;
        }
      })}
    </>
  );
}

function MarkdownBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return (<strong className="dag-md-head">
          <InlineRuns nodes={block.children} />
        </strong>
      );
    case 'list':
      return block.ordered ? (<ol className="dag-md-list">
          {block.items.map((item) => (<li key={item.start}>
              <InlineRuns nodes={item.children} />
            </li>
          ))}
        </ol>
      ) : (<ul className="dag-md-list">
          {block.items.map((item) => (<li key={item.start}>
              <InlineRuns nodes={item.children} />
            </li>
          ))}
        </ul>
      );
    case 'table':
      // Drawn from the same parsed block as the Ask transcript. Run Explorer
      // previously cut header-and-separator tables out first and sent their raw
      // strings to ResultGrid, while every other Markdown block came through
      // this shared parser. That second parser was a separate answer to the same
      // question and dropped inline Markdown inside cells. Keeping every table
      // here means a stored answer and its live transcript cannot disagree about
      // whether backticks, bold totals, or the table itself are markup.
      //
      // Scrolls inside the panel; see `.answer-table-wrap` in answer.css.
      return (<div className="answer-table-wrap">
          <table className="answer-table">
            {block.header ? (<thead>
                <tr>
                  {block.header.cells.map((cell, column) => (<th key={cell.start} scope="col" data-align={block.align[column]} data-wrap={block.wrap[column]}>
                      <InlineRuns nodes={cell.children} />
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {block.rows.map((row) => (<tr key={row.start}>
                  {row.cells.map((cell, column) => (<td key={cell.start} data-align={block.align[column]} data-wrap={block.wrap[column]}>
                      <InlineRuns nodes={cell.children} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rule':
      return <hr className="dag-md-rule" />;
    case 'code':
      return (<pre className="dag-md-code">
          <code data-language={block.language || undefined}>{block.text}</code>
        </pre>
      );
    case 'paragraph':
      return (<p>
          <InlineRuns nodes={block.children} />
        </p>
      );
  }
}

/** Markdown, where every shape that would not parse lands. */
export function MarkdownText({ text }: { text: string }) {
  return (<div className="dag-md">
      {parseAnswerMarkdown(text).map((block) => <MarkdownBlock block={block} key={block.start} />)}
    </div>
  );
}

/**
 * A Genie result set as a grid, one column wide or twelve.
 *
 * A single name over a single value is still drawn as a table, which is the
 * design's instruction and the commonest result this agent gets: written as prose
 * it is the one figure the reader opened the step to check, sitting in the middle
 * of a sentence.
 */
/**
 * A cell that is a figure rather than a word.
 *
 * The design sets the numerals bold, and this is why: the reader opened the step
 * to check one number, and in a grid of governed text it is the only cell they
 * are looking for. Deliberately narrow -- a date or an id made of digits is not a
 * measurement and does not get the emphasis.
 */
const FIGURE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?%?$/;

function ResultGrid({ table }: { table: ResultTable }) {
  return (<div className="dag-grid">
      <table>
        <thead>
          <tr>
            {table.head.map((cell, at) => (<th key={table.head.slice(0, at + 1).join('|')} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (<tr key={row.join('|')}>
              {row.map((cell, cellAt) => (<td key={row.slice(0, cellAt + 1).join('|')}>{
                  FIGURE.test(cell.trim()) ? <b>{cell}</b>
                    : cell.split('.').length === 3 ? <EntityName>{cell}</EntityName>
                      : cell
                }</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {/* Kept whatever it says. A trailing line the grid could not hold is the
          sample or truncation notice -- "(showing the first 100 rows)" -- and a
          result presented without it reads as the whole population. */}
      {table.note && <p className="dag-grid-note">{table.note}</p>}
    </div>
  );
}

/**
 * One dictionary field, as a definition rather than as a one-row grid.
 *
 * The guardrail is an amber chip because that is the app's evaluation family and
 * a governance rule is the thing on this card a reader must not skim past. Its
 * clauses are joined in the order the ROW gave them: reordering governance text
 * to read better is rewriting it, and this renderer does not rewrite what the
 * dictionary says.
 */
function DefinitionCard({ definition }: { definition: FieldDefinition }) {
  return (<div className="dag-definition">
      <p className="dag-definition-head">
        <Name>{definition.column}</Name>
        {definition.table && (<>
            <span className="dag-definition-in">in</span>
            <span className="dag-definition-table" title={definition.table}>
              {definition.table}
            </span>
          </>
        )}
        {/* The one pill recipe, in the warning family. It used to declare its own
            size, weight, radius, padding, fill, edge and text colour, and the
            three it named were DuBois' amber: #93320B on #FFF9EB, which is an
            orange, and there is no orange in this palette. */}
        {definition.guardrail && (<span className="ast-pill ast-pill--warn dag-guardrail">{definition.guardrail}</span>
        )}
      </p>
      <p className="dag-definition-body">{definition.definition}</p>
      {definition.verdict && (<div className="dag-definition-verdict">
          <MarkdownText text={definition.verdict} />
        </div>
      )}
    </div>
  );
}

/**
 * A Genie result as its parts, in a label grid of its own.
 *
 * The space that answered is NOT repeated here: in this seating it sits in the
 * Result row's header beside the Rendered | Raw control, which is where the
 * design puts the source identity. So these are the three things that header
 * cannot hold, and the middle one is labelled "Returned" rather than "Result" --
 * a row called Result inside a row called Result leaves the reader asking which.
 *
 * A dictionary lookup that returned ONE row of the dictionary is a definition and
 * is drawn as one. One that returned five rows is not: the card states a single
 * field, and taking the first of five would put one row's guardrail on an answer
 * about five.
 */
export function GenieCard({ result }: { result: GenieResult }) {
  const definition = fieldDefinition(result);
  if (definition) return <DefinitionCard definition={definition} />;
  return (<dl className="dag-shape">
      {result.understood && (<>
          <dt>Understood as</dt>
          <dd>
            <ChipText text={result.understood} />
          </dd>
        </>
      )}
      {result.table && (<>
          <dt>Returned</dt>
          <dd>
            <ResultGrid table={result.table} />
          </dd>
        </>
      )}
      {result.answer && (<>
          <dt>Answer</dt>
          <dd>
            <MarkdownText text={result.answer} />
          </dd>
        </>
      )}
    </dl>
  );
}

/** One matched table, shut unless the reader opens it or it is the first. */
function SemanticRow({ entry, open }: { entry: SemanticEntry; open: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const [allColumns, setAllColumns] = useState(false);
  const { lead, object } = collapsedName(entry.name);
  const shown = allColumns ? entry.columns : entry.columns.slice(0, COLUMN_PREVIEW);
  const rest = entry.columns.length - shown.length;
  return (<div className={`dag-table-row ${expanded ? 'open' : ''}`}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        <ChevronRight aria-hidden="true" />
        {/* The catalog and schema are dimmed rather than dropped. Every table in
            one run shares them, so they are the part of a three-part name that
            carries no information -- and they are also the part a reader needs
            when a result spans two schemas, which is why the full name stays in
            the title. */}
        <span className="dag-table-name" title={entry.name}>
          {lead && <span className="dag-table-lead">{lead}.</span>}
          <span className="dag-table-object">{object}</span>
        </span>
        {/* Outlined neutral, which is the recipe the detail spec names for this
            chip and also the one the shared pill offers for a chip that has to sit
            on a tinted surface: the row washes on hover, and a neutral tint on
            that wash reads as a rendering fault. */}
        {entry.certification && (<span className="ast-pill ast-pill--neutral-outline dag-cert">{entry.certification}</span>
        )}
        {/* Mono. This is a right-aligned meta count, which is one of the four
            placements the numeral rule names, and the reader compares it down the
            column of rows rather than reading it in a sentence. The stylesheet
            asked DM Sans for tabular figures instead, and DM Sans declares no
            `tnum` feature, so the counts never lined up. */}
        <span className="ast-num dag-col-count">
          {entry.columns.length} column{entry.columns.length === 1 ? '' : 's'}
        </span>
      </button>
      {expanded && (<div className="dag-table-body">
          {entry.description && <p className="dag-table-about">{entry.description}</p>}
          {entry.columns.length > 0 && (<p className="dag-col-chips">
              {shown.map((column) => (<span className="dag-col-chip" key={column.name}>
                  <code>{column.name}</code>
                  {column.type && <span>{column.type}</span>}
                </span>
              ))}
              {rest > 0 && (<button type="button" className="dag-col-more" onClick={() => setAllColumns(true)}>
                  {rest} more
                </button>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What a semantic search matched, as rows rather than as its own preamble.
 *
 * The SEMANTIC SEARCH RESULTS notice is an instruction to the MODEL -- identical
 * on every call, and telling the reader that definitions are not data -- so it is
 * compressed into the phrase beside the count in the Result row's header. What
 * the tool said it LEFT OUT is kept as a line of its own: that is a measurement
 * of this search rather than boilerplate.
 */
export function SemanticCard({ result }: { result: SemanticResult }) {
  return (<div className="dag-tables">
      {result.entries.map((entry, at) => (<SemanticRow entry={entry} key={entry.name} open={at === 0} />
      ))}
      {result.note && <p className="dag-tables-note">{result.note}</p>}
    </div>
  );
}

/** The `- **Label:** value` pairs an agent step writes, as the rows they were. */
function FactGrid({ facts }: { facts: Fact[] }) {
  return (<dl className="dag-shape dag-facts">
      {facts.map((fact) => (<div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>
            <MarkdownText text={fact.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * An agent step's Markdown, as the three things it actually contains.
 *
 * The findings step writes a sentence, a run of inline label/value pairs, and a
 * closing "Note:". All three used to render inside one paragraph, so the pairs
 * were a wall of asterisks and the note -- the one part that qualifies the figure
 * above it -- read as more of the same sentence.
 */
export function AgentReport({ sections }: { sections: ReportSection[] }) {
  return (<div className="dag-report">
      {sections.map((section) => {
        const key = section.kind === 'facts' ? `facts-${JSON.stringify(section.facts)}` : `${section.kind}-${section.text}`;
        if (section.kind === 'facts') return <FactGrid facts={section.facts} key={key} />;
        if (section.kind === 'note') {
          return (<div className="dag-note" key={key}>
              <span className="dag-note-tag">Note</span>
              <div>
                <MarkdownText text={section.text} />
              </div>
            </div>
          );
        }
        return <MarkdownText key={key} text={section.text} />;
      })}
    </div>
  );
}

/**
 * What a result names as its source, for the Result row's own header.
 *
 * Read from the same parse the body is drawn from, so the header cannot name a
 * space the body did not come from, and null whenever that parse failed -- a
 * result that fell back to Markdown gets no identity rather than an identity
 * over text that was not read.
 */
export function ResultSource({ shape, text }: { shape: ResultShape; text: string }) {
  if (shape === 'genie') {
    const space = genieResult(text)?.space;
    if (!space) return null;
    return (<span className="dag-source">
        {/* Genie's own mark for either space. `brand-icons.ts` files a TOOL under
            the product that executes it, which for `data_genie` is Databricks
            SQL; this line is naming the space that answered, and the space is
            Genie. */}
        <BrandIcon product="genie" size={14} />
        {space.name && <strong title={space.name}>{space.name}</strong>}
        {space.id && (<code className="dag-space-id" title={space.id}>
            {truncatedId(space.id)}
          </code>
        )}
      </span>
    );
  }
  if (shape === 'semantic') {
    const result = semanticResult(text);
    if (!result) return null;
    return (<span className="dag-source">
        <BrandIcon product="mosaic-ai" size={14} />
        <strong>
          {result.entries.length} {result.kind}
          {result.entries.length === 1 ? '' : 's'} matched
        </strong>
        <span className="dag-source-aside">definitions, not data</span>
      </span>
    );
  }
  return null;
}
