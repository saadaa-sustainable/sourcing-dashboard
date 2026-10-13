import os
from pathlib import Path

from dotenv import load_dotenv
from google.cloud import bigquery
from supabase import create_client


# ============================================================
# CONFIG
# ============================================================

# Always load the .env that belongs to this Finished Good
# backend folder, regardless of where the script is executed from.
ENV_FILE = Path(__file__).resolve().with_name(".env")
load_dotenv(dotenv_path=ENV_FILE)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

GCP_PROJECT = "saadaa-wh"

BQ_TABLE = "saadaa-wh.MAPLEMONK.po_qty_cutting_register"

# Finished Good PO Closer has its own isolated Supabase schema.
SUPABASE_SCHEMA = "FG Closer"
SUPABASE_TABLE = "po_qty_cutting_register"

BATCH_SIZE = 500


# ============================================================
# VALIDATE CONFIG
# ============================================================

if not SUPABASE_URL:
    raise RuntimeError(
        "SUPABASE_URL is missing from the Finished Good PO Closer .env file."
    )

if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        "SUPABASE_SERVICE_ROLE_KEY is missing from the Finished Good PO Closer .env file."
    )


# ============================================================
# CLIENTS
# ============================================================

bq_client = bigquery.Client(project=GCP_PROJECT)

supabase = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
)


# ============================================================
# FETCH FROM BIGQUERY
# ============================================================

def fetch_from_bigquery():

    print("Connecting to BigQuery...")

    query = f"""
        SELECT
            date_of_cutting,
            vendor_code,
            po_number,
            fabric_sku_code,
            item_code,
            cutting_qty,
            avg_fabric_consumption_approved,
            width_of_fabric,
            cutting_approval_sheet,
            remarks_of_cutting,
            fabric_consumed,
            type_of_po,
            date_of_ingestion,
            ingestion_by
        FROM `{BQ_TABLE}`
    """

    print("Running BigQuery query...")
    print(f"Source: {BQ_TABLE}")

    query_job = bq_client.query(query)
    rows = query_job.result()

    records = []

    for row in rows:

        record = {
            "date_of_cutting": (
                row.date_of_cutting.isoformat()
                if row.date_of_cutting
                else None
            ),

            "vendor_code": row.vendor_code,
            "po_number": row.po_number,
            "fabric_sku_code": row.fabric_sku_code,
            "item_code": row.item_code,
            "cutting_qty": row.cutting_qty,

            "avg_fabric_consumption_approved": (
                row.avg_fabric_consumption_approved
            ),

            "width_of_fabric": row.width_of_fabric,
            "cutting_approval_sheet": row.cutting_approval_sheet,
            "remarks_of_cutting": row.remarks_of_cutting,

            "fabric_consumed": row.fabric_consumed,
            "type_of_po": row.type_of_po,

            "date_of_ingestion": (
                row.date_of_ingestion.isoformat()
                if row.date_of_ingestion
                else None
            ),

            "ingestion_by": row.ingestion_by,
        }

        records.append(record)

    print(
        f"Fetched {len(records):,} rows from BigQuery."
    )

    return records


# ============================================================
# INSERT INTO SUPABASE
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
        f"Successfully loaded {uploaded:,} rows into "
        f"{SUPABASE_SCHEMA}.{SUPABASE_TABLE}."
    )


# ============================================================
# MAIN
# ============================================================

def main():

    print("=" * 60)
    print("FINISHED GOOD PO CLOSER")
    print("CUTTING GCP → SUPABASE INITIAL SYNC")
    print("=" * 60)

    print(f"Supabase schema : {SUPABASE_SCHEMA}")
    print(f"Supabase table  : {SUPABASE_TABLE}")
    print(f"BigQuery source : {BQ_TABLE}")

    records = fetch_from_bigquery()

    if not records:
        print("No records found.")
        return

    insert_into_supabase(records)

    print("=" * 60)
    print("INITIAL SYNC COMPLETED")
    print("=" * 60)


if __name__ == "__main__":
    main()