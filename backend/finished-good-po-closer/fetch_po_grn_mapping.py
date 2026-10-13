import os
from pathlib import Path

from dotenv import load_dotenv
from google.cloud import bigquery
from supabase import create_client


# ============================================================
# CONFIG
# ============================================================

# Load .env from the same folder as this script
ENV_FILE = Path(__file__).resolve().with_name(".env")
load_dotenv(dotenv_path=ENV_FILE)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

GCP_PROJECT = "saadaa-wh"

BQ_TABLE = (
    "saadaa-wh.MAPLEMONK.saadaa_po_grn_mapping"
)

# Finished Good PO Closer isolated schema
SUPABASE_SCHEMA = "FG Closer"
SUPABASE_TABLE = "saadaa_po_grn_mapping"

# Same date scope used for the BigQuery fetch
SYNC_FROM_DATE = "2026-04-01"

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
            po_created_date,
            po_detail_id,
            po_id,
            po_number,
            cp_id,
            sku,
            size,
            product_description,
            po_created_warehouse,
            po_created_location_key,
            po_status,
            vendor_name,
            vendor_code,
            expected_delivery_date,
            grn_id,
            po_ref_num,
            grn_status,
            grn_created_date,
            grn_invoice_date,
            grn_invoice_number,
            last_grn_date,
            PO_Type,
            po_original_quantity,
            po_pending_quantity,
            total_grn_value,
            grn_receive_quantity
        FROM `{BQ_TABLE}`
        WHERE po_created_date >= DATE '{SYNC_FROM_DATE}'
    """

    print("Running BigQuery query...")
    print(f"Source: {BQ_TABLE}")
    print(
        f"Filter : PO Created Date >= {SYNC_FROM_DATE}"
    )

    query_job = bq_client.query(query)

    rows = query_job.result()

    records = []

    for row in rows:

        record = {
            "po_created_date": (
                row.po_created_date.isoformat()
                if row.po_created_date
                else None
            ),

            "po_detail_id": row.po_detail_id,
            "po_id": row.po_id,
            "po_number": row.po_number,
            "cp_id": row.cp_id,
            "sku": row.sku,
            "size": row.size,
            "product_description": row.product_description,

            "po_created_warehouse": (
                row.po_created_warehouse
            ),

            "po_created_location_key": (
                row.po_created_location_key
            ),

            "po_status": row.po_status,
            "vendor_name": row.vendor_name,
            "vendor_code": row.vendor_code,

            "expected_delivery_date": (
                row.expected_delivery_date
            ),

            "grn_id": row.grn_id,
            "po_ref_num": row.po_ref_num,
            "grn_status": row.grn_status,

            "grn_created_date": (
                row.grn_created_date.isoformat()
                if row.grn_created_date
                else None
            ),

            "grn_invoice_date": (
                row.grn_invoice_date.isoformat()
                if row.grn_invoice_date
                else None
            ),

            "grn_invoice_number": (
                row.grn_invoice_number
            ),

            "last_grn_date": (
                row.last_grn_date.isoformat()
                if row.last_grn_date
                else None
            ),

            "po_type": row.PO_Type,

            "po_original_quantity": (
                row.po_original_quantity
            ),

            "po_pending_quantity": (
                row.po_pending_quantity
            ),

            "total_grn_value": (
                row.total_grn_value
            ),

            "grn_receive_quantity": (
                row.grn_receive_quantity
            ),
        }

        records.append(record)

    print(
        f"Fetched {len(records):,} rows from BigQuery."
    )

    return records


# ============================================================
# DELETE EXISTING SYNC-SCOPE DATA
# ============================================================

def clear_existing_records():

    print(
        "Removing existing Supabase records "
        f"where po_created_date >= {SYNC_FROM_DATE}..."
    )

    (
        supabase
        .schema(SUPABASE_SCHEMA)
        .table(SUPABASE_TABLE)
        .delete()
        .gte(
            "po_created_date",
            SYNC_FROM_DATE
        )
        .execute()
    )

    print(
        "Existing sync-scope records removed."
    )


# ============================================================
# INSERT FRESH DATA INTO SUPABASE
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
            .insert(batch)
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
    print(
        "PO-GRN MAPPING GCP → FG CLOSER SUPABASE SYNC"
    )
    print("=" * 60)

    print(f"Source      : {BQ_TABLE}")
    print(
        f"Destination : "
        f"{SUPABASE_SCHEMA}.{SUPABASE_TABLE}"
    )
    print(
        f"PO Created  : >= {SYNC_FROM_DATE}"
    )

    # --------------------------------------------------------
    # STEP 1: Fetch fresh data from BigQuery
    # --------------------------------------------------------

    records = fetch_from_bigquery()

    if not records:
        print(
            "No records found in BigQuery. "
            "Supabase was NOT modified."
        )
        return

    # --------------------------------------------------------
    # STEP 2: Remove previous records from same scope
    # --------------------------------------------------------

    clear_existing_records()

    # --------------------------------------------------------
    # STEP 3: Insert fresh BigQuery data
    # --------------------------------------------------------

    insert_into_supabase(records)

    print("=" * 60)
    print("SYNC COMPLETED")
    print("=" * 60)


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()