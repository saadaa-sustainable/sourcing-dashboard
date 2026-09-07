'use client';

import { DATA_SOURCES, type DataSourceKey } from '@/lib/data-source';

/**
 * A compact legend mapping the source colours used on a table/page to their
 * meaning. Render it above a table whose columns carry `source` tags.
 */
export function SourceLegend({
  sources,
  label = 'Data source',
}: {
  sources: DataSourceKey[];
  label?: string;
}) {
  if (!sources.length) return null;
  return (
    <div className="src-legend" role="note" aria-label="Data source legend">
      <span className="src-legend-label">{label}</span>
      {sources.map((k) => {
        const s = DATA_SOURCES[k];
        return (
          <span className="src-legend-item" key={k} title={s.description}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        );
      })}
    </div>
  );
}

/** The thin source-coloured bar shown under a column header. */
export function SourceBar({ source }: { source: DataSourceKey }) {
  const s = DATA_SOURCES[source];
  return <span className="src-bar" style={{ background: s.color }} title={`Source: ${s.label}`} aria-hidden="true" />;
}
