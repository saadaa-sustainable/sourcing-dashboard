export type PlanType = 'fg' | 'material' | 'inward';

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
      className={`wf-plan-tab${planType === type ? ' active' : ''}`}
    >
      {label}
    </a>
  );
  return (
    <div className="wf-plan-tabs">
      {tab('fg', 'Finished Goods')}
      {tab('material', 'Fabric / Material')}
      {tab('inward', 'Inward Plan II')}
    </div>
  );
}
