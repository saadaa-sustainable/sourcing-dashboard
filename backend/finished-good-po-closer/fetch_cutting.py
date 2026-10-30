import os
from pathlib import Path
from datetime import date, datetime
from decimal import Decimal

from dotenv import load_dotenv
from google.cloud import bigquery
from supabase import create_client


# ============================================================
# CONFIGURATION
# ============================================================

# Project structure:
# sourcing-dashboard-fg-closer/
# ├── .env.local
# └── backend/
#     └── finished-good-po-closer/
#         └── fetch_cutting.py

# Resolve the project root independently of the terminal location.
ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env.local"

if not ENV_FILE.is_file():
    raise FileNotFoundError(
        f".env.local not found at:\n{ENV_FILE}"
    )

load_dotenv(dotenv_path=ENV_FILE, override=False)

# Support either Supabase URL variable name.
SUPABASE_URL = (
    os.getenv("SUPABASE_URL")
    or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    or ""
).strip().rstrip("/")

SUPABASE_SERVICE_ROLE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
).strip()

GCP_PROJECT = "saadaa-wh"
BQ_TABLE = "saadaa-wh.MAPLEMONK.po_qty_cutting_register"

# Finished Good PO Closer schema and destination table.
SUPABASE_SCHEMA = "FG Closer"
SUPABASE_TABLE = "po_qty_cutting_register"

BATCH_SIZE = 500

# This script performs a FULL REFRESH:
# 1. Fetch the complete source dataset from BigQuery.
# 2. Only after confirming source data exists, clear the destination table.
# 3. Insert the complete fetched dataset into Supabase.
#
# This prevents yesterday's rows from remaining alongside today's
# complete source snapshot and doubling cutting quantities.


# ============================================================
# VALIDATE CONFIGURATION
# ============================================================

if not SUPABASE_URL:
    raise RuntimeError(
        "Supabase URL is missing from .env.local.\n"
        "Add SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL."
    )

if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        "SUPABASE_SERVICE_ROLE_KEY is missing from .env.local."
    )


# ============================================================
# CLIENTS
# ============================================================

def create_bigquery_client():
    print("Initializing BigQuery client...")
    return bigquery.Client(project=GCP_PROJECT)


def create_supabase_client():
    print("Initializing Supabase client...")
    return create_client(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
    )


# ============================================================
# VALUE CONVERSION
# ============================================================

def serialize_value(value):
    """Convert BigQuery values into JSON-compatible values."""

    if value is None:
        return None

    if isinstance(value, (datetime, date)):
        return value.isoformat()

    if isinstance(value, Decimal):
        # Preserve numeric precision. Postgres can cast numeric strings.
        return str(value)

    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")

    return value


# ============================================================
# FETCH FROM BIGQUERY
# ============================================================

def fetch_from_bigquery(bq_client):
    print("\nConnecting to BigQuery...")
    print(f"Project: {GCP_PROJECT}")
    print(f"Source:  {BQ_TABLE}")

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

    query_job = bq_client.query(query)
    rows = query_job.result()

    records = []

    for row in rows:
        record = {
            "date_of_cutting": serialize_value(row.date_of_cutting),
            "vendor_code": serialize_value(row.vendor_code),
            "po_number": serialize_value(row.po_number),
            "fabric_sku_code": serialize_value(row.fabric_sku_code),
            "item_code": serialize_value(row.item_code),
            "cutting_qty": serialize_value(row.cutting_qty),
            "avg_fabric_consumption_approved": serialize_value(
                row.avg_fabric_consumption_approved
            ),
            "width_of_fabric": serialize_value(row.width_of_fabric),
            "cutting_approval_sheet": serialize_value(
                row.cutting_approval_sheet
            ),
            "remarks_of_cutting": serialize_value(row.remarks_of_cutting),
            "fabric_consumed": serialize_value(row.fabric_consumed),
            "type_of_po": serialize_value(row.type_of_po),
            "date_of_ingestion": serialize_value(row.date_of_ingestion),
            "ingestion_by": serialize_value(row.ingestion_by),
        }

        records.append(record)

    print(f"Fetched {len(records):,} rows from BigQuery.")

    return records


# ============================================================
# SUPABASE TABLE HELPERS
# ============================================================

def get_supabase_row_count(supabase):
    """Return the exact number of rows currently in the destination."""

    response = (
        supabase
        .schema(SUPABASE_SCHEMA)
        .table(SUPABASE_TABLE)
        .select("item_code", count="exact", head=True)
        .execute()
    )

    return response.count or 0


def clear_supabase_table(supabase):
    """
    Delete every row from the destination table.

    PostgREST requires a filter for DELETE. These two complementary
    filters cover both non-NULL and NULL item_code rows, so no records
    are left behind. The second request runs only if the first succeeds.
    """

    print("\nClearing existing Supabase cutting data...")
    print(f"Target: {SUPABASE_SCHEMA}.{SUPABASE_TABLE}")

    table = supabase.schema(SUPABASE_SCHEMA).table(SUPABASE_TABLE)

    # Delete rows with a non-NULL item_code.
    table.delete().not_.is_("item_code", "null").execute()

    # Delete any rows whose item_code is NULL.
    table.delete().is_("item_code", "null").execute()

    remaining = get_supabase_row_count(supabase)

    if remaining != 0:
        raise RuntimeError(
            "Full refresh stopped: destination table is not empty "
            f"after DELETE. Remaining rows: {remaining:,}. "
            "No new data has been inserted."
        )

    print("Existing destination rows cleared successfully.")
    print("Verified destination row count: 0")


# ============================================================
# INSERT INTO SUPABASE
# ============================================================

def insert_into_supabase(supabase, records):
    total = len(records)

    if total == 0:
        print("No records to upload.")
        return 0

    print("\nStarting Supabase upload...")
    print(f"Rows:   {total:,}")
    print(f"Target: {SUPABASE_SCHEMA}.{SUPABASE_TABLE}")
    print(f"Batch:  {BATCH_SIZE:,}")

    uploaded = 0

    for start in range(0, total, BATCH_SIZE):
        batch = records[start:start + BATCH_SIZE]
        batch_number = (start // BATCH_SIZE) + 1

        print(
            f"\nUploading batch {batch_number}: "
            f"{len(batch):,} rows..."
        )

        (
            supabase
            .schema(SUPABASE_SCHEMA)
            .table(SUPABASE_TABLE)
            .insert(batch)
            .execute()
        )

        uploaded += len(batch)
        print(f"Progress: {uploaded:,} / {total:,}")

    print(
        f"\nSuccessfully inserted {uploaded:,} rows into "
        f"{SUPABASE_SCHEMA}.{SUPABASE_TABLE}."
    )

    return uploaded


# ============================================================
# VERIFY FULL REFRESH
# ============================================================

def verify_supabase_upload(supabase, expected_rows):
    print("\nVerifying Supabase destination...")

    actual_rows = get_supabase_row_count(supabase)

    print(f"BigQuery source rows: {expected_rows:,}")
    print(f"Supabase table rows:  {actual_rows:,}")

    if actual_rows != expected_rows:
        raise RuntimeError(
            "Upload verification failed: source and destination "
            f"row counts differ (source={expected_rows:,}, "
            f"destination={actual_rows:,})."
        )

    print("Row-count verification passed.")


# ============================================================
# MAIN
# ============================================================

def main():
    print("=" * 65)
    print("FINISHED GOOD PO CLOSER")
    print("CUTTING BIGQUERY -> SUPABASE FULL REFRESH")
    print("=" * 65)

    print(f"Project root:     {ROOT}")
    print(f"Environment file: {ENV_FILE}")
    print(f"BigQuery source:  {BQ_TABLE}")
    print(f"Supabase schema:  {SUPABASE_SCHEMA}")
    print(f"Supabase table:   {SUPABASE_TABLE}")

    bq_client = create_bigquery_client()
    supabase = create_supabase_client()

    # Fetch first. Never clear Supabase if BigQuery returns no data.
    records = fetch_from_bigquery(bq_client)

    if not records:
        print(
            "\nBigQuery returned 0 records. "
            "Supabase was NOT cleared or modified."
        )
        return

    # Clear old snapshot only after a successful, non-empty source fetch.
    clear_supabase_table(supabase)

    # Insert the complete source snapshot.
    uploaded = insert_into_supabase(supabase, records)

    # Confirm the destination contains exactly the source row count.
    verify_supabase_upload(supabase, uploaded)

    print("\n" + "=" * 65)
    print("CUTTING FULL REFRESH COMPLETED SUCCESSFULLY")
    print("=" * 65)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\nERROR: {exc}")
        raise
