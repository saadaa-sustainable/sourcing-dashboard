import { addTnaDays } from '@/lib/business-logic';

type TnaRow<Key extends string> = { key: Key; label: string; days: string; standardDays: number | null };
export function PoTnaTable<Key extends string>({ rows, baseDate, onDaysChange }: {
  rows: TnaRow<Key>[];
  baseDate: string | null;
  onDaysChange: (key: Key, value: string) => void;
}) {
  return (
    <div className="poa-tna-table-wrap">
      <table className="poa-tna-table" aria-label="Timeline TNA critical path">
        <thead><tr><th scope="col">TNA Critical Path</th><th scope="col">Standard Days</th><th scope="col">Date</th></tr></thead>
        <tbody>{rows.map(row => {
          const value = Number(row.days);
          const valid = row.days.trim() !== '' && Number.isInteger(value) && value >= 0;
          const date = valid ? addTnaDays(baseDate, value) : null;
          return (
            <tr key={row.key}>
              <th scope="row"><label htmlFor={`po-tna-${row.key}`}>{row.label} <span className="poa-tna-required" aria-label="required">*</span></label></th>
              <td>
                <input id={`po-tna-${row.key}`} type="number" required aria-required="true" min={0} step={1} value={row.days} placeholder={row.standardDays != null ? String(row.standardDays) : 'Days'} onChange={event => onDaysChange(row.key, event.target.value)} aria-label={`${row.label} standard days`} />
                {row.standardDays != null && <small>Default: {row.standardDays} days</small>}
              </td>
              <td>
                <input
                  type="date"
                  className="poa-tna-date"
                  required
                  aria-required="true"
                  aria-label={`${row.label} date`}
                  min={baseDate?.slice(0, 10)}
                  value={date ?? ''}
                  disabled={!baseDate}
                  onChange={event => {
                    if (!event.target.value) { onDaysChange(row.key, ''); return; }
                    if (!baseDate) return;
                    const base = Date.parse(`${baseDate.slice(0, 10)}T00:00:00Z`);
                    const selected = event.target.valueAsNumber;
                    const days = Math.round((selected - base) / 86_400_000);
                    if (Number.isFinite(days) && days >= 0) onDaysChange(row.key, String(days));
                  }}
                />
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
