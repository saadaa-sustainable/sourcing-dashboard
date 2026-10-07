// Data scope shared by every PO / GRN read (decided 2026-10-07): only POs created under the
// SAADAA warehouse count. The database views apply it (sd_po_filtered, sd_ee_grn_saadaa, the
// vendor views); this constant is for the few reads that go to the raw PO table directly.
// Plain module: safe on server and client.
export const SAADAA_PO_WAREHOUSE = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED';
