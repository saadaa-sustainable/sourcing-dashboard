
import os
import sys
from pathlib import Path
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from urllib.parse import urljoin, urlsplit

import requests
from dotenv import load_dotenv


# =========================================================
# CONFIGURATION
# =========================================================

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = PROJECT_ROOT / ".env.local"

load_dotenv(ENV_FILE)

EASYECOM_BASE_URL = os.getenv(
    "EASYECOM_BASE_URL",
    "https://api.easyecom.io",
).rstrip("/")

EASYECOM_X_API_KEY = os.getenv("EASYECOM_X_API_KEY")
EASYECOM_JWT_TOKEN = os.getenv("EASYECOM_JWT_TOKEN")
EASYECOM_LOCATION_KEY = os.getenv("EASYECOM_LOCATION_KEY")

SUPABASE_URL = os.getenv(
    "NEXT_PUBLIC_SUPABASE_URL", ""
).rstrip("/")

SUPABASE_SERVICE_ROLE_KEY = os.getenv(
    "SUPABASE_SERVICE_ROLE_KEY"
)

START_DATE = date(2026, 4, 1)
END_DATE = datetime.now(
    ZoneInfo("Asia/Kolkata")
).date()

WINDOW_DAYS = 7
BATCH_SIZE = 200
TIMEOUT = 60

EASYECOM_ENDPOINT = (
    f"{EASYECOM_BASE_URL}/wms/V2/getPurchaseOrderDetails"
)

SUPABASE_ENDPOINT = (
    f"{SUPABASE_URL}/rest/v1/getpurchaseorder"
    if SUPABASE_URL
    else ""
)


# =========================================================
# SUPABASE TABLE COLUMNS
# =========================================================

TABLE_COLUMNS = [
    "po_id",
    "total_po_value",
    "po_number",
    "po_ref_num",
    "po_status_id",
    "po_created_date",
    "po_updated_date",
    "po_created_warehouse",
    "po_created_warehouse_c_id",
    "po_created_location_key",
    "vendor_name",
    "vendor_c_id",
    "vendor_code",
    "vendor_location_key",
    "po_items",
]


# =========================================================
# VALIDATION
# =========================================================

def validate_config():
    if not ENV_FILE.exists():
        raise FileNotFoundError(
            f".env.local not found: {ENV_FILE}"
        )

    required = {
        "EASYECOM_BASE_URL": EASYECOM_BASE_URL,
        "EASYECOM_X_API_KEY": EASYECOM_X_API_KEY,
        "EASYECOM_JWT_TOKEN": EASYECOM_JWT_TOKEN,
        "EASYECOM_LOCATION_KEY": EASYECOM_LOCATION_KEY,
        "NEXT_PUBLIC_SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_SERVICE_ROLE_KEY": SUPABASE_SERVICE_ROLE_KEY,
    }

    missing = [
        name for name, value in required.items()
        if not value
    ]

    if missing:
        print("Missing .env.local variables:")
        for name in missing:
            print(f" - {name}")
        sys.exit(1)


def easycom_headers():
    return {
        "x-api-key": EASYECOM_X_API_KEY,
        "Authorization": f"Bearer {EASYECOM_JWT_TOKEN}",
        "Accept": "application/json",
    }


def supabase_headers():
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


# =========================================================
# DATE HELPERS
# =========================================================

def parse_date(value):
    if not value:
        return None

    if isinstance(value, datetime):
        return value.date()

    if isinstance(value, date):
        return value

    value = str(value).strip()

    try:
        return datetime.fromisoformat(
            value.replace("Z", "+00:00")
        ).date()
    except ValueError:
        pass

    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue

    return None


def generate_date_windows(start_date, end_date, days=7):
    """
    Generate non-overlapping inclusive windows.

    Example:
      2026-04-01 to 2026-04-07
      2026-04-08 to 2026-04-14
    """

    windows = []
    current = start_date

    while current <= end_date:
        window_end = min(
            current + timedelta(days=days - 1),
            end_date,
        )

        windows.append((current, window_end))
        current = window_end + timedelta(days=1)

    return windows


# =========================================================
# RESPONSE EXTRACTION
# =========================================================

def extract_records(payload):
    data = payload.get("data", [])

    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        for key in (
            "data",
            "records",
            "results",
            "purchase_orders",
        ):
            value = data.get(key)

            if isinstance(value, list):
                return value

    for key in (
        "records",
        "results",
        "purchase_orders",
    ):
        value = payload.get(key)

        if isinstance(value, list):
            return value

    return []


def safe_url(url):
    """
    Print URL path only; never expose query values.
    """

    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


# =========================================================
# FETCH ONE DATE WINDOW
# =========================================================

def fetch_one_window(session, window_start, window_end):
    """
    Try fetching one date window using start_date/end_date.

    IMPORTANT:
    These parameter names must be supported by the
    EasyEcom endpoint. The script verifies returned dates
    and stops if the API appears to ignore the window.
    """

    print("\n" + "-" * 65)
    print(f"Fetching window: {window_start} to {window_end}")
    print("-" * 65)

    # These are the proposed date query parameters.
    # If EasyEcom uses different documented names or formats,
    # update this dictionary to match its official API contract.
    params = {
        "start_date": window_start.isoformat(),
        "end_date": window_end.isoformat(),
    }

    url = EASYECOM_ENDPOINT
    visited = set()
    window_records = []
    page_number = 0

    while url:
        if url in visited:
            raise RuntimeError(
                "Pagination loop detected for window "
                f"{window_start} to {window_end}."
            )

        visited.add(url)
        page_number += 1

        print(
            f"[{window_start} to {window_end}] "
            f"Page {page_number}: {safe_url(url)}"
        )

        # Send date parameters on the initial request only.
        # Follow nextUrl exactly for subsequent pages.
        request_params = params if page_number == 1 else None

        response = session.get(
            url,
            headers=easycom_headers(),
            params=request_params,
            timeout=TIMEOUT,
        )

        if not response.ok:
            print("EasyEcom HTTP status:", response.status_code)
            print("Response:", response.text[:2000])
            response.raise_for_status()

        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError(
                "EasyEcom returned a non-JSON response."
            ) from exc

        if not isinstance(payload, dict):
            raise RuntimeError(
                "Unexpected EasyEcom response format."
            )

        page_records = extract_records(payload)

        print(
            f"Records on page: {len(page_records)}"
        )

        # Fail safely if the API returns records outside
        # the requested window. This commonly indicates
        # that the date parameters were ignored.
        for record in page_records:
            raw_date = record.get("po_created_date")
            created_date = parse_date(raw_date)

            if created_date is None:
                raise RuntimeError(
                    "Cannot validate PO creation date for "
                    f"PO ID {record.get('po_id')}. "
                    "No database changes have been made."
                )

            if not (
                window_start <= created_date <= window_end
            ):
                raise RuntimeError(
                    "\nDATE WINDOW VALIDATION FAILED.\n"
                    f"Requested: {window_start} to {window_end}\n"
                    f"Returned PO ID: {record.get('po_id')}\n"
                    f"Returned date: {created_date}\n\n"
                    "The API may be ignoring start_date/end_date, "
                    "or it may use different parameter names.\n"
                    "Refresh stopped before clearing Supabase."
                )

        window_records.extend(page_records)

        next_url = payload.get("nextUrl")

        if next_url:
            url = urljoin(url, next_url)
        else:
            url = None

    # Deduplicate within this date window by PO ID.
    unique = {}

    for record in window_records:
        po_id = record.get("po_id")

        if po_id is None:
            raise RuntimeError(
                "A returned PO has no po_id. "
                "Refresh stopped before clearing Supabase."
            )

        unique[str(po_id)] = record

    result = list(unique.values())

    print(
        f"Window complete: {len(result)} unique POs "
        f"from {window_start} to {window_end}"
    )

    return result


# =========================================================
# FETCH ALL 7-DAY WINDOWS
# =========================================================

def fetch_all_windows():
    windows = generate_date_windows(
        START_DATE,
        END_DATE,
        WINDOW_DAYS,
    )

    print(f"\nTotal date windows: {len(windows)}")
    print(f"Window size: {WINDOW_DAYS} days")
    print(f"Overall range: {START_DATE} to {END_DATE}")

    session = requests.Session()
    all_records = {}
    window_summaries = []

    for index, (window_start, window_end) in enumerate(
        windows,
        start=1,
    ):
        print(
            f"\nWINDOW {index}/{len(windows)}"
        )

        records = fetch_one_window(
            session,
            window_start,
            window_end,
        )

        window_summaries.append(
            (window_start, window_end, len(records))
        )

        for record in records:
            po_id = str(record["po_id"])

            # Same PO can appear in more than one API window
            # if the API uses overlapping date semantics.
            all_records[po_id] = record

    print("\n========== WINDOW SUMMARY ==========")

    for window_start, window_end, count in window_summaries:
        print(
            f"{window_start} to {window_end}: "
            f"{count} unique POs"
        )

    print("------------------------------------")
    print(f"Total unique POs: {len(all_records)}")
    print("====================================")

    return list(all_records.values())


# =========================================================
# FINAL DATE FILTER AND RECORD PREPARATION
# =========================================================

def prepare_records(records):
    prepared = {}

    for record in records:
        created_date = parse_date(
            record.get("po_created_date")
        )

        if created_date is None:
            raise RuntimeError(
                f"Invalid PO date for ID {record.get('po_id')}."
            )

        if not START_DATE <= created_date <= END_DATE:
            raise RuntimeError(
                f"PO {record.get('po_id')} falls outside "
                "the overall requested date range."
            )

        po_id = record.get("po_id")

        if po_id is None:
            raise RuntimeError(
                "Record without po_id encountered."
            )

        row = {
            column: record[column]
            for column in TABLE_COLUMNS
            if column in record
        }

        row["po_id"] = po_id
        prepared[str(po_id)] = row

    return list(prepared.values())


# =========================================================
# CLEAR SUPABASE TABLE
# =========================================================

def clear_supabase_table():
    session = requests.Session()
    headers = supabase_headers()

    print("\nClearing public.getpurchaseorder...")

    # Delete non-null PO IDs.
    response = session.delete(
        SUPABASE_ENDPOINT,
        params={"po_id": "not.is.null"},
        headers=headers,
        timeout=TIMEOUT,
    )

    if not response.ok:
        print("Supabase delete failed:", response.status_code)
        print(response.text[:3000])
        response.raise_for_status()

    # Delete remaining rows with NULL PO IDs.
    response = session.delete(
        SUPABASE_ENDPOINT,
        params={"po_id": "is.null"},
        headers=headers,
        timeout=TIMEOUT,
    )

    if not response.ok:
        print(
            "Supabase NULL-row delete failed:",
            response.status_code,
        )
        print(response.text[:3000])
        response.raise_for_status()

    print("Existing rows cleared.")


# =========================================================
# INSERT INTO SUPABASE
# =========================================================

def insert_into_supabase(records):
    if not records:
        raise RuntimeError(
            "No records to insert. Table was not cleared."
        )

    session = requests.Session()
    headers = supabase_headers()
    inserted = 0

    for start in range(0, len(records), BATCH_SIZE):
        batch = records[start:start + BATCH_SIZE]

        response = session.post(
            SUPABASE_ENDPOINT,
            headers=headers,
            json=batch,
            timeout=TIMEOUT,
        )

        if not response.ok:
            print("Supabase insert failed:", response.status_code)
            print(response.text[:3000])
            response.raise_for_status()

        inserted += len(batch)

        print(f"Inserted {inserted}/{len(records)}")

    return inserted


# =========================================================
# MAIN
# =========================================================

def main():
    validate_config()

    if END_DATE < START_DATE:
        raise ValueError(
            "END_DATE cannot be earlier than START_DATE."
        )

    print("=" * 65)
    print("EASYEECOM PURCHASE ORDER - 7 DAY WINDOW FETCH")
    print(f"Start date: {START_DATE}")
    print(f"End date:   {END_DATE}")
    print(f"Window:     {WINDOW_DAYS} days")
    print("Target:     public.getpurchaseorder")
    print("=" * 65)

    # Fetch every date window before touching Supabase.
    records = fetch_all_windows()

    if not records:
        print(
            "\nNo records returned. Supabase was NOT cleared."
        )
        return

    prepared = prepare_records(records)

    print("\n========== FINAL VALIDATION ==========")
    print(f"Overall date range: {START_DATE} to {END_DATE}")
    print(f"Unique records:     {len(prepared)}")

    dates = [
        parse_date(row["po_created_date"])
        for row in prepared
    ]

    if dates:
        print("Earliest PO date:", min(dates))
        print("Latest PO date:  ", max(dates))

    print("======================================")

    print("\nSample records:")
    for row in prepared[:10]:
        print(
            f"PO ID={row.get('po_id')} | "
            f"PO Ref={row.get('po_ref_num')} | "
            f"Created={row.get('po_created_date')}"
        )

    print(
        "\nWARNING: Continuing will delete ALL existing rows "
        "from public.getpurchaseorder."
    )
    print(
        "The API's date-filter behavior must be verified "
        "before you authorize this operation."
    )

    confirmation = input(
        "\nType CLEAR_AND_INSERT to replace the table: "
    ).strip()

    if confirmation != "CLEAR_AND_INSERT":
        print(
            "Cancelled. Supabase table was not changed."
        )
        return

    clear_supabase_table()

    inserted = insert_into_supabase(prepared)

    print("\n" + "=" * 65)
    print("REFRESH COMPLETE")
    print(f"Date range: {START_DATE} to {END_DATE}")
    print(f"Unique POs inserted: {inserted}")
    print("Target: public.getpurchaseorder")
    print("=" * 65)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled by user.")
        sys.exit(130)
    except requests.RequestException as exc:
        print("\nHTTP request failed:", str(exc))
        print("Check connectivity and API authentication.")
        sys.exit(1)
    except Exception as exc:
        print(f"\nERROR: {type(exc).__name__}: {exc}")
        print(
            "Supabase was not cleared unless the script "
            "had already reached the explicit refresh step."
        )
        sys.exit(1)
