import os
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client


# =====================================================
# LOAD ENV
# =====================================================

ENV_FILE = Path(__file__).resolve().with_name(".env")
load_dotenv(dotenv_path=ENV_FILE)


# =====================================================
# SOURCE
# saadaa-po-closer
#
# Source table:
# raw.tna_update
# =====================================================

SOURCE_SUPABASE_URL = os.getenv("TNA_SOURCE_SUPABASE_URL")
SOURCE_SUPABASE_KEY = os.getenv("TNA_SOURCE_SUPABASE_KEY")


# =====================================================
# DESTINATION
# sourcing-dashboard
#
# Destination table:
# "FG Closer".tna_update
# =====================================================

DEST_SUPABASE_URL = os.getenv("SUPABASE_URL")
DEST_SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")


# =====================================================
# CONFIG
# =====================================================

SOURCE_SCHEMA = "raw"
SOURCE_TABLE = "tna_update"

DEST_SCHEMA = "FG Closer"
DEST_TABLE = "tna_update"

BATCH_SIZE = 500


# =====================================================
# VALIDATE ENVIRONMENT
# =====================================================

def validate_environment():

    required = {
        "TNA_SOURCE_SUPABASE_URL": SOURCE_SUPABASE_URL,
        "TNA_SOURCE_SUPABASE_KEY": SOURCE_SUPABASE_KEY,
        "SUPABASE_URL": DEST_SUPABASE_URL,
        "SUPABASE_SERVICE_ROLE_KEY": DEST_SUPABASE_KEY,
    }

    missing = [
        key
        for key, value in required.items()
        if not value
    ]

    if missing:
        raise RuntimeError(
            "Missing environment variables:\n"
            + "\n".join(
                f"  - {key}"
                for key in missing
            )
        )


# =====================================================
# CREATE CLIENTS
# =====================================================

def create_clients():

    source_client = create_client(
        SOURCE_SUPABASE_URL,
        SOURCE_SUPABASE_KEY
    )

    destination_client = create_client(
        DEST_SUPABASE_URL,
        DEST_SUPABASE_KEY
    )

    return source_client, destination_client


# =====================================================
# FETCH SOURCE DATA
# =====================================================

def fetch_from_source(source_client):

    print()
    print("Connecting to saadaa-po-closer...")
    print(
        f"Source: {SOURCE_SCHEMA}.{SOURCE_TABLE}"
    )

    response = (
        source_client
        .schema(SOURCE_SCHEMA)
        .table(SOURCE_TABLE)
        .select("*")
        .execute()
    )

    records = response.data or []

    print(
        f"Fetched {len(records):,} rows "
        f"from source."
    )

    return records


# =====================================================
# CLEAR DESTINATION
# =====================================================

def clear_destination(destination_client):

    print()
    print(
        f"Clearing existing data from "
        f"{DEST_SCHEMA}.{DEST_TABLE}..."
    )

    (
        destination_client
        .schema(DEST_SCHEMA)
        .table(DEST_TABLE)
        .delete()
        .neq("source_row_number", -1)
        .execute()
    )

    print("Destination cleared successfully.")


# =====================================================
# INSERT INTO DESTINATION
# =====================================================

def insert_into_destination(
    destination_client,
    records
):

    total = len(records)

    print()
    print(
        f"Starting upload to "
        f"{DEST_SCHEMA}.{DEST_TABLE}"
    )

    print(
        f"Total rows: {total:,}"
    )

    uploaded = 0

    for start in range(
        0,
        total,
        BATCH_SIZE
    ):

        end = min(
            start + BATCH_SIZE,
            total
        )

        batch = records[start:end]

        (
            destination_client
            .schema(DEST_SCHEMA)
            .table(DEST_TABLE)
            .insert(batch)
            .execute()
        )

        uploaded += len(batch)

        print(
            f"Uploaded "
            f"{uploaded:,} / {total:,}"
        )

    print()
    print(
        f"Successfully loaded "
        f"{uploaded:,} rows."
    )


# =====================================================
# VERIFY DESTINATION
# =====================================================

def verify_destination(destination_client):

    print()
    print("Verifying destination...")

    response = (
        destination_client
        .schema(DEST_SCHEMA)
        .table(DEST_TABLE)
        .select(
            "source_row_number",
            count="exact"
        )
        .limit(1)
        .execute()
    )

    count = response.count or 0

    print(
        f"Destination row count: "
        f"{count:,}"
    )

    return count


# =====================================================
# MAIN
# =====================================================

def main():

    print("=" * 70)
    print("TNA UPDATE → FG CLOSER SYNC")
    print("=" * 70)

    print()
    print(
        f"Source      : "
        f"{SOURCE_SCHEMA}.{SOURCE_TABLE}"
    )

    print(
        f"Destination : "
        f"{DEST_SCHEMA}.{DEST_TABLE}"
    )

    print(
        f"Batch size  : "
        f"{BATCH_SIZE}"
    )

    # -------------------------------------------------
    # 1. Validate environment
    # -------------------------------------------------

    validate_environment()

    # -------------------------------------------------
    # 2. Create Supabase clients
    # -------------------------------------------------

    source_client, destination_client = (
        create_clients()
    )

    # -------------------------------------------------
    # 3. Fetch source data
    # -------------------------------------------------

    records = fetch_from_source(
        source_client
    )

    if not records:

        print()
        print(
            "No records found in "
            f"{SOURCE_SCHEMA}.{SOURCE_TABLE}."
        )

        return

    # -------------------------------------------------
    # 4. Clear destination
    # -------------------------------------------------

    clear_destination(
        destination_client
    )

    # -------------------------------------------------
    # 5. Insert fresh data
    # -------------------------------------------------

    insert_into_destination(
        destination_client,
        records
    )

    # -------------------------------------------------
    # 6. Verify
    # -------------------------------------------------

    destination_count = verify_destination(
        destination_client
    )

    # -------------------------------------------------
    # 7. Final result
    # -------------------------------------------------

    print()
    print("=" * 70)

    if destination_count == len(records):

        print(
            "TNA UPDATE SYNC COMPLETED SUCCESSFULLY"
        )

        print(
            f"Source rows      : "
            f"{len(records):,}"
        )

        print(
            f"Destination rows : "
            f"{destination_count:,}"
        )

    else:

        print(
            "WARNING: ROW COUNT MISMATCH"
        )

        print(
            f"Source rows      : "
            f"{len(records):,}"
        )

        print(
            f"Destination rows : "
            f"{destination_count:,}"
        )

    print("=" * 70)


# =====================================================
# RUN
# =====================================================

if __name__ == "__main__":
    main()