import type { ReactNode } from 'react';

export interface MethodologyRow {
  label?: string;
  detail: ReactNode;
}

export interface MethodologyGroup {
  title: 'How totals are calculated' | 'Budget controls' | 'Not included' | 'Limits';
  rows: readonly MethodologyRow[];
}

/**
 * Shared information architecture for Cost and Forecasting methodology.
 * Empty groups are omitted, while populated groups always retain the same order.
 */
export function MethodologySections({ groups }: { groups: readonly MethodologyGroup[] }) {
  const order: MethodologyGroup['title'][] = ['How totals are calculated', 'Budget controls', 'Not included', 'Limits'];
  const populated = order
    .map((title) => groups.find((group) => group.title === title))
    .filter((group): group is MethodologyGroup => Boolean(group && group.rows.length > 0));

  return (
    <div className="ops-methodology-sections">
      {populated.map((group) => (
        <section key={group.title}>
          <h5>{group.title}</h5>
          <dl className="ops-methodology-rows">
            {group.rows.map((row) => (
              <div
                className={row.label ? undefined : 'ops-methodology-detail-only'}
                key={row.label ?? (typeof row.detail === 'string' ? row.detail : group.title)}
              >
                {row.label ? <dt>{row.label}</dt> : null}
                <dd>{row.detail}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
