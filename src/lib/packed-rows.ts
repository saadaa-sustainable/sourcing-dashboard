/**
 * Big tables sent from a server page to a client component repeat every column name on every
 * row: 7,500 product-master rows × 46 keys made a 10.8 MB page. Packed, the keys travel once
 * and each row is a plain list of values — the browser rebuilds the objects.
 *
 * Plain module (no 'use client' / 'server-only'): both sides import it.
 */
export type PackedRows<T> = { keys: (keyof T & string)[]; rows: unknown[][] };

/** Pack rows, keeping only `keys` (every key of the first row when omitted). */
export function packRows<T extends object>(rows: T[], keys?: (keyof T & string)[]): PackedRows<T> {
  const k = keys ?? ((rows[0] ? Object.keys(rows[0]) : []) as (keyof T & string)[]);
  return {
    keys: k,
    rows: rows.map((r) => k.map((key) => (r as Record<string, unknown>)[key] ?? null)),
  };
}

export function unpackRows<T>(p: PackedRows<T>): T[] {
  return p.rows.map((vals) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < p.keys.length; i++) o[p.keys[i]] = vals[i];
    return o as T;
  });
}
