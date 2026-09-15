export type PlanType = 'fg' | 'material' | 'analysis';

/** Track switcher shared by every Buying Plan track — a segmented pill. */
export function PlanTypeTabs({
  planMonth,
  planType,
}: {
  planMonth: string;
  planType: PlanType;
}) {
  const tab = (type: PlanType, label: string) => (
    <a
      href={`/buying-plan?month=${planMonth}&type=${type}`}
      className={`bp-tab${planType === type ? ' active' : ''}`}
      aria-current={planType === type ? 'page' : undefined}
    >
      {label}
    </a>
  );
  return (
    <div className="bp-tabs" role="tablist" aria-label="Buying plan track">
      {tab('fg', 'Finished goods')}
      {tab('material', 'Fabric / Material')}
      {tab('analysis', 'Analysis')}
    </div>
  );
}
