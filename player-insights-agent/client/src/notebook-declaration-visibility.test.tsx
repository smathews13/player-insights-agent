import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  SHOW_NOTEBOOK_DECLARATION_EDITOR,
  groupConnections,
  readConnections,
  type SettingsPayload,
} from './connection-model';
import { connectedResource } from '../../shared/deployment-config';

describe('the notebook declarations table editor', () => {
  it('keeps the connection in code but renders neither its row nor an empty section', () => {
    const declaration = connectedResource('notebook-declaration')!;
    expect(declaration.label).toBe('Notebook declarations table');
    expect(SHOW_NOTEBOOK_DECLARATION_EDITOR).toBe(false);

    const payload: SettingsPayload = {
      resources: [
        {
          resource: declaration,
          configured: '',
          configuredFrom: 'artifact',
          actual: '',
          actualObserved: false,
          intended: null,
          intendedAt: '',
          intendedBy: '',
          editable: true,
          changedByLabel: '',
          changedByNote: '',
        },
      ],
      drift: [],
      status: 'ok',
      appBuildSha: '',
      modelBuildSha: '',
      orchestratorReported: false,
      storeAvailable: true,
      checkedAt: '2026-08-21T06:00:00Z',
    };

    const groups = groupConnections(readConnections(payload, []));
    const markup = renderToStaticMarkup(
      <>
        {groups.map((group) => (
          <section key={group.key}>
            <h3>{group.title}</h3>
            {group.readings.map((reading) => (
              <p key={reading.resource.id}>{reading.resource.label}</p>
            ))}
          </section>
        ))}
      </>
    );

    expect(markup).not.toContain('Notebook declarations table');
    expect(markup).not.toContain('Not checked');
    expect(markup).not.toContain('<section');
  });
});
