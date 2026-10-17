import io
import os
import re
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests
from dotenv import load_dotenv


# ============================================================
# CONFIGURATION
# ============================================================

ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "backend" / "easyecom"
ENV_FILE = ROOT / ".env.local"

BASE_URL = "https://api.easyecom.io"
REPORT_TYPE = "MINI_SALES_REPORT"
DATE_TYPE = "ORDER_DATE"
INVOICE_TYPE = "ALL"
DEFAULT_WAREHOUSE_IDS = "ee28000332889"

SUPABASE_SCHEMA = "FG Closer"
SUPABASE_TABLE = "easyecom_mini_sales_report"

ORDER_DATE_COLUMN = "Order Date"
SOURCE_REPORT_COLUMN = "_source_report_id"
INSERT_BATCH_SIZE = 500
PAGE_SIZE = 1000
REPORT_POLL_SECONDS = 5
CONNECT_TIMEOUT = 20
READ_TIMEOUT = 180

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
load_dotenv(ENV_FILE, override=False)

EASYECOM_X_API_KEY = (os.getenv("EASYECOM_X_API_KEY") or "").strip()
EASYECOM_JWT_TOKEN = (os.getenv("EASYECOM_JWT_TOKEN") or "").strip()
WAREHOUSE_IDS = (
    os.getenv("EASYECOM_WAREHOUSE_IDS")
    or DEFAULT_WAREHOUSE_IDS
).strip()

SUPABASE_URL = (
    os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    or os.getenv("SUPABASE_URL")
    or ""
).strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = (
    os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
).strip()

if not EASYECOM_X_API_KEY or not EASYECOM_JWT_TOKEN:
    raise RuntimeError(
        "Missing EasyEcom credentials in .env.local. Required:\n"
        "EASYECOM_X_API_KEY\n"
        "EASYECOM_JWT_TOKEN"
    )

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        "Missing Supabase credentials in .env.local. Required:\n"
        "NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)\n"
        "SUPABASE_SERVICE_ROLE_KEY"
    )

TABLE_URL = f"{SUPABASE_URL}/rest/v1/{SUPABASE_TABLE}"

EASYECOM_HEADERS = {
    "x-api-key": EASYECOM_X_API_KEY,
    "Authorization": f"Bearer {EASYECOM_JWT_TOKEN}",
    "Content-Type": "application/json",
    "Accept": "application/json",
}

SUPABASE_HEADERS = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Accept": "application/json",
    "Accept-Profile": SUPABASE_SCHEMA,
}

session = requests.Session()


# ============================================================
# GENERAL HELPERS
# ============================================================

def normalize_name(value):
    return "".join(ch.lower() for ch in str(value) if ch.isalnum())


def find_column(frame, normalized_target):
    for column in frame.columns:
        if normalize_name(column) == normalized_target:
            return column
    return None


def parse_one_order_date(value):
    """
    Parse Order Date values safely.

    Priority:
      1) Year-first values (YYYY-MM-DD / YYYY/MM/DD, with optional time)
      2) Month-first values (MM/DD/YYYY or MM-DD-YYYY)
      3) Day-first values (DD/MM/YYYY or DD-MM-YYYY)

    This avoids interpreting a value such as 10/12/2026 as 10 December
    when the export is month-first (October 12). Year-first values are
    always handled explicitly.
    """
    from datetime import date, datetime

    if value is None:
        return None
    raw = str(value).strip()
    if not raw or raw.lower() in {"nan", "nat", "none", "null"}:
        return None

    formats = (
        # Year-first, the expected format for this CSV
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y/%m/%d",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
        # Month-first fallback (common exports)
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y",
        "%m-%d-%Y %H:%M:%S",
        "%m-%d-%Y %H:%M",
        "%m-%d-%Y",
        # Day-first fallback for values that cannot be month-first
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y",
        "%d-%m-%Y %H:%M:%S",
        "%d-%m-%Y %H:%M",
        "%d-%m-%Y",
    )
    for fmt in formats:
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue

    # Last resort for ISO-like strings with timezone/microseconds.
    parsed = pd.to_datetime(raw, errors="coerce", yearfirst=True, dayfirst=False)
    if pd.isna(parsed):
        return None
    return parsed.date()


def parse_order_dates(series):
    """Return Python date values while preserving the source row index."""
    return series.map(parse_one_order_date)


def request_json(method, url, *, headers, **kwargs):
    response = session.request(
        method,
        url,
        headers=headers,
        timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        **kwargs,
    )
    if not response.ok:
        raise RuntimeError(
            f"HTTP {response.status_code} calling {url}\n"
            f"{response.text[:4000]}"
        )
    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError(
            f"Expected JSON from {url}; got: {response.text[:1000]}"
        ) from exc


def find_nested_value(obj, keys):
    if isinstance(obj, dict):
        for key in keys:
            value = obj.get(key)
            if value not in (None, ""):
                return value
        for value in obj.values():
            found = find_nested_value(value, keys)
            if found not in (None, ""):
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_nested_value(item, keys)
            if found not in (None, ""):
                return found
    return None


def find_latest_combined_csv():
    pattern = re.compile(
        r"^sales_all_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_combined\.csv$"
    )
    candidates = []
    for path in OUTPUT_DIR.glob("sales_all_*_*_combined.csv"):
        match = pattern.match(path.name)
        if match and path.is_file():
            candidates.append((match.group(2), path))
    if not candidates:
        raise FileNotFoundError(
            f"No combined sales CSV found in {OUTPUT_DIR}.\n"
            "Expected: sales_all_YYYY-MM-DD_YYYY-MM-DD_combined.csv"
        )
    # Use the greatest end-date in the filename; mtime breaks ties.
    candidates.sort(key=lambda item: (item[0], item[1].stat().st_mtime))
    return candidates[-1][1]


# ============================================================
# EASYECom REPORT DOWNLOAD
# ============================================================

def queue_report(start_date, end_date):
    url = f"{BASE_URL}/reports/queue"
    payload = {
        "reportType": REPORT_TYPE,
        "params": {
            "invoiceType": INVOICE_TYPE,
            "warehouseIds": WAREHOUSE_IDS,
            "dateType": DATE_TYPE,
            "startDate": start_date,
            "endDate": end_date,
        },
    }
    print("\n[1/4] Queueing EasyEcom MINI_SALES_REPORT")
    print(f"Date range: {start_date} → {end_date}")
    print(f"Warehouse IDs: {WAREHOUSE_IDS}")

    result = request_json(
        "POST",
        url,
        headers=EASYECOM_HEADERS,
        json=payload,
    )
    report_id = find_nested_value(result, ["reportId", "report_id", "id"])
    if not report_id:
        raise RuntimeError(f"Could not find report ID in queue response: {result!r}")
    report_id = str(report_id)
    print(f"Report queued. ID: {report_id}")
    return report_id


def wait_for_download_url(report_id):
    url = f"{BASE_URL}/reports/download"
    print("\n[2/4] Waiting for EasyEcom report to complete")

    attempt = 0
    while True:
        attempt += 1
        try:
            response = session.get(
                url,
                headers=EASYECOM_HEADERS,
                params={"reportId": report_id},
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            )

            if response.ok:
                try:
                    result = response.json()
                except ValueError:
                    result = {}

                download_url = find_nested_value(
                    result,
                    ["downloadUrl", "download_url", "file_url", "fileUrl", "url"],
                )
                if isinstance(download_url, str) and download_url.startswith("http"):
                    print("Report is ready.")
                    return download_url

                status = find_nested_value(
                    result, ["status", "reportStatus", "report_status"]
                )
                if status:
                    status_upper = str(status).upper()
                    print(f"Report status (attempt {attempt}, unlimited): {status}")
                    if status_upper in {"FAILED", "ERROR", "CANCELLED"}:
                        raise RuntimeError(
                            f"EasyEcom report generation failed: {result!r}"
                        )
                else:
                    print(f"Report not ready yet (attempt {attempt}); checking again.")
            else:
                print(
                    f"Report status request HTTP {response.status_code} "
                    f"(attempt {attempt}); checking again."
                )

        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            print(
                f"Temporary network issue while checking report "
                f"(attempt {attempt}): {exc}. Retrying."
            )

        time.sleep(REPORT_POLL_SECONDS)


def download_report_frame(download_url, report_id):
    print("\n[3/4] Downloading report archive")
    response = session.get(
        download_url,
        timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
    )
    response.raise_for_status()
    content = response.content
    if not content:
        raise RuntimeError("EasyEcom returned an empty report download.")

    # EasyEcom's report download has been observed to be a ZIP file,
    # even though the enclosed file has a .csv extension.
    if zipfile.is_zipfile(io.BytesIO(content)):
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            csv_members = [
                name for name in archive.namelist()
                if name.lower().endswith(".csv")
            ]
            if not csv_members:
                raise RuntimeError(
                    f"ZIP contains no CSV file. Members: {archive.namelist()!r}"
                )
            csv_bytes = archive.read(csv_members[0])
            print(f"Extracted: {csv_members[0]}")
    else:
        csv_bytes = content

    # EasyEcom reports may use semicolon delimiters and legacy encoding.
    try:
        frame = pd.read_csv(
            io.BytesIO(csv_bytes),
            sep=None,
            engine="python",
            dtype=str,
            keep_default_na=False,
            encoding="utf-8-sig",
        )
    except UnicodeDecodeError:
        frame = pd.read_csv(
            io.BytesIO(csv_bytes),
            sep=None,
            engine="python",
            dtype=str,
            keep_default_na=False,
            encoding="latin-1",
        )

    frame.columns = [str(col).strip() for col in frame.columns]
    if frame.empty:
        raise RuntimeError(
            "Fresh EasyEcom report contains zero data rows. "
            "Refusing to replace existing data with an empty report."
        )
    if frame.columns.duplicated().any():
        raise RuntimeError("Fresh EasyEcom report has duplicate column names.")

    order_date_col = find_column(frame, "orderdate")
    if not order_date_col:
        raise RuntimeError(
            f"Fresh report is missing '{ORDER_DATE_COLUMN}'. "
            f"Columns found: {frame.columns.tolist()!r}"
        )

    frame[SOURCE_REPORT_COLUMN] = report_id
    print(f"Downloaded rows: {len(frame):,}")
    print(f"Downloaded columns: {len(frame.columns):,}")
    return frame


# ============================================================
# COMBINED CSV REFRESH
# ============================================================

def prepare_combined_csv(old_path, fresh_frame, start_date, end_date):
    print(f"\nReading existing combined CSV:\n{old_path}")
    old = pd.read_csv(
        old_path,
        dtype=str,
        keep_default_na=False,
        encoding="utf-8-sig",
        low_memory=False,
    )
    old.columns = [str(col).strip() for col in old.columns]

    old_date_col = find_column(old, "orderdate")
    fresh_date_col = find_column(fresh_frame, "orderdate")
    if not old_date_col or not fresh_date_col:
        raise RuntimeError(
            f"Order Date column not found. Existing columns: {old.columns.tolist()!r}"
        )

    old_dates = parse_order_dates(old[old_date_col])
    fresh_dates = parse_order_dates(fresh_frame[fresh_date_col])

    if old_dates.notna().sum() == 0:
        raise RuntimeError("Could not parse any Order Date values in the existing CSV.")
    if fresh_dates.isna().any():
        bad = int(fresh_dates.isna().sum())
        raise RuntimeError(
            f"{bad:,} fresh report rows have unparseable Order Date values."
        )

    start = datetime.strptime(start_date, "%Y-%m-%d").date()
    end = datetime.strptime(end_date, "%Y-%m-%d").date()

    in_range = fresh_dates.map(lambda value: start <= value <= end)
    fresh_frame = fresh_frame.loc[in_range].copy()
    fresh_dates = fresh_dates.loc[in_range]

    if fresh_frame.empty:
        raise RuntimeError(
            "No fresh report rows fall inside the requested date range. "
            "Refusing to modify the combined CSV or Supabase."
        )

    # Preserve all existing rows outside the refreshed window.
    keep_old = old_dates.isna() | old_dates.map(
        lambda value: (value < start or value > end) if pd.notna(value) else False
    )
    old_preserved = old.loc[keep_old].copy()

    # Align column sets before concatenating; missing columns remain blank.
    all_columns = list(old.columns)
    for column in fresh_frame.columns:
        if column not in all_columns:
            all_columns.append(column)
    old_preserved = old_preserved.reindex(columns=all_columns, fill_value="")
    fresh_frame = fresh_frame.reindex(columns=all_columns, fill_value="")

    combined = pd.concat(
        [old_preserved, fresh_frame],
        ignore_index=True,
    )

    # Sort by parsed order date where possible, but keep original values.
    combined_date_col = find_column(combined, "orderdate")
    sort_dates = parse_order_dates(combined[combined_date_col])
    combined["_temporary_order_date_sort"] = sort_dates.astype(str)
    combined = combined.sort_values(
        "_temporary_order_date_sort", kind="stable"
    ).drop(columns=["_temporary_order_date_sort"])

    old_name_match = re.match(
        r"sales_all_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_combined\.csv$",
        old_path.name,
    )
    original_start = old_name_match.group(1) if old_name_match else str(min(old_dates.dropna()))
    output_path = OUTPUT_DIR / (
        f"sales_all_{original_start}_{end_date}_combined.csv"
    )
    temp_path = output_path.with_suffix(".csv.tmp")

    combined.to_csv(temp_path, index=False, encoding="utf-8-sig")
    # Read the temporary file back to ensure it is parseable before DB changes.
    check = pd.read_csv(
        temp_path, dtype=str, keep_default_na=False, encoding="utf-8-sig"
    )
    if len(check) != len(combined):
        temp_path.unlink(missing_ok=True)
        raise RuntimeError("Temporary combined CSV validation failed (row count mismatch).")

    print(f"Existing rows: {len(old):,}")
    print(f"Preserved older/out-of-range rows: {len(old_preserved):,}")
    print(f"Fresh replacement rows: {len(fresh_frame):,}")
    print(f"Combined rows after refresh: {len(combined):,}")
    print(f"Prepared new CSV: {output_path}")
    return output_path, temp_path, fresh_frame


# ============================================================
# SUPABASE RANGE REFRESH WITH BACKUP/ROLLBACK
# ============================================================

def range_params(start_date, end_date, select="*"):
    """
    Filter the entire inclusive calendar-day range, including timestamps
    throughout end_date. Use a single PostgREST `and` expression so both
    conditions are applied to the same column.
    """
    from datetime import timedelta

    end_exclusive = (
        datetime.strptime(end_date, "%Y-%m-%d").date()
        + timedelta(days=1)
    ).strftime("%Y-%m-%d")

    expression = (
        f'("Order Date".gte.{start_date}T00:00:00,'
        f'"Order Date".lt.{end_exclusive}T00:00:00)'
    )
    return [
        ("select", select),
        ("order", "id.asc"),
        ("and", expression),
    ]


def supabase_get_range(start_date, end_date):
    print("\nReading existing Supabase rows in the refresh range for rollback safety...")
    # Use explicit Range pagination.
    all_rows = []
    start = 0
    while True:
        response = session.get(
            TABLE_URL,
            headers={
                **SUPABASE_HEADERS,
                "Range-Unit": "items",
                "Range": f"{start}-{start + PAGE_SIZE - 1}",
            },
            params=range_params(start_date, end_date),
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        if not response.ok:
            raise RuntimeError(
                "Could not read existing Supabase rows for safe refresh. "
                f"HTTP {response.status_code}: {response.text[:3000]}"
            )
        rows = response.json()
        if not isinstance(rows, list):
            raise RuntimeError(f"Unexpected Supabase response: {rows!r}")
        all_rows.extend(rows)
        if len(rows) < PAGE_SIZE:
            break
        start += PAGE_SIZE

    print(f"Rows backed up for date range: {len(all_rows):,}")
    return all_rows


def supabase_delete_range(start_date, end_date):
    response = session.delete(
        TABLE_URL,
        headers={
            **SUPABASE_HEADERS,
            "Content-Profile": SUPABASE_SCHEMA,
            "Prefer": "return=minimal",
        },
        params=range_params(start_date, end_date, select="id"),
        timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
    )
    if not response.ok:
        raise RuntimeError(
            "Supabase date-range delete failed. "
            f"HTTP {response.status_code}: {response.text[:4000]}"
        )


def csv_frame_to_records(frame, report_id):
    source_report_col = find_column(frame, "sourcereportid")
    if not source_report_col:
        raise RuntimeError(
            f"Fresh report is missing {SOURCE_REPORT_COLUMN}."
        )

    fetched_at = datetime.now(timezone.utc).isoformat()
    records = []

    for row in frame.to_dict(orient="records"):
        cleaned = {}
        for column, value in row.items():
            normalized = normalize_name(column)
            if normalized in {"id", "sourcereportid", "reportid", "fetchedat"}:
                continue
            if value is None:
                cleaned[column] = None
            else:
                value = str(value).strip()
                cleaned[column] = value if value else None

        cleaned["report_id"] = report_id
        cleaned["fetched_at"] = fetched_at
        records.append(cleaned)

    if not records:
        raise RuntimeError("No fresh records to send to Supabase.")
    return records


def supabase_insert_records(records):
    for batch_no, offset in enumerate(range(0, len(records), INSERT_BATCH_SIZE), start=1):
        chunk = records[offset:offset + INSERT_BATCH_SIZE]
        response = session.post(
            TABLE_URL,
            headers={
                **SUPABASE_HEADERS,
                "Content-Profile": SUPABASE_SCHEMA,
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json=chunk,
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        if not response.ok:
            raise RuntimeError(
                f"Supabase insert failed in batch {batch_no}. "
                f"HTTP {response.status_code}: {response.text[:4000]}"
            )
        print(f"Supabase batch {batch_no}: inserted {len(chunk):,} rows")


def restore_supabase_range(start_date, end_date, backup_rows):
    # Clear any partially inserted replacement rows, then restore the backup.
    supabase_delete_range(start_date, end_date)
    if backup_rows:
        for offset in range(0, len(backup_rows), INSERT_BATCH_SIZE):
            chunk = backup_rows[offset:offset + INSERT_BATCH_SIZE]
            response = session.post(
                TABLE_URL,
                headers={
                    **SUPABASE_HEADERS,
                    "Content-Profile": SUPABASE_SCHEMA,
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                json=chunk,
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            )
            if not response.ok:
                raise RuntimeError(
                    "Rollback restore failed. Manually inspect Supabase immediately. "
                    f"HTTP {response.status_code}: {response.text[:4000]}"
                )


def sync_supabase_range(start_date, end_date, fresh_frame, report_id):
    # Backup must succeed before any destructive operation is attempted.
    backup_rows = supabase_get_range(start_date, end_date)
    fresh_records = csv_frame_to_records(fresh_frame, report_id)

    print(
        f"\nReplacing Supabase rows for {start_date} through {end_date}: "
        f"{len(backup_rows):,} existing → {len(fresh_records):,} fresh"
    )

    try:
        supabase_delete_range(start_date, end_date)
        supabase_insert_records(fresh_records)
    except Exception as original_error:
        print("\nERROR during Supabase refresh. Attempting rollback...")
        try:
            restore_supabase_range(start_date, end_date, backup_rows)
            print("Rollback completed: previous date-range rows restored.")
        except Exception as rollback_error:
            raise RuntimeError(
                "Supabase refresh failed AND rollback could not be completed. "
                "Stop and inspect the table immediately.\n"
                f"Original error: {original_error}\n"
                f"Rollback error: {rollback_error}"
            ) from rollback_error
        raise RuntimeError(
            "Supabase refresh failed; previous date-range rows were restored. "
            f"Original error: {original_error}"
        ) from original_error

    print("Supabase date-range refresh completed.")


# ============================================================
# MAIN
# ============================================================

def main():
    print("=" * 72)
    print("EASYECom → COMBINED CSV → SUPABASE SALES REFRESH")
    print("=" * 72)
    print(f"Project root: {ROOT}")
    print(f"Target: {SUPABASE_SCHEMA}.{SUPABASE_TABLE}")

    old_path = find_latest_combined_csv()
    old = pd.read_csv(
        old_path,
        dtype=str,
        keep_default_na=False,
        encoding="utf-8-sig",
        low_memory=False,
    )
    old.columns = [str(col).strip() for col in old.columns]
    order_date_col = find_column(old, "orderdate")
    if not order_date_col:
        raise RuntimeError(
            f"Existing CSV has no '{ORDER_DATE_COLUMN}' column. "
            f"Columns: {old.columns.tolist()!r}"
        )

    old_dates = parse_order_dates(old[order_date_col])
    valid_dates = old_dates.dropna()
    if valid_dates.empty:
        raise RuntimeError("Could not parse any Order Date values in combined CSV.")

    start_date = max(valid_dates).strftime("%Y-%m-%d")
    end_date = datetime.now().date().strftime("%Y-%m-%d")
    if start_date > end_date:
        latest_parsed = max(valid_dates)
        raw_samples = old.loc[
            old_dates.map(lambda value: value == latest_parsed),
            order_date_col,
        ].astype(str).head(10).tolist()
        raise RuntimeError(
            f"Latest parsed Order Date ({start_date}) is later than today "
            f"({end_date}); refusing to refresh.\n"
            f"Raw CSV values parsed as that date: {raw_samples!r}\n"
            "No CSV or Supabase data has been changed. Check the raw date format."
        )

    print(f"Existing combined CSV: {old_path.name}")
    print(f"Latest Order Date:     {start_date}")
    print(f"Refresh end date:      {end_date}")

    report_id = queue_report(start_date, end_date)
    download_url = wait_for_download_url(report_id)
    fresh_frame = download_report_frame(download_url, report_id)

    output_path, temp_path, fresh_for_range = prepare_combined_csv(
        old_path, fresh_frame, start_date, end_date
    )

    try:
        sync_supabase_range(
            start_date, end_date, fresh_for_range, report_id
        )
        # Only publish the new combined CSV after Supabase refresh succeeds.
        os.replace(temp_path, output_path)
    except Exception:
        if temp_path.exists():
            temp_path.unlink()
        raise

    print("\n" + "=" * 72)
    print("REFRESH COMPLETE")
    print("=" * 72)
    print(f"Report ID:          {report_id}")
    print(f"Refreshed range:    {start_date} → {end_date}")
    print(f"Combined CSV:       {output_path}")
    print(f"Supabase target:    {SUPABASE_SCHEMA}.{SUPABASE_TABLE}")
    print(f"Fresh report rows:  {len(fresh_for_range):,}")
    print("=" * 72)


if __name__ == "__main__":
    main()
