import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentCodeRow } from './AgentCodeRow';
import { agentModelFromResponse } from './agent-model-response';

const HOST = 'https://example-workspace.invalid';
const MODEL = 'a_catalog.a_schema.an_agent';
const VERSION_URL = `${HOST}/explore/data/models/a_catalog/a_schema/an_agent/version/3`;

const draw = (payload: unknown) => renderToStaticMarkup(<AgentCodeRow initialData={payload} />);

describe('the agent code row', () => {
  it('links the served version and says which tab the file is on', () => {
    const markup = draw({ model: MODEL, version: '3', url: VERSION_URL, versioned: true });

    expect(markup).toContain(`href="${VERSION_URL}"`);
    expect(markup).toContain('Open agent.py');
    expect(markup).toContain('Version 3 of a_catalog.a_schema.an_agent is answering');
    expect(markup).toContain('Artifacts tab');
  });

  it('leaves the app, as an external destination must', () => {
    const markup = draw({ model: MODEL, version: '3', url: VERSION_URL, versioned: true });

    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  /**
   * The row must not promise the exact code that answered when the endpoint did
   * not say which version is serving. It opens the model, and it says so.
   */
  it('offers the model, labelled as the model, when no version is known', () => {
    const markup = draw({
      model: MODEL,
      version: '',
      url: `${HOST}/explore/data/models/a_catalog/a_schema/an_agent`,
      versioned: false,
    });

    expect(markup).toContain('Open the model');
    expect(markup).not.toContain('Open agent.py');
    expect(markup).toContain('registered agent model');
    expect(markup).toContain('did not report which version is serving');
  });

  // A dead link teaches people the page is decorative, so a name with nowhere to
  // open reports the name and offers nothing to click.
  it('shows a name with no address as a name, not a link', () => {
    const markup = draw({ model: MODEL, version: '3', url: '', versioned: false });

    expect(markup).not.toContain('<a ');
    expect(markup).toContain('was not told which workspace it is in');
  });

  it('says not set rather than drawing an empty row', () => {
    const markup = draw({});

    expect(markup).not.toContain('<a ');
    expect(markup).toContain('Not set.');
  });

  it('reads the deployment fact from its own small route, not the Connections read', () => {
    const source = readFileSync(path.join(__dirname, 'AgentCodeRow.tsx'), 'utf8');

    expect(source).toContain("fetch('/api/settings/agent-model')");
    expect(source).not.toContain("fetch('/api/settings')");
  });

  it('appears in the Environment pane of Settings', () => {
    const source = readFileSync(path.join(__dirname, 'EnvironmentPanel.tsx'), 'utf8');

    expect(source).toContain('<AgentCodeRow initialData={initialAgentModel} />');
  });
});

describe('agentModelFromResponse', () => {
  it('drops a url that is not a string rather than handing it to href', () => {
    expect(agentModelFromResponse({ model: MODEL, version: 3, url: null, versioned: true })).toEqual({
      model: MODEL,
      version: '',
      url: '',
      versioned: false,
    });
  });

  it('never claims a version link without a link', () => {
    expect(agentModelFromResponse({ model: MODEL, version: '3', url: '', versioned: true }).versioned).toBe(false);
  });

  it('reports nothing established for a body an older server never sent', () => {
    for (const body of [undefined, null, {}, 'not json', { model: '   ' }]) {
      expect(agentModelFromResponse(body).model).toBe('');
    }
  });
});
