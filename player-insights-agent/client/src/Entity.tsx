import { Fragment, type CSSProperties, type ReactNode } from 'react';

export type EntityKind = 'catalog' | 'schema' | 'table' | 'column' | 'quote' | 'tag';

export function Entity({
  kind,
  children,
  className = '',
  style,
  as: Tag = 'span',
}: {
  kind: EntityKind;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  as?: 'span' | 'code';
}) {
  return (
    <Tag
      className={['entity-token', `entity-${kind}`, className].filter(Boolean).join(' ')}
      data-entity-part={kind}
      style={style}
    >
      {children}
    </Tag>
  );
}

export function EntityParts({
  text,
  entity,
  sourceName = false,
}: {
  text: string;
  entity: string;
  sourceName?: boolean;
}) {
  const full = entity.split('.');
  const shown = text.split('.');
  const offset = Math.max(0, full.length - shown.length);
  return (
    <>
      {shown.map((part, index) => {
        const fullIndex = offset + index;
        const kind: EntityKind =
          fullIndex === 0 && full.length >= 3
            ? 'catalog'
            : fullIndex === full.length - 2 && full.length >= 2
              ? 'schema'
              : 'table';
        return (
          <Fragment key={shown.slice(0, index + 1).join('.')}>
            {index > 0 ? <span className="entity-separator">.</span> : null}
            <Entity
              kind={kind}
              className={sourceName ? (index === shown.length - 1 ? 'source-name-short' : 'source-name-qualifier') : ''}
            >
              {part}
            </Entity>
          </Fragment>
        );
      })}
    </>
  );
}
