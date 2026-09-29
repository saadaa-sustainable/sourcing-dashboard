/**
 * One key for one SKU, whichever source spelt it.
 *
 * The product master (and the team's sheets) write a SKU as CODE_SIZE — SDCPBL_S. The
 * nightly stock feed (sd_inventory_planning) writes the same SKU as SDCPBLS. Any list
 * keyed by SKU that has to meet the feed — the OOS exclusion list above all — must
 * compare on this key, not on the raw text, or nothing ever matches.
 */
export function skuKey(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
