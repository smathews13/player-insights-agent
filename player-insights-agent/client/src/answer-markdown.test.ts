import { describe, expect, it } from 'vitest';
import { answerBlocks, answerInline, parseAnswerMarkdown, safeHref, type Block, type Inline } from './answer-markdown';
import { stylesheet } from './styles/stylesheet';

/**
 * The agent writes Markdown; this is what the app is allowed to make of it.
 *
 * Asserted against the tree rather than against rendered DOM, because this repo
 * has no browser and will not start one. That is a real limit and worth stating:
 * these tests prove the parser produces a heading node, a code node and no node
 * that could carry markup. They do not prove the heading is the size it should
 * be on screen. The stylesheet block at the end of this file is the same trade,
 * and the same caveat applies to it.
 */

const CATALOG = '<your_catalog>.<your_schema>';
const DAILY = `${CATALOG}.gold_title_daily_summary`;
const TRACKED = [DAILY, `${CATALOG}.silver_purchases`];

/**
 * Every inline node a block holds, whatever shape the block is.
 *
 * The helpers below all needed this once tables arrived: a table's inline nodes
 * are two levels down, in the cells of its rows, and every one of these
 * functions used to reach straight for `block.children`.
 */
function blockInlines(block: Block): Inline[][] {
  if (block.kind === 'list') return block.items.map((item) => item.children);
  if (block.kind === 'table') {
    const rows = block.header ? [block.header, ...block.rows] : block.rows;
    return rows.flatMap((row) => row.cells.map((cell) => cell.children));
  }
  if (block.kind === 'rule' || block.kind === 'code') return [];
  return [block.children];
}

/** Every node kind in the tree, in order, blocks included. */
function kinds(blocks: readonly Block[]): string[] {
  const inline = (nodes: readonly Inline[]): string[] =>
    nodes.flatMap((node) =>
      node.kind === 'strong' || node.kind === 'link' ? [node.kind, ...inline(node.children)] : [node.kind]
    );
  return blocks.flatMap((block) => [block.kind, ...blockInlines(block).flatMap(inline)]);
}

/** The text a reader would see, with a newline wherever the tree breaks the line. */
function visible(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text' || node.kind === 'code') return node.runs.map((run) => run.text).join('');
      if (node.kind === 'strong' || node.kind === 'link') return visible(node.children);
      return '\n';
    })
    .join('');
}

function blockText(blocks: readonly Block[]): string {
  return blocks.map((block) => blockInlines(block).map(visible).join('\n')).join('\n');
}

/** The linked runs anywhere in the tree, as `[text, entity]`. */
function links(blocks: readonly Block[]): [string, string][] {
  const inline = (nodes: readonly Inline[]): [string, string][] =>
    nodes.flatMap((node) => {
      if (node.kind === 'text' || node.kind === 'code') {
        return node.runs.filter((run) => run.entity).map((run) => [run.text, run.entity!] as [string, string]);
      }
      if (node.kind === 'strong' || node.kind === 'link') return inline(node.children);
      return [];
    });
  return blocks.flatMap((block) => blockInlines(block).flatMap(inline));
}

/** Every href the tree would put in the DOM. */
function hrefs(blocks: readonly Block[]): string[] {
  const inline = (nodes: readonly Inline[]): string[] =>
    nodes.flatMap((node) => {
      if (node.kind === 'link') return [node.href, ...inline(node.children)];
      if (node.kind === 'strong') return inline(node.children);
      return [];
    });
  return blocks.flatMap((block) => blockInlines(block).flatMap(inline));
}

describe('the blocks the agent actually writes', () => {
  it('makes a heading out of a heading', () => {
    // The exact line from the orchestrator's notebook output, which the app
    // used to print with its hashes on.
    const blocks = parseAnswerMarkdown('## DATA PACKAGE');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('heading');
    expect(blocks[0].kind === 'heading' && blocks[0].level).toBe(2);
    expect(visible(blocks[0].kind === 'heading' ? blocks[0].children : [])).toBe('DATA PACKAGE');
  });

  it('gives a planning stage H2 and its steps H3, which is the customer’s convention', () => {
    const blocks = parseAnswerMarkdown('## Stages\n\n### Step one\n\n### Step two');
    expect(blocks.map((block) => block.kind === 'heading' && block.level)).toEqual([2, 3, 3]);
  });

  it('clamps every heading into those two levels', () => {
    // The card's own heading is the takeaway. Nothing inside it may be a title,
    // and an H6 that reads smaller than the prose around it is not a heading.
    const levels = parseAnswerMarkdown('# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six').map((block) =>
      block.kind === 'heading' ? block.level : null
    );
    expect(levels).toEqual([2, 2, 3, 3, 3]);
  });

  it('reads a bulleted lead-in, bold and all', () => {
    // `- **Interpretation:**` is the other line the notebook emits.
    const blocks = parseAnswerMarkdown('- **Interpretation:** bookings rose.\n- Refunds are netted.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind === 'list' && blocks[0].ordered).toBe(false);
    expect(blocks[0].kind === 'list' && blocks[0].items).toHaveLength(2);
    expect(kinds(blocks)).toEqual(['list', 'strong', 'text', 'text', 'text']);
    expect(blockText(blocks)).toBe('Interpretation: bookings rose.\nRefunds are netted.');
  });

  it('reads a numbered list, and does not merge it with a bulleted one', () => {
    const blocks = parseAnswerMarkdown('- a\n- b\n1. one\n2) two');
    expect(blocks.map((block) => block.kind === 'list' && block.ordered)).toEqual([false, true]);
    expect(blocks.map((block) => (block.kind === 'list' ? block.items.length : 0))).toEqual([2, 2]);
  });

  it('keeps the newlines the agent wrote, which is the collapse this fixes', () => {
    // `white-space` is not `pre-wrap` on the narrative, so a line break in the
    // source used to vanish. It is a break node now, and a blank line is a
    // second paragraph.
    const blocks = parseAnswerMarkdown('One line.\nSecond line.\n\nNew paragraph.');
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph']);
    expect(kinds(blocks)).toEqual(['paragraph', 'text', 'break', 'text', 'paragraph', 'text']);
  });

  it('reads bold and a code span inside a sentence', () => {
    const blocks = parseAnswerMarkdown('Net bookings rose **18%** against `net_bookings_usd`.');
    expect(kinds(blocks)).toEqual(['paragraph', 'text', 'strong', 'text', 'text', 'code', 'text']);
    expect(blockText(blocks)).toBe('Net bookings rose 18% against net_bookings_usd.');
  });

  it('leaves an unmatched delimiter as the character it is', () => {
    // A lone backtick or asterisk is prose, not a broken construct, and eating
    // the rest of the answer looking for a partner is the classic way to lose
    // half a paragraph.
    for (const source of ['A 5**star rating.', 'The ` character.', 'See [the note about it.']) {
      const blocks = parseAnswerMarkdown(source);
      expect(kinds(blocks), source).toEqual(['paragraph', 'text']);
      expect(blockText(blocks), source).toBe(source);
    }
  });

  it('does not treat an underscore as emphasis, because every table name has one', () => {
    // The reason this parser has no `_` rule at all. Underscore emphasis would
    // cut `gold_title_daily_summary` into `gold`, an italic run, and `summary`,
    // and no fragment of that matches a tracked table any more.
    const blocks = answerBlocks('Read gold_title_daily_summary for it.', [DAILY], TRACKED);
    expect(kinds(blocks)).toEqual(['paragraph', 'text']);
    expect(links(blocks)).toEqual([['gold_title_daily_summary', DAILY]]);
  });

  it('gives siblings distinct keys, so React can reconcile them', () => {
    // The tracked table list lands one render after the prose, so every tree is
    // built twice and the keys have to be a property of the node.
    const source = '## Stages\n\n- **one** and `two`\n- three\n\nA line.\nAnother line.';
    const starts = (nodes: readonly Inline[]): void => {
      expect(new Set(nodes.map((node) => node.start)).size).toBe(nodes.length);
      for (const node of nodes) if (node.kind === 'strong' || node.kind === 'link') starts(node.children);
    };
    const blocks = answerBlocks(source, [DAILY], TRACKED);
    expect(new Set(blocks.map((block) => block.start)).size).toBe(blocks.length);
    for (const block of blocks) {
      if (block.kind === 'list') {
        expect(new Set(block.items.map((item) => item.start)).size).toBe(block.items.length);
      }
      for (const nodes of blockInlines(block)) starts(nodes);
    }
  });
});

/**
 * The tables the agent writes, which the app used to print as pipes.
 *
 * Every source below is the agent's own, off the answer this was reported from:
 * a daily aggregate with a bolded total row, a country breakdown, and the stray
 * single row the answer left after its table. They are kept verbatim, em dash
 * included, because the one thing a table renderer must not do is edit the cell
 * it was given.
 */
describe('the tables the agent writes', () => {
  const RAMP = [
    '| Date | Sessions | Active Players | Launch Campaign Sessions | Avg Session (min) | Net Bookings (USD) |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 2026-07-14 | 118 | 96 | 0 | 31.40 | $214.55 |',
    '| 2026-08-03 | 482 | 371 | 8 | 45.15 | $1,381.16 |',
    '| **Total** | **3,914** | **2,880** | **41** | **38.62** | **$9,204.73** |',
  ].join('\n');

  const COUNTRIES = [
    '| Country | Sessions | Active Players |',
    '| --- | --- | --- |',
    '| GB | 482 | 371 |',
    '| DE (Germany \u2014 country level) | 96 | 74 |',
    '| FR | 61 | 48 |',
    '| ES | 44 | 35 |',
  ].join('\n');

  /** One table's cells as text, header first when it has one. */
  function grid(block: Block): string[][] {
    if (block.kind !== 'table') return [];
    const rows = block.header ? [block.header, ...block.rows] : block.rows;
    return rows.map((row) => row.cells.map((cell) => visible(cell.children)));
  }

  function firstTable(source: string): Block {
    const table = parseAnswerMarkdown(source).find((block) => block.kind === 'table');
    if (!table) throw new Error('no table in that source');
    return table;
  }

  it('reads a six-column aggregate as one table with a header and three rows', () => {
    const table = firstTable(RAMP);
    expect(table.kind === 'table' && table.header?.cells).toHaveLength(6);
    expect(table.kind === 'table' && table.rows).toHaveLength(3);
    expect(grid(table)[0]).toEqual([
      'Date',
      'Sessions',
      'Active Players',
      'Launch Campaign Sessions',
      'Avg Session (min)',
      'Net Bookings (USD)',
    ]);
  });

  it('keeps not one character of a cell, currency and thousands separator included', () => {
    // The parser is allowed to read the pipes and nothing else. A renderer that
    // reformats `$1,381.16` is a renderer that can disagree with the figure the
    // agent computed.
    expect(grid(firstTable(RAMP))[2]).toEqual(['2026-08-03', '482', '371', '8', '45.15', '$1,381.16']);
  });

  it('reads the bolded total row as bold, and still as a row', () => {
    const table = firstTable(RAMP);
    // The last row is the total and the agent bolds every cell of it. It has to
    // stay in the table -- a total promoted out of the body loses the columns
    // that make it a total.
    expect(grid(table)[3]).toEqual(['Total', '3,914', '2,880', '41', '38.62', '$9,204.73']);
    const last = table.kind === 'table' ? table.rows[2] : undefined;
    expect(last?.cells.every((cell) => cell.children.some((node) => node.kind === 'strong'))).toBe(true);
  });

  it('right-aligns the figures and leaves the date and the country alone', () => {
    // The delimiter row the agent writes is plain dashes: it states the columns
    // and says nothing about alignment. So the alignment comes from the figures,
    // and a date is deliberately not a figure -- see NUMERIC_CELL.
    expect(firstTable(RAMP).kind === 'table' && (firstTable(RAMP) as { align: string[] }).align).toEqual([
      'left',
      'right',
      'right',
      'right',
      'right',
      'right',
    ]);
    expect((firstTable(COUNTRIES) as { align: string[] }).align).toEqual(['left', 'right', 'right']);
  });

  it('says which columns hold single values and which hold sentences', () => {
    // What a renderer needs in order not to break `2026-07-14` across four
    // lines: a table cannot work out from a width whether a column holds dates
    // or descriptions, so the parser states it per column, as it does alignment.
    expect((firstTable(RAMP) as { wrap: string[] }).wrap).toEqual([
      'atomic',
      'atomic',
      'atomic',
      'atomic',
      'atomic',
      'atomic',
    ]);
    // The country column carries "DE (Germany — country level)", which is a
    // sentence in a cell and has to keep wrapping.
    expect((firstTable(COUNTRIES) as { wrap: string[] }).wrap).toEqual(['prose', 'atomic', 'atomic']);
  });

  it('honours a delimiter row that does state its alignment', () => {
    const table = firstTable('| A | B | C |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |');
    expect((table as { align: string[] }).align).toEqual(['left', 'center', 'right']);
  });

  it('leaves the country cells exactly as written, em dash and parentheses and all', () => {
    // Germany is reported at country level and the agent says so in the cell.
    // Nothing here is the place to reword that, and the em dash is one character
    // in a cell rather than a delimiter of anything.
    expect(grid(firstTable(COUNTRIES))).toEqual([
      ['Country', 'Sessions', 'Active Players'],
      ['GB', '482', '371'],
      ['DE (Germany \u2014 country level)', '96', '74'],
      ['FR', '61', '48'],
      ['ES', '44', '35'],
    ]);
  });

  it('reads the stray single row the answer leaves after its table', () => {
    // Reported as its own defect, and it is a table with no header rather than
    // no table: six figures in six columns, which a reader can read, against six
    // figures in pipes, which they cannot.
    const table = firstTable('| 2026-08-03 | 482 | 371 | 8 | 45.15 | $1,381.16 |');
    expect(table.kind === 'table' && table.header).toBeUndefined();
    expect(grid(table)).toEqual([['2026-08-03', '482', '371', '8', '45.15', '$1,381.16']]);
  });

  it('reads a table the agent fenced, which is the other way the pipes leak out', () => {
    const blocks = parseAnswerMarkdown('Totals below.\n\n```\n' + RAMP + '\n```');
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'table']);
    expect(grid(blocks[1])[0][0]).toBe('Date');
    // And with an info string on the fence, which is what a model writes when it
    // has been told the field is Markdown.
    expect(parseAnswerMarkdown('```markdown\n' + COUNTRIES + '\n```').map((block) => block.kind)).toEqual(['table']);
  });

  it('opens a table on the line after a sentence, with no blank line between', () => {
    // The agent introduces its tables in a sentence and does not always leave a
    // blank line. The paragraph used to swallow every row of the table under it.
    const blocks = parseAnswerMarkdown('Peak day by country (2026-08-03)\n' + COUNTRIES);
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'table']);
    expect(grid(blocks[1])).toHaveLength(5);
  });

  it('reads a heading, a table, and the bullets after it as three separate blocks', () => {
    // The reported answer's actual shape. The bullets beside the table are prose
    // and stay prose: not everything with a number in it is a table.
    const source =
      '### Spike ramp \u2014 aggregated daily totals, 2026-07-14 \u2192 2026-08-03\n\n' +
      RAMP +
      '\n\n- Launch-campaign phase begins 2026-07-28.\n- Sessions peak on the final day.';
    const blocks = parseAnswerMarkdown(source);
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'table', 'list']);
    expect(blocks[2].kind === 'list' && blocks[2].items).toHaveLength(2);
  });

  it('does not make a table out of a sentence that happens to hold a pipe', () => {
    // The guard on the whole feature. `GB | DE | FR` in a sentence is a
    // separator the agent used in prose, and a rule that reads any pipe as a
    // column boundary takes the sentence away from the reader with no way back.
    const blocks = parseAnswerMarkdown('Sessions concentrate in GB | DE | FR, in that order.');
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph']);
    expect(blockText(blocks)).toBe('Sessions concentrate in GB | DE | FR, in that order.');
  });

  it('keeps a fenced SQL statement as code, because its pipe is not a table', () => {
    const source = '```sql\nSELECT CASE WHEN a THEN 1 END, x || y FROM t\n```';
    const blocks = parseAnswerMarkdown(source);
    expect(blocks).toEqual([{
      kind: 'code',
      start: 0,
      language: 'sql',
      text: 'SELECT CASE WHEN a THEN 1 END, x || y FROM t',
    }]);
  });

  it('renders the separator in a data package as a thematic break', () => {
    expect(parseAnswerMarkdown('## DATA PACKAGE\n\n---\n\n**Interpretation:** ready').map((block) => block.kind))
      .toEqual(['heading', 'rule', 'paragraph']);
  });

  it('is not a table when the pipes are nothing but a delimiter row', () => {
    const blocks = parseAnswerMarkdown('| --- | --- |');
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph']);
  });

  it('gives every cell a distinct key, so React can reconcile the table', () => {
    // Same constraint as the prose tree: the answer is segmented once without the
    // tracked table list and again with it, so a key has to be a property of the
    // node rather than its index.
    const table = firstTable(RAMP);
    const cells = table.kind === 'table' ? [...(table.header?.cells ?? []), ...table.rows.flatMap((row) => row.cells)] : [];
    expect(new Set(cells.map((cell) => cell.start)).size).toBe(cells.length);
    const rows = table.kind === 'table' ? table.rows : [];
    expect(new Set(rows.map((row) => row.start)).size).toBe(rows.length);
  });

  it('links a tracked table named in a cell, and nothing else in the table', () => {
    // A cell is linked on the answer's two rules, the same as a sentence: the
    // answer cited the table and Connections tracks it. A country is neither.
    const source = `| Source | Rows |\n| --- | --- |\n| ${DAILY} | 3,914 |\n| GB | 482 |`;
    expect(links(answerBlocks(source, [DAILY], TRACKED))).toEqual([[DAILY, DAILY]]);
  });

  it('reads a Genie ASCII grid that never wore outer pipes', () => {
    const ascii = [
      'platform | total_distinct_players | avg_sessions',
      'PC | 18402 | 12.4',
      'PlayStation 5 | 15110 | 11.1',
      'Xbox Series X|S | 9804 | 10.8',
    ].join('\n');
    const table = firstTable(ascii);
    expect(table.kind).toBe('table');
    expect(table.kind === 'table' && table.header).toBeTruthy();
    expect(grid(table)).toEqual([
      ['platform', 'total_distinct_players', 'avg_sessions'],
      ['PC', '18402', '12.4'],
      ['PlayStation 5', '15110', '11.1'],
      ['Xbox Series X|S', '9804', '10.8'],
    ]);
  });

  it('still will not make a table out of one sentence that holds pipes', () => {
    const blocks = parseAnswerMarkdown('Sessions concentrate in GB | DE | FR, in that order.');
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph']);
  });

  it('drops a data_genie dump from the prose and still finds the table after it', () => {
    const source = [
      'data_genie({"question": "For the title \\"Iron Frontier Reckoning 2\\", distinct players by platform"})',
      '',
      'PC led on distinct players.',
      '',
      'platform | total_distinct_players | avg_sessions',
      'PC | 18402 | 12.4',
      'PlayStation 5 | 15110 | 11.1',
    ].join('\n');
    const blocks = answerBlocks(source, [], []);
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'table']);
    expect(blockText([blocks[0]])).toBe('PC led on distinct players.');
    expect(blockText([blocks[0]])).not.toContain('data_genie');
  });
});

describe('entity links survive the tree', () => {
  /**
   * The constraint that made this worth doing carefully. Linkification used to
   * run over one flat string. Over a tree it runs over the text inside the
   * tree, and a table named inside a heading or a bold run has to keep linking.
   */
  it('links a table named in a heading', () => {
    expect(links(answerBlocks('## gold_title_daily_summary', [DAILY], TRACKED))).toEqual([
      ['gold_title_daily_summary', DAILY],
    ]);
  });

  it('links a table named in bold', () => {
    const blocks = answerBlocks('Source: **gold_title_daily_summary** this quarter.', [DAILY], TRACKED);
    expect(kinds(blocks)).toEqual(['paragraph', 'text', 'strong', 'text', 'text']);
    expect(links(blocks)).toEqual([['gold_title_daily_summary', DAILY]]);
  });

  it('links a table named in a list item', () => {
    expect(links(answerBlocks('- From gold_title_daily_summary.', [DAILY], TRACKED))).toEqual([
      ['gold_title_daily_summary', DAILY],
    ]);
  });

  /**
   * The deliberate call. The customer's house style puts field and table names
   * in backticks, so refusing to link inside a code span would mean adopting
   * their own convention switched this feature off. The usual worry about
   * injecting a link where it does not belong does not apply: a run only links
   * when the answer declared that table AND the Connections page has a row for it.
   */
  it('links a table inside a code span, because that is where the customer puts them', () => {
    const blocks = answerBlocks('Read from `gold_title_daily_summary` today.', [DAILY], TRACKED);
    expect(kinds(blocks)).toEqual(['paragraph', 'text', 'code', 'text']);
    expect(links(blocks)).toEqual([['gold_title_daily_summary', DAILY]]);
  });

  it('links a fully-qualified name inside a code span as one whole link', () => {
    expect(links(answerBlocks(`Read \`${DAILY}\`.`, [DAILY], TRACKED))).toEqual([[DAILY, DAILY]]);
  });

  it('does not link a column name in a code span, the same as anywhere else', () => {
    // The rules in data-entities.ts still decide. Backticks change where we
    // look, not what qualifies.
    expect(links(answerBlocks('The column `net_bookings_usd` is net.', [DAILY], TRACKED))).toEqual([]);
    expect(links(answerBlocks('`gold_title_daily_summary.net_bookings_usd` is net.', [DAILY], TRACKED))).toEqual([]);
  });

  it('does not link inside a link the agent wrote, because an anchor cannot nest', () => {
    const blocks = answerBlocks('[gold_title_daily_summary](https://example.com/doc)', [DAILY], TRACKED);
    expect(kinds(blocks)).toEqual(['paragraph', 'link', 'text']);
    expect(links(blocks)).toEqual([]);
    expect(blockText(blocks)).toBe('gold_title_daily_summary');
  });

  it('links nothing when the answer declared nothing, and still renders the Markdown', () => {
    const blocks = answerBlocks('## Stages\n\n- `gold_title_daily_summary` was not declared.', [], TRACKED);
    expect(links(blocks)).toEqual([]);
    expect(kinds(blocks)).toEqual(['heading', 'text', 'list', 'code', 'text']);
  });

  it('never rewrites a word of the answer', () => {
    // Segments are slices, and the tree only ever drops delimiters. Whatever
    // the agent wrote about the data is what the reader reads.
    const source = `**Interpretation:** ${DAILY} nets refunds into \`net_bookings_usd\`.`;
    expect(blockText(answerBlocks(source, [DAILY], TRACKED))).toBe(
      `Interpretation: ${DAILY} nets refunds into net_bookings_usd.`
    );
  });
});

describe('the answer is untrusted, and the tree cannot carry markup', () => {
  /**
   * There is no HTML string anywhere in this path, so there is nothing to
   * sanitise. A `<script>` has no node to become except a text run, and React
   * escapes text runs. These tests pin the absence.
   */
  const MARKUP = '<script>alert(1)</script> and <img src=x onerror="alert(2)">';

  it('keeps a script tag as the characters it is', () => {
    const blocks = answerBlocks(MARKUP, [DAILY], TRACKED);
    expect(kinds(blocks)).toEqual(['paragraph', 'text']);
    expect(blockText(blocks)).toBe(MARKUP);
  });

  it('keeps it as text inside bold, a heading and a code span too', () => {
    for (const source of [`**${MARKUP}**`, `## ${MARKUP}`, `\`${MARKUP}\``, `- ${MARKUP}`]) {
      const blocks = answerBlocks(source, [DAILY], TRACKED);
      expect(blockText(blocks), source).toBe(MARKUP);
      expect(new Set(kinds(blocks)).has('link'), source).toBe(false);
    }
  });

  it('produces no node kind outside the eight this renderer knows', () => {
    // The structural half of the argument: the renderer switches exhaustively
    // over these, and none of its branches takes a string of markup.
    const allowed = new Set(['paragraph', 'heading', 'list', 'text', 'code', 'strong', 'link', 'break']);
    const source = `## H\n\n${MARKUP}\n\n- **b** \`c\` [d](https://e.test)\n\n1. one`;
    for (const kind of kinds(answerBlocks(source, [DAILY], TRACKED))) expect(allowed.has(kind), kind).toBe(true);
  });

  it('refuses a javascript: URL rather than making it a live link', () => {
    const blocks = answerBlocks('[click here](javascript:alert(1))', [DAILY], TRACKED);
    expect(hrefs(blocks)).toEqual([]);
    expect(kinds(blocks)).toEqual(['paragraph', 'text']);
    // The words survive, so the sentence still reads. The target does not.
    expect(blockText(blocks)).toBe('click here');
  });

  it('refuses it however it is spelt', () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.test/path',
    ]) {
      expect(hrefs(answerBlocks(`[x](${url})`, [], [])), url).toEqual([]);
      expect(safeHref(url), url).toBe('');
    }
  });

  it('keeps the links worth keeping', () => {
    expect(safeHref('https://docs.databricks.com/x')).toBe('https://docs.databricks.com/x');
    expect(safeHref('http://example.test')).toBe('http://example.test');
    expect(safeHref('mailto:someone@example.test')).toBe('mailto:someone@example.test');
    expect(safeHref('/sources')).toBe('/sources');
    expect(hrefs(answerBlocks('[docs](https://example.test/a)', [], []))).toEqual(['https://example.test/a']);
  });
});

describe('the surfaces that are a sentence, not a document', () => {
  /**
   * The caveats and the degraded-answer banner render after a bolded lead-in
   * inside an alert. A heading or a list there would break the line, so those
   * take the inline constructs only.
   */
  it('reads bold, code and entity links in a caveat', () => {
    const nodes = answerInline('Refunds are netted into `gold_title_daily_summary` **already**.', [DAILY], TRACKED);
    expect(nodes.map((node) => node.kind)).toEqual(['text', 'code', 'text', 'strong', 'text']);
    expect(visible(nodes)).toBe('Refunds are netted into gold_title_daily_summary already.');
  });

  it('leaves a heading marker alone rather than opening a block in an alert', () => {
    const nodes = answerInline('## Not a heading here', [], []);
    expect(nodes.map((node) => node.kind)).toEqual(['text']);
    expect(visible(nodes)).toBe('## Not a heading here');
  });

  it('refuses the same URLs the block path refuses', () => {
    const nodes = answerInline('[x](javascript:alert(1))', [], []);
    expect(nodes.some((node) => node.kind === 'link')).toBe(false);
  });
});

describe('the rendered Markdown is styled as part of an answer', () => {
  /**
   * Asserted against the stylesheet, for the same reason message-selection.test
   * is: the effect is a painted pixel and this repo has no browser. This proves
   * the rules exist and say what they need to say. It cannot prove the result
   * looks right, and nothing here should be read as saying it has been seen.
   */
  const STYLESHEET = stylesheet();

  /** The body of the rule whose selector list starts a line with `selector`. */
  function ruleFor(selector: string): string {
    const at = STYLESHEET.indexOf(`\n${selector}`);
    if (at === -1) return '';
    const open = STYLESHEET.indexOf('{', at);
    const close = STYLESHEET.indexOf('}', open);
    return open === -1 || close === -1 ? '' : STYLESHEET.slice(open + 1, close);
  }

  it('sizes a heading as a section label, not as a title', () => {
    // The takeaway above it is 18px/700, the size the type scale reserves for a
    // card heading. A heading inside the card that competes with it turns an
    // answer into a report, which is what happened while the agent's `## DATA
    // PACKAGE` was rendering at a heading size of its own.
    expect(ruleFor('.answer-heading {')).toContain('font-size: 1em');
    expect(ruleFor('.answer-heading {')).toContain('font-weight: 600');
    // Body size with the weight up, so weight is the only thing marking it out,
    // and no size of its own to drift against the takeaway's.
    expect(ruleFor('.answer-heading {')).not.toContain('clamp');
    expect(ruleFor('.answer-subheading')).toContain('0.94em');
  });

  it('draws the specified dot glyph after Tailwind removes list markers', () => {
    expect(ruleFor('ul.answer-list')).toContain('list-style: none');
    expect(STYLESHEET).toContain("content: '·'");
    expect(ruleFor('ul.answer-list > li::before')).toContain('color: var(--ast-blue)');
    expect(ruleFor('ol.answer-list')).toContain('list-style: decimal');
    expect(ruleFor('.answer-list {')).toContain('gap: 6px');
  });

  it('gives a code span somewhere to break, because it holds an identifier', () => {
    expect(ruleFor('.answer-code')).toContain('overflow-wrap: anywhere');
    expect(ruleFor('.answer-code')).toContain('font-family');
  });

  it('draws a backticked name as the info chip, which is what is inside the backticks', () => {
    // A GREY TINT BECAME A COLOUR THAT MEANS SOMETHING. What the agent puts in
    // backticks is a table or a column name almost every time, and §3 sets an
    // entity name in prose as a mono tag, chip-coloured. The caveats already tag
    // theirs; they use the warning family's mono fill because they have a wash of
    // their own to sit on, and this one is on white, so it takes the info family.
    // #0E538B on #DDEAF4 is 6.34:1.
    //
    // The box is the caveats' box exactly -- 3px and 1px 5px -- so an identifier
    // is ONE shape across the card and only its colour reports which block it is
    // in. It was `--db-code-bg`, an rgba of a grey that is in no astrolabe family.
    const rule = ruleFor('.answer-code');
    expect(rule).toContain('background: var(--ast-info-fill)');
    expect(rule).toContain('color: var(--ast-info-text)');
    expect(rule).toContain('border-radius: 3px');
    expect(rule).toContain('padding: 1px 5px');
    expect(rule).not.toContain('--db-code-bg');
  });

  it('keeps the I-beam over prose the reader can select', () => {
    // The narrative is a div of blocks now rather than one paragraph, so the
    // rule written against `.answer-card p` has to reach the rest of them.
    expect(ruleFor('.answer-card p,')).toContain('cursor: text');
    expect(STYLESHEET).toContain('.answer-prose li');
    expect(STYLESHEET).toContain('.answer-heading,');
  });
});
