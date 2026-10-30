/** Include the row being entered when saving, even if Add row was never clicked. */
export function materialDraftRows<T extends { material_code: string; job_qty: string; purchase_qty: string }>(
  rows: T[], entry: T | null,
): T[] {
  if (!entry) return rows;
  if (rows.some((row) => row.material_code === entry.material_code)) {
    throw new Error('This material code is already on the plan. Edit its existing row.');
  }
  for (const quantity of [entry.job_qty, entry.purchase_qty]) {
    if (!Number.isFinite(Number(quantity)) || Number(quantity) < 0) {
      throw new Error('Enter valid, non-negative material quantities.');
    }
  }
  return [...rows, entry];
}
