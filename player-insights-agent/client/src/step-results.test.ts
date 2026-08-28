/**
 * What a recorded result is read as, and what it refuses to read.
 *
 * The payloads here are the ones the agent really writes. The Genie strings are
 * `_genie` in agent/tools.py joining `format_genie_space`, the interpretation
 * attachment, `render_rows` and Genie's prose; the semantic strings are
 * `RetrievalOutcome.rendered` in agent/semantic_retrieval.py, whose heading is
 * `[{entry_kind}] {name} ({tags})` and whose columns are one per line. A parse
 * asserted against a payload invented here would pass while the panel showed a
 * paragraph.
 *
 * EVERY PARSE HAS A REFUSAL TEST, and those are the ones that matter most. The
 * reading is only safe to attempt because a shape it cannot find returns null and
 * the caller falls back to markdown, so a parse that started guessing instead of
 * refusing would be a silent regression: the panel would show a card that says
 * something the payload does not.
 */
import { describe, expect, it } from 'vitest';
import {
  chipRuns,
  collapsedName,
  factRows,
  fieldDefinition,
  genieResult,
  noteBody,
  reportSections,
  semanticResult,
  sqlClauseLines,
  sqlStatements,
  truncatedId,
  understoodAs,
} from './step-results';

const DATA_GENIE = [
  'Asking Genie space Player Insights Data (d00dfeedd00dfeedd00dfeedd00dfeed).',
  '',
  'Query interpretation: You want to see the total number of unique players in the silver_player_profiles table.',
  '',
  'Query result: distinct_players',
  '12000',
  '',
  'There are **12,000 distinct player_id values** in the silver_player_profiles table, as shown by the distinct_players value of 12,000. This count represents the total number of unique players in the table.',
].join('\n');

const DICTIONARY_GENIE = [
  'Asking Genie space Player Insights Data Dictionary (badc0ffebadc0ffebadc0ffebadc0ffe).',
  '',
  'Query interpretation: You want to see the business definitions and usage guardrails for columns named like ' +
    "'player_id' to understand what 'player_id' represents.",
  '',
  'Query result: table_name | column_name | business_definition | usage_guardrail',
  'silver_player_profiles | player_id | Surrogate key for one player account within its owning label. | Never return in an answer. Aggregate only.',
  '',
  'The field **player_id** in the table **silver_player_profiles** is defined as a surrogate key for one player ' +
    'account within its owning label. Based on this information, **player_id** is the correct field to count ' +
    'distinct players, as long as it is used only for aggregation.',
].join('\n');

const SEMANTIC = [
  'SEMANTIC SEARCH RESULTS. These are descriptions and definitions, not data. Nothing here is a measurement and ' +
    'none of it may be reported as a figure, a source, or a fact about the business. Use it to choose which ' +
    'tables and terms to ask about, then get the numbers from data_genie, dictionary_genie or SQL.',
  '',
  '[table] <your_catalog>.<your_schema>.silver_player_profiles (uncertified)',
  'Table <your_catalog>.<your_schema>.silver_player_profiles. Validated player profiles with explicit email eligibility and identity scope.',
  'Columns:',
  '- player_id (string)',
  '- crm_customer_ref (string)',
  '- label (string)',
  '- identity_confidence (decimal(5,4))',
  '- signup_date (date)',
  '- snapshot_date (date)',
  '',
  '[table] <your_catalog>.<your_schema>.data_dictionary (uncertified)',
  'Table <your_catalog>.<your_schema>.data_dictionary. Business definitions, sensitivity, and usage guardrails for curated Player Insights fields',
  'Columns:',
  '- table_name (string)',
  '- column_name (string)',
  '',
  '13 further entr(y/ies) matched and were left out to stay inside the result budget. Search again with a narrower question or a kind filter if none of the above is the right one.',
  '',
  'What appears above was filtered by a cached snapshot of grants from when this semantic layer was built. It is ' +
    'neither permission to read nor proof a table is missing.',
].join('\n');

const FINDINGS = [
  'There are **12,000 distinct players** in the dataset.',
  '',
  '**Source details:** - **Table:** `silver_player_profiles` - **Key used:** `player_id` — defined in the data ' +
    'dictionary as *"surrogate key for one player account within its owning label"*; it is the appropriate field ' +
    'for counting distinct players - **Count:** 12,000 distinct `player_id` values (NULLs excluded by the ' +
    'DISTINCT count)',
  '',
  'Note: `player_id` is scoped per label, so if a player exists under multiple labels they may be counted more ' +
    'than once. If you need a cross-label unique player count, a different identity key (such as ' +
    '`crm_customer_ref`) may be more appropriate — let me know if you would like that breakdown.',
].join('\n');

describe('an id on the page', () => {
  it('keeps the family prefix and the last four characters', () => {
    expect(truncatedId('tr-deadbeefdeadbeefdeadbeefdeadbeef')).toBe('tr-deadbeef…beef');
    expect(truncatedId('d00dfeedd00dfeedd00dfeedd00dfeed')).toBe('d00dfeed…feed');
  });

  it('leaves an id alone when cutting it would not shorten it', () => {
    expect(truncatedId('tr-1234')).toBe('tr-1234');
  });
});

describe('names inside a sentence', () => {
  it('chips a bare identifier and the words around it stay prose', () => {
    const runs = chipRuns('The total number of unique players in silver_player_profiles.');
    expect(runs.filter((run) => run.chip).map((run) => run.text)).toEqual(['silver_player_profiles']);
    expect(runs.map((run) => run.text).join('')).toBe('The total number of unique players in silver_player_profiles.');
  });

  it('does not chip an ordinary word, or a sentence stop read as a dotted name', () => {
    const runs = chipRuns('The count is the total for every label, e.g. one row per player.');
    expect(runs.filter((run) => run.chip)).toEqual([]);
  });

  it('chips a backticked name and drops the backticks', () => {
    const runs = chipRuns('Use `label` for this.');
    expect(runs.filter((run) => run.chip).map((run) => run.text)).toEqual(['label']);
    expect(runs.map((run) => run.text).join('')).toBe('Use label for this.');
  });
});

describe('what Genie was understood to have been asked', () => {
  it('drops the label boilerplate and the second person, and unwraps a table name', () => {
    expect(
      understoodAs(
        'Query interpretation: You want to see the total number of unique players in the silver_player_profiles table.'
      )
    ).toBe('The total number of unique players in silver_player_profiles.');
  });
});

describe('a data_genie result', () => {
  const result = genieResult(DATA_GENIE);

  it('names the space that answered, with its id', () => {
    expect(result?.space).toEqual({ name: 'Player Insights Data', id: 'd00dfeedd00dfeedd00dfeedd00dfeed' });
  });

  it('reads a one-column result as a grid rather than as a sentence', () => {
    expect(result?.table).toEqual({ head: ['distinct_players'], rows: [['12000']], note: null });
  });

  it('says the figure once: the clause pointing back at the table goes', () => {
    expect(result?.answer).toBe('There are **12,000 distinct player_id values** in the silver_player_profiles table.');
  });

  it('keeps a sentence that qualifies the figure instead of restating it', () => {
    const text = DATA_GENIE.replace(
      'This count represents the total number of unique players in the table.',
      'This result was truncated before it was returned.'
    );
    expect(genieResult(text)?.answer).toContain('truncated');
  });

  it('keeps a sample disclosure that arrived inside the rows', () => {
    const text = DATA_GENIE.replace('12000', '12000\n(showing the first 100 rows)');
    expect(genieResult(text)?.table?.note).toBe('(showing the first 100 rows)');
  });

  it('refuses a payload with none of its markers, so the panel renders markdown', () => {
    expect(genieResult('Genie could not answer: the warehouse was unavailable.')).toBeNull();
  });

  it('reads a result that carries only an interpretation, which is what older runs recorded', () => {
    const older = 'Query interpretation: You want to see the top 10 dates by sessions.\n\nThe top 10 dates are shown.';
    expect(genieResult(older)?.understood).toBe('The top 10 dates by sessions.');
    expect(genieResult(older)?.space).toBeNull();
  });
});

describe('a dictionary_genie result', () => {
  const result = genieResult(DICTIONARY_GENIE);

  it('becomes one field definition, read off the dictionary row and not the prose', () => {
    const definition = fieldDefinition(result!);
    expect(definition?.column).toBe('player_id');
    expect(definition?.table).toBe('silver_player_profiles');
    expect(definition?.definition).toBe('Surrogate key for one player account within its owning label.');
  });

  it('states the guardrail as one rule, in the order the row gave it', () => {
    expect(fieldDefinition(result!)?.guardrail).toBe('Never return in an answer · aggregate only');
  });

  it('ends on the answer’s own conclusion, without its discourse opener', () => {
    expect(fieldDefinition(result!)?.verdict).toBe(
      '**player_id** is the correct field to count distinct players, as long as it is used only for aggregation.'
    );
  });

  it('is not a definition card when the lookup returned several rows', () => {
    const many = DICTIONARY_GENIE.replace(
      'silver_player_profiles | player_id | Surrogate key for one player account within its owning label. | Never return in an answer. Aggregate only.',
      [
        'silver_player_profiles | player_id | Surrogate key for one player account. | Never return in an answer.',
        'silver_player_profiles | crm_customer_ref | Cross-label customer key. | Aggregate only.',
      ].join('\n')
    );
    expect(fieldDefinition(genieResult(many)!)).toBeNull();
  });

  it('is not a definition card when the columns are not the dictionary’s', () => {
    const other = DATA_GENIE;
    expect(fieldDefinition(genieResult(other)!)).toBeNull();
  });
});

describe('a search_semantics result', () => {
  const result = semanticResult(SEMANTIC);

  it('reads the entries the search matched, in order', () => {
    expect(result?.entries.map((entry) => entry.name)).toEqual([
      '<your_catalog>.<your_schema>.silver_player_profiles',
      '<your_catalog>.<your_schema>.data_dictionary',
    ]);
    expect(result?.kind).toBe('table');
  });

  it('reads each entry’s certification, description and columns apart from each other', () => {
    const [first] = result!.entries;
    expect(first.certification).toBe('uncertified');
    expect(first.description).toBe('Validated player profiles with explicit email eligibility and identity scope.');
    expect(first.columns.slice(0, 2)).toEqual([
      { name: 'player_id', type: 'string' },
      { name: 'crm_customer_ref', type: 'string' },
    ]);
    expect(first.columns).toHaveLength(6);
  });

  it('reads repeated compact table blocks with undashed column rows', () => {
    const compact = [
      '[table] catalog.schema.first_table (uncertified)',
      'Table catalog.schema.first_table. First description.',
      'Columns:',
      'first_id (string)',
      'created_at (timestamp)',
      '[table] catalog.schema.second_table (certified)',
      'Table catalog.schema.second_table. Second description.',
      'Columns:',
      'second_id (bigint)',
    ].join('\n');
    const parsed = semanticResult(compact);
    expect(parsed?.entries).toEqual([
      {
        kind: 'table',
        name: 'catalog.schema.first_table',
        certification: 'uncertified',
        description: 'First description.',
        columns: [
          { name: 'first_id', type: 'string' },
          { name: 'created_at', type: 'timestamp' },
        ],
      },
      {
        kind: 'table',
        name: 'catalog.schema.second_table',
        certification: 'certified',
        description: 'Second description.',
        columns: [{ name: 'second_id', type: 'bigint' }],
      },
    ]);
  });

  it('drops the two notices that arrive on every call', () => {
    expect(result?.note).not.toContain('SEMANTIC SEARCH RESULTS');
    expect(result?.note).not.toContain('cached snapshot of grants');
  });

  it('keeps what this search said it left out', () => {
    expect(result?.note).toContain('13 further entr(y/ies) matched');
  });

  it('keeps a notice it has not been told about, rather than dropping it silently', () => {
    const unverified = SEMANTIC.replace(
      '13 further entr(y/ies) matched and were left out to stay inside the result budget. Search again with a narrower question or a kind filter if none of the above is the right one.',
      'This search ran without a verified signed-in identity, so it returned only entries marked readable by everyone.'
    );
    expect(semanticResult(unverified)?.note).toContain('without a verified signed-in identity');
  });

  it('refuses a search that matched nothing, so its own sentence survives', () => {
    const empty =
      'SEMANTIC SEARCH RESULTS. These are descriptions and definitions, not data.\n\nNo semantic entries matched. ' +
      'Fall back to list_data_assets and describe_table.';
    expect(semanticResult(empty)).toBeNull();
  });

  it('refuses a failure, which is prose and not a list of entries', () => {
    expect(semanticResult('SEMANTIC SEARCH UNAVAILABLE. The index could not be reached.')).toBeNull();
  });
});

describe('a table name at row width', () => {
  it('elides the catalog and keeps the object apart from the schema', () => {
    expect(collapsedName('<your_catalog>.<your_schema>.silver_player_profiles')).toEqual({
      lead: '…<your_schema>',
      object: 'silver_player_profiles',
    });
  });

  it('leaves a bare name with nothing to elide', () => {
    expect(collapsedName('silver_player_profiles')).toEqual({ lead: '', object: 'silver_player_profiles' });
  });
});

describe('an agent step’s findings', () => {
  const sections = reportSections(FINDINGS);

  it('is read as a sentence, a grid of pairs, and a note', () => {
    expect(sections.map((section) => section.kind)).toEqual(['prose', 'facts', 'note']);
  });

  it('turns the inline label/value run back into the rows it was written as', () => {
    const facts = sections[1].kind === 'facts' ? sections[1].facts : [];
    expect(facts.map((fact) => fact.label)).toEqual(['Table', 'Key used', 'Count']);
    expect(facts[0].value).toBe('`silver_player_profiles`');
    expect(facts[2].value).toBe('12,000 distinct `player_id` values (NULLs excluded by the DISTINCT count)');
  });

  it('drops the offer to do more work from the end of the note', () => {
    const note = sections[2].kind === 'note' ? sections[2].text : '';
    expect(note).toContain('scoped per label');
    expect(note).not.toContain('let me know');
    expect(note.startsWith('Note:')).toBe(false);
  });

  it('reads a step with no pairs and no note as prose, unchanged', () => {
    expect(reportSections('search_semantics')).toEqual([{ kind: 'prose', text: 'search_semantics' }]);
  });

  it('refuses to read a lead-in with no pairs after it as a grid', () => {
    expect(factRows('**Source details:** the dictionary and one query.')).toBeNull();
  });

  it('leaves a note that is only a caveat alone', () => {
    expect(noteBody('Note: the count excludes NULLs.')).toBe('the count excludes NULLs.');
  });
});

describe('a recorded statement', () => {
  const SQL =
    'SELECT `table_name`, `column_name` FROM `<your_catalog>`.`<your_schema>`.`data_dictionary` ' +
    "WHERE `column_name` ILIKE '%player_id%' AND `business_definition` IS NOT NULL; " +
    'SELECT COUNT(DISTINCT `player_id`) AS distinct_players FROM `<your_catalog>`.`silver_player_profiles`';

  it('is separated into the statements a run generated', () => {
    expect(sqlStatements(SQL)).toHaveLength(2);
  });

  it('breaks one line into a line per clause, and not per predicate', () => {
    expect(sqlClauseLines(sqlStatements(SQL)[0])).toEqual([
      'SELECT `table_name`, `column_name`',
      'FROM `<your_catalog>`.`<your_schema>`.`data_dictionary`',
      "WHERE `column_name` ILIKE '%player_id%' AND `business_definition` IS NOT NULL;",
    ]);
  });

  it('does not break inside a literal or a quoted name that holds a keyword', () => {
    const quoted = "SELECT `where` FROM t WHERE label = 'from Northwind'";
    expect(sqlClauseLines(quoted)).toEqual(['SELECT `where`', 'FROM t', "WHERE label = 'from Northwind'"]);
  });

  it('does not split on a semicolon inside a literal', () => {
    expect(sqlStatements("SELECT 'a;b' AS x")).toHaveLength(1);
  });
});
