
import os
import sys
from pathlib import Path
from datetime import date, datetime

from dotenv import load_dotenv
from google.cloud import bigquery
from supabase import create_client


# ============================================================
# CONFIGURATION
# ============================================================

# File location:
# project_root/backend/finished-good-po-closer/fetch_po_grn_mapping.py
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

# Prefer the project's root .env.local.
# Fall back to root .env or this script folder's .env.
ENV_CANDIDATES = [
    PROJECT_ROOT / ".env.local",
    PROJECT_ROOT / ".env",
    SCRIPT_DIR / ".env",
]

ENV_FILE = next(
    (path for path in ENV_CANDIDATES if path.is_file()),
    None,
)

if ENV_FILE is None:
    raise FileNotFoundError(
        "Could not find an environment file.\n"
        "Expected one of:\n"
        + "\n".join(str(path) for path in ENV_CANDIDATES)
    )

load_dotenv(dotenv_path=ENV_FILE, override=False)

SUPABASE_URL = (
    os.getenv("SUPABASE_URL")
    or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
)

SUPABASE_SERVICE_ROLE_KEY = os.getenv(
    "SUPABASE_SERVICE_ROLE_KEY"
)

GCP_PROJECT = "saadaa-wh"

BQ_TABLE = "saadaa-wh.MAPLEMONK.saadaa_po_grn_mapping"

SUPABASE_SCHEMA = "FG Closer"
SUPABASE_TABLE = "saadaa_po_grn_mapping"

# Refresh records from this date onward.
SYNC_FROM_DATE = "2026-04-01"

BATCH_SIZE = 500
READ_PAGE_SIZE = 1000


# ============================================================
# VALIDATE CONFIGURATION
# ============================================================

if not SUPABASE_URL:
    raise RuntimeError(
        f"SUPABASE_URL is missing. Loaded environment file: {ENV_FILE}"
    )

if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        "SUPABASE_SERVICE_ROLE_KEY is missing. "
        f"Loaded environment file: {ENV_FILE}"
    )

print(f"Environment file: {ENV_FILE}")


# ============================================================
# CLIENTS
# ============================================================

bq_client = bigquery.Client(project=GCP_PROJECT)

supabase = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
)


# ============================================================
# SERIALIZATION HELPERS
# ============================================================

def serialize_value(value):
    """Convert BigQuery date/time values to JSON-compatible values."""

    if value is None:
        return None

    if isinstance(value, (datetime, date)):
        return value.isoformat()

    # BigQuery NUMERIC/BIGNUMERIC values may be Decimal.
    # Keep them numeric where possible.
    if hasattr(value, "as_tuple") and value.__class__.__name__ == "Decimal":
        return float(value)

    return value


# ============================================================
# FETCH DATA FROM BIGQUERY
# ============================================================

def fetch_from_bigquery():
    print("\nConnecting to BigQuery...")
    print(f"Source: {BQ_TABLE}")
    print(f"Filter: PO Created Date >= {SYNC_FROM_DATE}")

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
        WHERE DATE(po_created_date) >= DATE('{SYNC_FROM_DATE}')
    """

    rows = bq_client.query(query).result()
    records = []

    for row in rows:
        record = {
            "po_created_date": serialize_value(row.po_created_date),
            "po_detail_id": serialize_value(row.po_detail_id),
            "po_id": serialize_value(row.po_id),
            "po_number": serialize_value(row.po_number),
            "cp_id": serialize_value(row.cp_id),
            "sku": serialize_value(row.sku),
            "size": serialize_value(row.size),
            "product_description": serialize_value(
                row.product_description
            ),
            "po_created_warehouse": serialize_value(
                row.po_created_warehouse
            ),
            "po_created_location_key": serialize_value(
                row.po_created_location_key
            ),
            "po_status": serialize_value(row.po_status),
            "vendor_name": serialize_value(row.vendor_name),
            "vendor_code": serialize_value(row.vendor_code),
            "expected_delivery_date": serialize_value(
                row.expected_delivery_date
            ),
            "grn_id": serialize_value(row.grn_id),
            "po_ref_num": serialize_value(row.po_ref_num),
            "grn_status": serialize_value(row.grn_status),
            "grn_created_date": serialize_value(row.grn_created_date),
            "grn_invoice_date": serialize_value(row.grn_invoice_date),
            "grn_invoice_number": serialize_value(
                row.grn_invoice_number
            ),
            "last_grn_date": serialize_value(row.last_grn_date),
            "po_type": serialize_value(row.PO_Type),
            "po_original_quantity": serialize_value(
                row.po_original_quantity
            ),
            "po_pending_quantity": serialize_value(
                row.po_pending_quantity
            ),
            "total_grn_value": serialize_value(row.total_grn_value),
            "grn_receive_quantity": serialize_value(
                row.grn_receive_quantity
            ),
        }

        records.append(record)

    print(f"Fetched {len(records):,} rows from BigQuery.")
    return records


# ============================================================
# READ EXISTING SUPABASE RECORDS FOR THE REFRESH SCOPE
# ============================================================

def fetch_existing_records():
    """
    Save a copy of the records that will be replaced.
    Pagination avoids relying on Supabase's default row limit.
    """

    print(
        "\nBacking up existing Supabase records where "
        f"po_created_date >= {SYNC_FROM_DATE}..."
    )

    existing = []
    start = 0

    while True:
        response = (
            supabase
            .schema(SUPABASE_SCHEMA)
            .table(SUPABASE_TABLE)
            .select("*")
            .gte("po_created_date", SYNC_FROM_DATE)
            .order("po_id")
            .order("po_detail_id")
            .order("grn_id")
            .order("sku")
            .range(start, start + READ_PAGE_SIZE - 1)
            .execute()
        )

        page = response.data or []
        existing.extend(page)

        if len(page) < READ_PAGE_SIZE:
            break

        start += READ_PAGE_SIZE

    print(f"Backed up {len(existing):,} existing rows.")
    return existing


# ============================================================
# DELETE REFRESH SCOPE
# ============================================================

def delete_refresh_scope():
    print(
        "\nDeleting existing refresh-scope records "
        f"(po_created_date >= {SYNC_FROM_DATE})..."
    )

    (
        supabase
        .schema(SUPABASE_SCHEMA)
        .table(SUPABASE_TABLE)
        .delete()
        .gte("po_created_date", SYNC_FROM_DATE)
        .execute()
    )

    print("Existing refresh-scope records deleted.")


# ============================================================
# INSERT RECORDS
# ============================================================

def insert_records(records, label="Uploading"):
    total = len(records)

    if total == 0:
        print(f"{label}: no records.")
        return

    uploaded = 0

    for start in range(0, total, BATCH_SIZE):
        batch = records[start:start + BATCH_SIZE]

        (
            supabase
            .schema(SUPABASE_SCHEMA)
            .table(SUPABASE_TABLE)
            .insert(batch)
            .execute()
        )

        uploaded += len(batch)
        print(f"{label}: {uploaded:,} / {total:,} rows")

    print(f"{label} completed: {uploaded:,} rows.")


# ============================================================
# RESTORE OLD DATA IF REFRESH FAILS
# ============================================================

def restore_previous_records(previous_records):
    """
    Best-effort recovery. Clear any partially inserted refresh data,
    then put the backed-up rows back.
    """

    print("\nATTEMPTING RECOVERY OF PREVIOUS SUPABASE DATA...")

    try:
        delete_refresh_scope()

        if previous_records:
            insert_records(
                previous_records,
                label="Restoring previous data",
            )

        print("Recovery completed.")
        return True

    except Exception as exc:
        print("\nCRITICAL: Automatic recovery failed.")
        print(f"Recovery error: {exc}")
        print(
            "Do not rerun the refresh blindly. "
            "Check the Supabase table and restore from a backup if needed."
        )
        return False


# ============================================================
# MAIN
# ============================================================

def main():
    print("=" * 68)
    print("PO-GRN MAPPING: BIGQUERY -> SUPABASE")
    print("=" * 68)
    print(f"BigQuery source : {BQ_TABLE}")
    print(f"Supabase target : {SUPABASE_SCHEMA}.{SUPABASE_TABLE}")
    print(f"Refresh scope   : po_created_date >= {SYNC_FROM_DATE}")
    print(f"Environment     : {ENV_FILE}")

    # Step 1: Fetch the complete new dataset first.
    # If BigQuery fails, Supabase remains untouched.
    fresh_records = fetch_from_bigquery()

    if not fresh_records:
        print(
            "\nSTOP: BigQuery returned zero rows. "
            "Supabase has NOT been modified."
        )
        return

    # Step 2: Back up existing rows before replacing them.
    previous_records = fetch_existing_records()

    # Step 3: Replace only the selected date scope.
    try:
        delete_refresh_scope()
        insert_records(fresh_records, label="Uploading fresh data")

    except Exception as exc:
        print("\nREFRESH FAILED.")
        print(f"Error: {exc}")

        restored = restore_previous_records(previous_records)

        if restored:
            print(
                "Previous data was restored. "
                "Please investigate the original error before retrying."
            )
        else:
            print(
                "Please verify the table immediately; "
                "automatic recovery could not be confirmed."
            )

        raise

    print("\n" + "=" * 68)
    print("SYNC COMPLETED SUCCESSFULLY")
    print(f"Rows loaded: {len(fresh_records):,}")
    print("=" * 68)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\nERROR: {exc}")
        sys.exit(1)
