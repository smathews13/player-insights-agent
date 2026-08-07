// Derives the deploy tree's app.yaml from the authored app.yaml.
//
// The two files cannot be identical: the deploy tree has no package.json, so
// `npm run start` is not available and the command has to invoke node directly.
// That difference used to be expressed by writing the deployed file from a
// literal in bundle-server.mjs, which made it a second source of truth,
// PLAYER_INSIGHTS_EXPERIMENT_ID was added to the authored file and never
// reached the deployed app, so the MLflow deep link it exists for was inert in
// production and nothing reported it.
import { readFile, writeFile } from 'node:fs/promises';

const TOP_LEVEL_KEY = /^([A-Za-z_][\w.-]*):(.*)$/;
const ENTRY_START = /^ {2}-\s+(\S.*)$/;
const ENTRY_CONTINUATION = /^ {4}\S/;
const KEY_VALUE = /^([A-Za-z_][\w.-]*):\s*(.*)$/;

function isIgnorable(line) {
  return line.trim() === '' || line.trimStart().startsWith('#');
}

function unquote(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  return (quote === "'" || quote === '"') && trimmed.endsWith(quote) ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Splits the document into top-level blocks, keeping every line verbatim so
 * comments and formatting survive the round trip.
 */
function splitBlocks(source) {
  const blocks = [];
  let pending = [];
  let current = null;

  for (const line of source.split('\n')) {
    if (isIgnorable(line)) {
      pending.push(line);
      continue;
    }

    const topLevel = TOP_LEVEL_KEY.exec(line);
    if (topLevel) {
      current = { key: topLevel[1], inline: topLevel[2].trim(), preamble: pending, header: line, body: [] };
      blocks.push(current);
      pending = [];
      continue;
    }

    if (!/^\s/.test(line)) {
      throw new Error(`app.yaml: cannot parse top-level line ${JSON.stringify(line)}`);
    }
    if (!current) {
      throw new Error(`app.yaml: indented line before any key: ${JSON.stringify(line)}`);
    }

    current.body.push(...pending, line);
    pending = [];
  }

  return { blocks, trailing: pending };
}

/**
 * Parses an `env:` block into one record per variable. Each keeps its own source
 * lines (including the comments written above it), so re-rendering an untouched
 * variable reproduces it exactly.
 */
function parseEnvEntries(body) {
  const entries = [];
  let pending = [];
  let current = null;

  for (const line of body) {
    if (isIgnorable(line)) {
      pending.push(line);
      continue;
    }

    if (ENTRY_START.test(line)) {
      current = { name: null, lines: [...pending, line] };
      entries.push(current);
      pending = [];
    } else if (ENTRY_CONTINUATION.test(line)) {
      if (!current) throw new Error(`app.yaml: env continuation before any entry: ${JSON.stringify(line)}`);
      current.lines.push(...pending, line);
      pending = [];
    } else {
      throw new Error(`app.yaml: cannot parse env line ${JSON.stringify(line)}`);
    }

    const keyValue = KEY_VALUE.exec(line.replace(ENTRY_START, '$1').trimStart());
    if (keyValue?.[1] === 'name') current.name = unquote(keyValue[2]);
  }

  for (const entry of entries) {
    if (!entry.name) {
      throw new Error(`app.yaml: env entry without a name:\n${entry.lines.join('\n')}`);
    }
  }

  // A trailing comment belongs to the file, not to the last variable, so it is
  // returned separately rather than being dragged around by a merge.
  return { entries, trailing: pending };
}

function renderOverride({ name, value, valueFrom }) {
  if ((value === undefined) === (valueFrom === undefined)) {
    throw new Error(`env override ${name} needs exactly one of value or valueFrom`);
  }
  const [key, raw] = value === undefined ? ['valueFrom', valueFrom] : ['value', value];
  return [`  - name: ${name}`, `    ${key}: ${raw}`];
}

/**
 * Renders the deploy tree's app.yaml from the authored source.
 *
 * @param {string} source authored app.yaml, verbatim
 * @param {object} options
 * @param {string} [options.command] replaces the authored `command:` value
 * @param {{ name: string, value?: string, valueFrom?: string }[]} [options.env]
 *   variables to add, or to replace in place when the name is already authored
 * @param {string} [options.banner] comment prepended to the generated file
 * @returns {string}
 */
export function renderDeployAppYaml(source, { command, env = [], banner } = {}) {
  const { blocks, trailing } = splitBlocks(source);
  const out = banner ? [banner] : [];

  const envBlock = blocks.find((block) => block.key === 'env');
  if (envBlock?.inline) {
    throw new Error(`app.yaml: inline env value is not supported: ${JSON.stringify(envBlock.header)}`);
  }

  for (const block of blocks) {
    out.push(...block.preamble);

    if (block.key === 'command' && command !== undefined) {
      out.push(`command: ${command}`);
      continue;
    }

    if (block.key !== 'env') {
      out.push(block.header, ...block.body);
      continue;
    }

    const { entries, trailing: envTrailing } = parseEnvEntries(block.body);
    for (const override of env) {
      const existing = entries.find((entry) => entry.name === override.name);
      const lines = renderOverride(override);
      if (existing) existing.lines = lines;
      else entries.push({ name: override.name, lines });
    }

    out.push(block.header, ...entries.flatMap((entry) => entry.lines), ...envTrailing);
  }

  if (!envBlock && env.length > 0) {
    out.push('env:', ...env.flatMap(renderOverride));
  }

  out.push(...trailing);
  return out.join('\n');
}

/** The variable names the authored file declares, in source order. */
export function envNames(source) {
  const block = splitBlocks(source).blocks.find((b) => b.key === 'env');
  return block ? parseEnvEntries(block.body).entries.map((entry) => entry.name) : [];
}

/** Reads the authored app.yaml and writes the derived one into the deploy tree. */
export async function writeDeployAppYaml({ from, to, ...overrides }) {
  await writeFile(to, renderDeployAppYaml(await readFile(from, 'utf8'), overrides));
}
