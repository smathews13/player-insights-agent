import type { DecisionStore } from '../deployment-decisions';

/**
 * An in-memory `deployment_decisions` + `deployment_variables` store for tests.
 *
 * It answers exactly the statements those two modules issue, by shape, and
 * throws on anything else so a new statement cannot pass a test by accident.
 */
export function memoryDeploymentStore(initial: { decisions?: Record<string, string> } = {}) {
  const decisions = new Map<string, string>(Object.entries(initial.decisions ?? {}));
  type Row = { value: string; source: string; revision: number };
  const variables = new Map<string, Map<string, Row>>();
  const history: { scope: string; name: string; value: string | null; source: string; revision: number }[] = [];

  function scope(name: string) {
    let rows = variables.get(name);
    if (!rows) variables.set(name, (rows = new Map<string, Row>()));
    return rows;
  }

  const store: DecisionStore = {
    query(text: string, params: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT value FROM') && sql.includes('deployment_decisions')) {
        const value = decisions.get(String(params[0]));
        return Promise.resolve({ rows: value === undefined ? [] : [{ value }] });
      }
      if (sql.startsWith('INSERT INTO') && sql.includes('deployment_decisions')) {
        decisions.set(String(params[0]), String(params[1]));
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('SELECT name, value FROM') && sql.includes('deployment_variables')) {
        const rows = [...(variables.get(String(params[0]))?.entries() ?? [])];
        return Promise.resolve({ rows: rows.map(([name, row]) => ({ name, value: row.value })) });
      }
      if (sql.startsWith('WITH input(name, value)')) {
        const [scopeName, names, values, source] = params as [string, string[], string[], string];
        const rows = scope(scopeName);
        const incoming = new Map(names.map((name, index) => [name, values[index]]));
        for (const [name, row] of [...rows]) {
          if (incoming.has(name)) continue;
          rows.delete(name);
          history.push({ scope: scopeName, name, value: null, source, revision: row.revision + 1 });
        }
        for (const [name, value] of incoming) {
          const existing = rows.get(name);
          if (existing && existing.value === value) continue;
          const revision = existing ? existing.revision + 1 : 1;
          rows.set(name, { value, source, revision });
          history.push({ scope: scopeName, name, value, source, revision });
        }
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith('SELECT scope, name, value, source, revision')) {
        const rows = [...variables.entries()].flatMap(([scopeName, entries]) =>
          [...entries.entries()].map(([name, row]) => ({
            scope: scopeName,
            name,
            value: row.value,
            source: row.source,
            revision: row.revision,
            updated_by: 'test',
            updated_at: new Date(0),
          }))
        );
        return Promise.resolve({ rows });
      }
      return Promise.reject(new Error(`memoryDeploymentStore does not answer: ${sql.slice(0, 80)}`));
    },
  };

  const scopeValues = (name: string) =>
    Object.fromEntries([...(variables.get(name)?.entries() ?? [])].map(([key, row]) => [key, row.value]));

  return { store, decisions, variables, history, scopeValues };
}
