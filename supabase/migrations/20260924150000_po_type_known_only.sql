-- po_type is parsed out of the PO reference — `FY26-27/EFOB/SDFLK/KVN-03` → EFOB, the
-- second slash-separated part. That holds for a sourcing PO, but EasyEcom also raises its
-- own auto stock-transfer POs whose reference is `Auto PO STN/1740151789533666321`, and the
-- same parse turned that timestamp id into a "PO type". It then appeared as a column header
-- on the Vendor × PO type pivot, which is where it was spotted.
--
-- So: only the three real types are types. Anything else is OTHER, which reads as what it
-- is instead of leaking an internal id into the UI. The reference itself is untouched.

create or replace view public.sd_po_dashboard as
select po_detail_id, po_id, po_number, po_ref_num,
  case upper(split_part(po_ref_num, '/'::text, 2))
    when 'JOB'  then 'JOB'
    when 'FOB'  then 'FOB'
    when 'EFOB' then 'EFOB'
    else 'OTHER'
  end as po_type,
  po_status_code, po_status, vendor_code, vendor_name, warehouse,
  sku, product_id, product_code, product_variant, size, product_description,
  original_qty::double precision as original_qty,
  pending_qty::double precision  as pending_qty,
  item_price::double precision   as item_price,
  total_po_value::double precision as total_po_value,
  po_date::text as po_date,
  po_updated_date,
  expected_delivery_date::text as expected_delivery_date,
  ingested_at
from public.sd_po_filtered
where po_status = 'Approved'::text;
