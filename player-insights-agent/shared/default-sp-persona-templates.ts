import type { SpPersonaGrantIntent, SpPersonaTemplate } from './sp-persona-templates';

const analysisTables = [
  'gold_player_180d_summary',
  'gold_title_daily_summary',
  'silver_gameplay_activity',
  'silver_player_profiles',
] as const;

const marketingTables = [...analysisTables, 'silver_purchases'] as const;

function single(
  resourceType: SpPersonaGrantIntent['resourceType'],
  action: SpPersonaGrantIntent['action'],
  privilege: string,
  label: string,
  choiceLabel: string,
  optional = false
): SpPersonaGrantIntent {
  return {
    resourceType,
    action,
    privilege,
    optional,
    selector: { match: 'single', labels: [label], choiceLabel },
  };
}

function curatedTables(idSuffixes: readonly string[], choiceLabel: string): SpPersonaGrantIntent {
  return {
    resourceType: 'TABLE',
    action: 'READ',
    privilege: 'SELECT',
    selector: {
      match: 'all',
      sources: ['configured', 'declared'],
      idSuffixes: [...idSuffixes],
      choiceLabel,
    },
  };
}

const warehouse = single('SQL_WAREHOUSE', 'USE', 'CAN USE', 'SQL warehouse', 'Analysis SQL warehouse');
const catalog = single('CATALOG', 'USE', 'USE CATALOG', 'App catalog', 'Governed analysis catalog');
const schema = single('SCHEMA', 'USE', 'USE SCHEMA', 'App schema', 'Governed analysis schema');
const dataGenie = single('GENIE_SPACE', 'USE', 'CAN RUN', 'Data Genie space', 'Data Genie space');
const dictionaryGenie = single('GENIE_SPACE', 'USE', 'CAN RUN', 'Dictionary Genie space', 'Dictionary Genie space');
const serving = single(
  'SERVING_ENDPOINT',
  'USE',
  'CAN QUERY',
  'Orchestrator serving endpoint',
  'Astrolabe serving endpoint'
);
const semanticIndex = single(
  'VECTOR_SEARCH_INDEX',
  'READ',
  'SELECT',
  'Vector Search index',
  'Metadata search index',
  true
);

const analystGrants = [
  warehouse,
  catalog,
  schema,
  curatedTables(analysisTables, 'Curated performance and player-analysis tables'),
  dataGenie,
  serving,
] satisfies SpPersonaGrantIntent[];

const marketingScientistGrants = [
  warehouse,
  catalog,
  schema,
  curatedTables(marketingTables, 'Curated audience, marketing, purchase, and player-profile tables'),
  dataGenie,
  dictionaryGenie,
  serving,
] satisfies SpPersonaGrantIntent[];

/**
 * Public, customer-neutral examples compiled into the server bundle.
 *
 * An explicit deployment override may replace these or safely extend them, but
 * the ordinary no-override path always serves this validated list.
 */
export const DEFAULT_SP_PERSONA_TEMPLATES = [
  {
    id: 'business-analyst',
    displayName: 'Business Analyst',
    roleSummary: 'Read-only analyst for governed performance and player investigation.',
    purpose:
      'Investigate curated performance and player trends through Astrolabe without changing source data or administering platform resources.',
    duties: [
      'Run governed analytical questions and validate results against curated tables.',
      'Use the Data Genie space for approved exploratory analysis.',
      'Query the Astrolabe serving endpoint to obtain governed answers.',
    ],
    dataBoundaries: [
      'Only resources configured or declared by this Astrolabe deployment may be selected.',
      'Table access is limited to the exact curated performance and player-analysis tables in the product data contract.',
      'Metadata search is optional, read-only, and does not grant access to table rows.',
    ],
    exclusions: [
      'No MODIFY, WRITE, CREATE, EDIT, MANAGE, or ownership privileges.',
      'No uncurated catalogs, schemas, tables, Genie spaces, or endpoints.',
      'No account, workspace, identity, secret, or permission administration.',
    ],
    keyCapabilities: [
      'Run governed SQL and Data Genie analysis',
      'Read only exact curated performance and player tables',
      'Optionally add read-only metadata search',
    ],
    variants: [
      {
        id: 'least-privilege',
        label: 'least-privilege profile',
        description: 'Read-only SQL, curated tables, Data Genie, and Astrolabe query access.',
        leastPrivilege: true,
        grants: analystGrants,
      },
      {
        id: 'semantic-discovery',
        label: 'Add metadata search',
        description:
          'Adds read-only Vector Search access so Astrolabe can find relevant table and column metadata; it does not grant access to table rows.',
        leastPrivilege: false,
        grants: [...analystGrants, semanticIndex],
      },
    ],
  },
  {
    id: 'marketing-scientist',
    displayName: 'Marketing Scientist',
    roleSummary: 'Read-only marketing scientist for governed audience, purchase, and player-profile analysis.',
    purpose:
      'Analyze curated marketing, addressability, purchase, and player-profile data through Astrolabe without changing data or managing platform resources.',
    duties: [
      'Evaluate audience and campaign questions against approved curated data.',
      'Use Data Genie for analysis and Dictionary Genie for governed metric definitions.',
      'Query the Astrolabe serving endpoint for evidence-backed responses.',
    ],
    dataBoundaries: [
      'Only resources configured or declared by this Astrolabe deployment may be selected.',
      'Table access is limited to the exact audience, marketing, purchase, and player-profile tables in the product data contract.',
      'Metadata search is optional, read-only, and does not grant access to table rows.',
    ],
    exclusions: [
      'No MODIFY, WRITE, CREATE, EDIT, MANAGE, or ownership privileges.',
      'No raw identity, contact, payment, or uncurated behavioral data.',
      'No account, workspace, identity, secret, or permission administration.',
    ],
    keyCapabilities: [
      'Run governed marketing and audience analysis',
      'Use Data Genie and Dictionary Genie',
      'Read only exact curated audience, purchase, and player-profile tables',
    ],
    variants: [
      {
        id: 'least-privilege',
        label: 'least-privilege profile',
        description:
          'Read-only SQL, curated audience and marketing tables, both Genie spaces, and Astrolabe query access.',
        leastPrivilege: true,
        grants: marketingScientistGrants,
      },
      {
        id: 'semantic-discovery',
        label: 'Add metadata search',
        description:
          'Adds read-only Vector Search access so Astrolabe can find relevant table and column metadata; it does not grant access to table rows.',
        leastPrivilege: false,
        grants: [...marketingScientistGrants, semanticIndex],
      },
    ],
  },
] satisfies SpPersonaTemplate[];
