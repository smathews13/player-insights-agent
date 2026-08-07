import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..');

function serverSourceWithoutComments(): string {
  const source = readFileSync(path.join(repoRoot, 'server/server.ts'), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * AppKit's serving plugin invoke path runs the request body through two
 * allowlists in sequence, and `custom_inputs` survives neither:
 *
 *   1. `filterRequestBody` in plugins/serving/schema-filter.js, driven by the
 *      `requestKeys` written into node_modules/.databricks/appkit by
 *      `appkit generate-types`. Today the endpoint's OpenAPI schema declares no
 *      request properties, so `requestKeys` is `[]` and the filter is a no-op.
 *      That is an accident of the current model signature, not a guarantee:
 *      typegen reruns on postinstall, prebuild and predev, and a model version
 *      logged with a richer input example would populate it.
 *   2. `servingEndpoints.query()` in the SDK, which rebuilds the payload from a
 *      hardcoded field list. This one is not configurable at all.
 */
describe('the serving plugin is not registered', () => {
  it('is absent from the plugins passed to createApp', () => {
    const source = serverSourceWithoutComments();
    const plugins = /plugins:\s*\[([^\]]*)\]/.exec(source);

    expect(plugins, 'could not find the plugins array in server/server.ts').not.toBeNull();
    expect(plugins?.[1],
      'serving() is back in server/server.ts. It republishes /api/serving/invoke, ' +
        'which drops custom_inputs at two allowlists. Use the insights route transport instead.'
    ).not.toMatch(/\bserving\s*\(/);
  });

  it('is not imported, so it cannot be registered indirectly', () => {
    const source = serverSourceWithoutComments();
    const imports = /import\s*\{([^}]*)\}\s*from\s*'@databricks\/appkit'/.exec(source);

    expect(imports, 'could not find the @databricks/appkit import in server/server.ts').not.toBeNull();
    expect(imports?.[1].split(',').map((name) => name.trim())).not.toContain('serving');
  });
});

describe('the allowlist that made the plugin unsafe', () => {
  /**
   * Runs AppKit's own filter to show the hazard is real rather than theoretical,
   * and to pin the assumption that today's empty allowlist is what keeps it
   * quiet. If AppKit relocates this module the test fails, which is the correct
   * outcome: the invariant needs rechecking against the new internals.
   */
  async function loadFilter() {
    const appkit = require.resolve('@databricks/appkit');
    const filterPath = path.join(path.dirname(appkit), 'plugins/serving/schema-filter.js');
    const module = (await import(pathToFileURL(filterPath).href)) as {
      filterRequestBody: (body: Record<string, unknown>,
        allowlists: Map<string, Set<string>>,
        alias: string,
        filterMode?: 'strip' | 'reject'
      ) => Record<string, unknown>;
    };
    return module.filterRequestBody;
  }

  const body = { input: [{ role: 'user', content: 'hi' }], custom_inputs: { conversation_id: 'c1' } };

  it('discards custom_inputs without failing once requestKeys is populated', async () => {
    const filterRequestBody = await loadFilter();
    const populated = new Map([['default', new Set(['input', 'messages'])]]);

    // No throw, no rejected request. The field is simply gone. This is the
    // shape of the defect that cost a day of debugging.
    expect(filterRequestBody(body, populated, 'default')).toEqual({ input: body.input });
  });

  it('is inert only because the generated allowlist is empty', async () => {
    const filterRequestBody = await loadFilter();

    expect(filterRequestBody(body, new Map(), 'default')).toBe(body);
  });
});
