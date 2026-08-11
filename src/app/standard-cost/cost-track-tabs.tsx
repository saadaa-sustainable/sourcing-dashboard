export function CostTrackTabs({ track }: { track: 'fg' | 'material' }) {
  const tab = (key: 'fg' | 'material', label: string) => (
    <a
      href={`/standard-cost?track=${key}`}
      className={`wf-plan-tab${track === key ? ' active' : ''}`}
    >
      {label}
    </a>
  );
  return (
    <div className="wf-plan-tabs">
      {tab('fg', 'Finished Goods')}
      {tab('material', 'Materials')}
    </div>
  );
}
