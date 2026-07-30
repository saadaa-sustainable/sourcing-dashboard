export function PlanTypeTabs({
  planMonth,
  planType,
}: {
  planMonth: string;
  planType: 'fg' | 'material';
}) {
  const tab = (type: 'fg' | 'material', label: string) => (
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
    </div>
  );
}
