'use client';

import type { CostSnapshot } from '@/lib/standard-cost-workflow';

export type FabricRates = Record<string, { grey: number | null; processing: number | null; finished: number | null }>;
const STANDARD_SIZES = ['XS','S','M','L','XL','2XL','3XL','4XL','5XL'];
const display = (n: number | null | undefined) => n == null ? '—' : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n);

export function AmendmentFabric({ value, onChange, fabricBase, disabled }: {
  value: CostSnapshot['fabric']; onChange: (value: CostSnapshot['fabric']) => void;
  fabricBase: FabricRates; disabled: boolean;
}) {
  const rate = fabricBase[value.fabric_code];
  const colours = [...new Set(value.lines.map(line => line.colour))];
  const visibleColours = colours.length ? colours : ['All colours'];
  const sizesFor = (colour: string) => [...new Set([...STANDARD_SIZES, ...value.lines.filter(line => line.colour === colour).map(line => line.size).filter(Boolean)])];
  function changeFabric(code: string) {
    const finished = fabricBase[code]?.finished;
    onChange({ ...value, fabric_code: code, lines: value.lines.map(line => {
      const cost = finished != null && line.consumption != null ? Math.round(finished * line.consumption * 100) / 100 : null;
      return { ...line, fabric_cost: cost, total_cost: cost != null && line.cm_cost != null ? cost + line.cm_cost : null };
    }) });
  }
  function consumption(index: number, text: string) {
    const amount = text.trim() === '' ? null : Number(text);
    const cost = amount != null && rate?.finished != null ? Math.round(amount * rate.finished * 100) / 100 : null;
    onChange({ ...value, lines: value.lines.map((line,i) => i !== index ? line : { ...line, consumption: amount, fabric_cost: cost, total_cost: cost != null && line.cm_cost != null ? cost + line.cm_cost : null }) });
  }
  function sizeConsumption(colour: string, size: string, text: string) {
    const index = value.lines.findIndex(line => line.colour === colour && line.size === size);
    if (text.trim() === '') {
      if (index >= 0) onChange({ ...value, lines: value.lines.filter((_,i) => i !== index) });
      return;
    }
    const amount = Number(text);
    const cost = rate?.finished != null ? Math.round(amount * rate.finished * 100) / 100 : null;
    if (index >= 0) {
      consumption(index,text);
      return;
    }
    onChange({ ...value, lines: [...value.lines, { colour, size, consumption: amount, fabric_cost: cost, cm_cost: 0, total_cost: cost }] });
  }
  return <div className="scw-fabric-sheet">
    <fieldset disabled={disabled} className="scw-fabric-controls"><div className="wf-form-grid">
      <label className="field wf-field"><span>Fabric <span className="scw-required" aria-label="required">*</span><small>The fabric this product uses</small></span><select value={value.fabric_code} onChange={e => changeFabric(e.target.value)}><option value="">Choose fabric</option>{[...new Set([value.fabric_code,...Object.keys(fabricBase)])].filter(Boolean).sort().map(code => <option key={code}>{code}</option>)}</select></label>
      <label className="field wf-field"><span>Consumed in <span className="scw-required" aria-label="required">*</span><small>How this fabric is bought and consumed — rate and consumption use this unit</small></span><select value={value.fabric_uom} onChange={e => onChange({ ...value, fabric_uom: e.target.value as 'mtr' | 'kg' })}><option value="mtr">Metres (INR/mtr)</option><option value="kg">Kilograms (INR/kg)</option></select></label>
    </div></fieldset>
    <div className="scw-fabric-master"><strong>Fabric Cost — owned by the Fabric Cost master</strong><dl>{[['Grey rate',rate?.grey],['Processing',rate?.processing],[`Finished fabric (INR/${value.fabric_uom})`,rate?.finished]].map(([label,n]) => <div key={String(label)}><dt>{label}</dt><dd>{display(n as number | null | undefined)}</dd></div>)}</dl><a className="wf-btn wf-btn-ghost wf-btn-sm" href="/fabric-cost">Edit on Fabric Cost →</a></div>
    {visibleColours.map(colour => {
      const sizes = sizesFor(colour);
      return <div key={colour} className="scw-fabric-size-group">{visibleColours.length > 1 && <h3>{colour || 'Unspecified colour'}</h3>}<div className="table-scroll"><table className="wf-grid scw-fabric-size-grid"><thead><tr><th>Size</th>{sizes.map(size => <th key={size}>{size}</th>)}</tr></thead><tbody><tr><th>Consumption<small>({value.fabric_uom}) · team fills</small></th>{sizes.map(size => { const line = value.lines.find(item => item.colour === colour && item.size === size); return <td key={size}><input aria-label={`Consumption ${colour} ${size}`} type="number" min="0" step="any" disabled={disabled} value={line?.consumption ?? ''} onChange={e => sizeConsumption(colour,size,e.target.value)} /></td>; })}</tr><tr className="scw-fabric-calculated"><th>Fabric cost<small>calculated</small></th>{sizes.map(size => <td key={size}>{display(value.lines.find(item => item.colour === colour && item.size === size)?.fabric_cost)}</td>)}</tr></tbody></table></div></div>;
    })}
    <p className="scw-fabric-explanation"><span>INPUT</span> <span>COMPUTED</span> Fabric cost = finished-fabric rate × consumption, in the selected unit. The rate is owned by the Fabric Cost master.{rate?.finished == null && ' Choose a fabric with a finished rate to calculate costs.'}</p>
  </div>;
}
