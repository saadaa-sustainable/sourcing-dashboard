import 'server-only';
import { cache } from 'react';
import { client, pageAll } from '@/lib/forms/queries-modules/_shared';
import { buildComplianceMonth, completeHistoryStart, complianceKey, type ComplianceInput, type MasterSnapshot } from './vendor-capacity-compliance';

type Db = Awaited<ReturnType<typeof client>>;
type Master = MasterSnapshot & { vendor_code: string };
type Audit = { id: number; table_name: string; changed_at: string; op: string; before: MasterSnapshot & Capacity | null; after: MasterSnapshot & Capacity | null };
type Capacity = { vendor_code?: string; machines_allocated?: number | null; active_karigar?: number | null; entry_date?: string | null; submitted_at?: string | null };
export async function readComplianceInput(db: Db, now = new Date().toISOString()): Promise<ComplianceInput> {
  const [masters, logs, history, deboarded] = await Promise.all([
    pageAll<Master>(() => db.from('vendor_master_data').select('vendor_code, vendor_name, merchant_name, onboarding_date, ee_status, is_active').order('vendor_code')),
    pageAll<Capacity>(() => db.from('sd_vendor_capacity_log').select('vendor_code, machines_allocated, active_karigar, entry_date, submitted_at').order('id')),
    pageAll<Audit>(() => db.from('sd_audit_log').select('id, table_name, changed_at, op, before, after').in('table_name', ['vendor_master_data', 'sd_vendor_capacity_log']).order('id')),
    pageAll<{ vendor_code: string; approved_at: string | null }>(() => db.from('sd_vendor_deboarding_request').select('vendor_code, approved_at').eq('status', 'approved').order('id')),
  ]);
  const deboardedAt = new Map(deboarded.filter((d) => d.approved_at).map((d) => [complianceKey(d.vendor_code), d.approved_at]));
  const changes = history.filter((h) => h.table_name === 'vendor_master_data').map((h) => ({
    at: h.changed_at, code: h.after?.vendor_code ?? h.before?.vendor_code ?? '', before: h.before, after: h.after,
  }));
  // Preserve deleted vendors in historical denominators; reverse the audit trail to recover their state.
  const currentCodes = new Set(masters.map((m) => complianceKey(m.vendor_code)));
  for (const h of [...history].reverse()) if (h.table_name === 'vendor_master_data' && h.before?.vendor_code && !currentCodes.has(complianceKey(h.before.vendor_code))) {
    masters.push({ ...h.before, vendor_code: h.before.vendor_code, ee_status: 'inactive', is_active: false });
    currentCodes.add(complianceKey(h.before.vendor_code));
  }
  const valid = (row: Capacity | null) => row && row.vendor_code && [row.machines_allocated, row.active_karigar].every((v) => v != null && Number.isInteger(Number(v)) && Number(v) >= 0);
  const updates: ComplianceInput['updates'] = [];
  const append = (row: Capacity | null) => { if (!valid(row)) return; const at = row!.entry_date ?? row!.submitted_at; if (at) updates.push({ code: row!.vendor_code!, at }); };
  logs.forEach(append);
  for (const h of history) if (h.table_name === 'sd_vendor_capacity_log') { append(h.before); if (h.op !== 'DELETE') append(h.after); }
  const first = (table: string) => history.filter((h) => h.table_name === table && Date.parse(h.changed_at) <= Date.parse(now)).map((h) => h.changed_at).sort()[0] ?? null;
  const starts = [completeHistoryStart(first('vendor_master_data')), completeHistoryStart(first('sd_vendor_capacity_log'))];
  const coverageStart = starts.every(Boolean) ? (starts as string[]).sort().at(-1)! : null;
  return { now, coverageStart, changes, updates, masters: masters.map((m) => ({ code: m.vendor_code, name: m.vendor_name || m.vendor_code,
    merchant: m.merchant_name?.trim() || 'Unassigned', onboarding: m.onboarding_date ?? null, status: m.ee_status ?? null, isActive: m.is_active === true,
    fallbackActive: m.is_active === true,
    deboardedAt: deboardedAt.get(complianceKey(m.vendor_code)) ?? null })) };
}
export const loadComplianceInput = cache(async () => readComplianceInput(await client()));
export const loadCapacityCompliance = cache(async () => {
  const input = await loadComplianceInput();
  const current = new Date(Date.parse(input.now) + 5.5 * 3600_000).toISOString().slice(0, 7) + '-01';
  const first = input.updates.map((u) => u.at.slice(0, 7) + '-01').sort()[0] ?? current;
  const months = new Set([current]);
  // Include the full known trail, rather than silently discarding older reporting months.
  for (let month = first; month <= current;) {
    months.add(month);
    const d = new Date(`${month}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); month = d.toISOString().slice(0, 10);
  }
  return [...months].sort().reverse().map((month) => buildComplianceMonth(input, month));
});
