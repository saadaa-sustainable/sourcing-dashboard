import os

from dotenv import load_dotenv
from google.cloud import bigquery
from supabase import create_client


# ============================================================
# CONFIG
# ============================================================

# Load .env from the same folder as this script
from pathlib import Path

ENV_FILE = Path(__file__).resolve().with_name(".env")
load_dotenv(dotenv_path=ENV_FILE)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

GCP_PROJECT = "saadaa-wh"

BQ_TABLE = (
    "saadaa-wh.MAPLEMONK.saadaa_purchase_order_fact_items"
)

# IMPORTANT:
# Finished Good PO Closer uses its own isolated schema.
SUPABASE_SCHEMA = "FG Closer"
SUPABASE_TABLE = "saadaa_purchase_order_fact_items"

BATCH_SIZE = 500


# ============================================================
# VALIDATE CONFIG
# ============================================================

if not SUPABASE_URL:
    raise RuntimeError("SUPABASE_URL is missing.")

if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        "SUPABASE_SERVICE_ROLE_KEY is missing."
    )


# ============================================================
# CLIENTS
# ============================================================

bq_client = bigquery.Client(project=GCP_PROJECT)

supabase = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
)


# ============================================================
# FETCH DATA FROM BIGQUERY
# ============================================================

def fetch_from_bigquery():

    print("Connecting to BigQuery...")

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
        WHERE po_created_date >= DATETIME('2026-04-01 00:00:00')
    """

    print("Running BigQuery query...")
    print(f"Source: {BQ_TABLE}")
    print("Filter: PO Created Date >= 2026-04-01")

    query_job = bq_client.query(query)

    rows = query_job.result()

    records = []

    for row in rows:

        record = {
            "po_number": row.po_number,

            "po_created_date": (
                row.po_created_date.isoformat()
                if row.po_created_date
                else None
            ),

            "po_date": (
                row.po_date.isoformat()
                if row.po_date
                else None
            ),

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

            "po_created_location_key": (
                row.po_created_location_key
            ),

            "po_created_warehouse_c_id": (
                row.po_created_warehouse_c_id
            ),

            "vendor_name": row.vendor_name,

            "vendor_code": row.vendor_code,

            "expected_delivery_date": (
                row.expected_delivery_date
            ),

            "po_ref_num": row.po_ref_num,

            "completed_at_timestamp": (
                row.completed_at_timestamp.isoformat()
                if row.completed_at_timestamp
                else None
            ),
        }

        records.append(record)

    print(
        f"Fetched {len(records):,} rows from BigQuery."
    )

    return records


# ============================================================
# UPSERT INTO SUPABASE
# ============================================================

def insert_into_supabase(records):

    total = len(records)

    print(
        f"Starting Supabase upload: {total:,} rows"
    )

    uploaded = 0

    for start in range(0, total, BATCH_SIZE):

        batch = records[
            start:start + BATCH_SIZE
        ]

        (
            supabase
            .schema(SUPABASE_SCHEMA)
            .table(SUPABASE_TABLE)
            .upsert(
                batch,
                on_conflict="po_detail_id"
            )
            .execute()
        )

        uploaded += len(batch)

        print(
            f"Uploaded {uploaded:,} / {total:,}"
        )

    print(
        f"Successfully loaded {uploaded:,} rows."
    )


# ============================================================
# MAIN
# ============================================================

def main():

    print("=" * 60)
    print("PO GCP → FG CLOSER SUPABASE SYNC")
    print("=" * 60)

    print(f"Source      : {BQ_TABLE}")
    print(f"Destination : {SUPABASE_SCHEMA}.{SUPABASE_TABLE}")
    print("PO Created  : >= 2026-04-01")

    records = fetch_from_bigquery()

    if not records:
        print("No records found.")
        return

    insert_into_supabase(records)

    print("=" * 60)
    print("SYNC COMPLETED")
    print("=" * 60)


if __name__ == "__main__":
    main()