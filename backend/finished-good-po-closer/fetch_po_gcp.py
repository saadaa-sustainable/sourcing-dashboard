
import os
from pathlib import Path
from datetime import date, datetime

from dotenv import load_dotenv
from google.cloud import bigquery
from supabase import create_client


# ============================================================
# CONFIG
# ============================================================

# Script location:
# project_root/backend/finished-good-po-closer/fetch_po_gcp.py
#
# Therefore parents[2] = project root.
ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env.local"

if not ENV_FILE.is_file():
    raise FileNotFoundError(
        f".env.local not found at: {ENV_FILE}\n"
        "Expected .env.local in the project root."
    )

# Load root-level environment variables.
load_dotenv(dotenv_path=ENV_FILE, override=False)

SUPABASE_URL = (
    os.getenv("SUPABASE_URL")
    or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    or ""
).strip().rstrip("/")

SUPABASE_SERVICE_ROLE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
).strip()

GCP_PROJECT = "saadaa-wh"

BQ_TABLE = (
    "saadaa-wh.MAPLEMONK.saadaa_purchase_order_fact_items"
)

SUPABASE_SCHEMA = "FG Closer"
SUPABASE_TABLE = "saadaa_purchase_order_fact_items"

BATCH_SIZE = 500

# Keep the existing source filter.
PO_CREATED_DATE_FILTER = "2026-04-01"


# ============================================================
# VALIDATE CONFIG
# ============================================================

if not SUPABASE_URL:
    raise RuntimeError(
        f"SUPABASE_URL and NEXT_PUBLIC_SUPABASE_URL are missing "
        f"from {ENV_FILE}."
    )

if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        f"SUPABASE_SERVICE_ROLE_KEY is missing from {ENV_FILE}."
    )


# ============================================================
# CLIENTS
# ============================================================

print(f"Environment file: {ENV_FILE}")
print(f"Supabase URL: {SUPABASE_URL}")
print(f"Supabase schema: {SUPABASE_SCHEMA}")
print(f"Supabase table: {SUPABASE_TABLE}")

bq_client = bigquery.Client(project=GCP_PROJECT)

supabase = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
)


# ============================================================
# HELPERS
# ============================================================

def to_iso(value):
    """Convert date/datetime values into JSON-safe ISO strings."""
    if value is None:
        return None

    if isinstance(value, (datetime, date)):
        return value.isoformat()

    return value


# ============================================================
# FETCH DATA FROM BIGQUERY
# ============================================================

def fetch_from_bigquery():

    print("\nConnecting to BigQuery...")
    print(f"Source: {BQ_TABLE}")
    print(f"PO Created Date >= {PO_CREATED_DATE_FILTER}")

    query = f"""
        SELECT
            po_number,
            po_created_date,
            po_date,
            item_price,
            po_id,
            sku,
            product_description,
            cp_id,
            po_detail_id,
            original_quantity,
            pending_quantity,
            size,
            po_status,
            po_created_warehouse,
            po_created_location_key,
            po_created_warehouse_c_id,
            vendor_name,
            vendor_code,
            expected_delivery_date,
            po_ref_num,
            completed_at_timestamp
        FROM `{BQ_TABLE}`
        WHERE po_created_date >=
            DATETIME('{PO_CREATED_DATE_FILTER} 00:00:00')
    """

    print("Running BigQuery query...")

    query_job = bq_client.query(query)
    rows = query_job.result()

    records = []

    for row in rows:
        record = {
            "po_number": row.po_number,
            "po_created_date": to_iso(row.po_created_date),
            "po_date": to_iso(row.po_date),
            "item_price": row.item_price,
            "po_id": row.po_id,
            "sku": row.sku,
            "product_description": row.product_description,
            "cp_id": row.cp_id,
            "po_detail_id": row.po_detail_id,
            "original_quantity": row.original_quantity,
            "pending_quantity": row.pending_quantity,
            "size": row.size,
            "po_status": row.po_status,
            "po_created_warehouse": row.po_created_warehouse,
            "po_created_location_key": row.po_created_location_key,
            "po_created_warehouse_c_id": row.po_created_warehouse_c_id,
            "vendor_name": row.vendor_name,
            "vendor_code": row.vendor_code,
            "expected_delivery_date": to_iso(
                row.expected_delivery_date
            ),
            "po_ref_num": row.po_ref_num,
            "completed_at_timestamp": to_iso(
                row.completed_at_timestamp
            ),
        }

        records.append(record)

    print(f"Fetched {len(records):,} rows from BigQuery.")

    return records


# ============================================================
# UPSERT INTO SUPABASE
# ============================================================

def upsert_into_supabase(records):

    total = len(records)

    if total == 0:
        print("No records to upload.")
        return

    print(
        f"\nStarting Supabase upsert: {total:,} rows"
    )
    print(
        f"Target: {SUPABASE_SCHEMA}.{SUPABASE_TABLE}"
    )
    print("Conflict key: po_detail_id")

    uploaded = 0

    for start in range(0, total, BATCH_SIZE):
        batch = records[start:start + BATCH_SIZE]
        batch_number = (start // BATCH_SIZE) + 1

        print(
            f"Uploading batch {batch_number}: "
            f"{len(batch):,} rows..."
        )

        (
            supabase
            .schema(SUPABASE_SCHEMA)
            .table(SUPABASE_TABLE)
            .upsert(
                batch,
                on_conflict="po_detail_id",
            )
            .execute()
        )

        uploaded += len(batch)

        print(f"Progress: {uploaded:,} / {total:,}")

    print(
        f"\nSuccessfully upserted {uploaded:,} rows into "
        f"{SUPABASE_SCHEMA}.{SUPABASE_TABLE}."
    )


# ============================================================
# MAIN
# ============================================================

def main():

    print("=" * 65)
    print("PO GCP → FG CLOSER SUPABASE SYNC")
    print("=" * 65)

    print(f"Project root : {ROOT}")
    print(f"Environment  : {ENV_FILE}")
    print(f"Source       : {BQ_TABLE}")
    print(f"Destination  : {SUPABASE_SCHEMA}.{SUPABASE_TABLE}")
    print(f"PO Created   : >= {PO_CREATED_DATE_FILTER}")

    records = fetch_from_bigquery()

    if not records:
        print("\nNo records found in BigQuery. Nothing to upload.")
        return

    upsert_into_supabase(records)

    print("\n" + "=" * 65)
    print("SYNC COMPLETED")
    print("=" * 65)


if __name__ == "__main__":
    main()
