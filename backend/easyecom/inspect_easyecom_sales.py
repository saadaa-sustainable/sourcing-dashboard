
import os
import io
import time
import zipfile
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

import requests
import pandas as pd
from dotenv import load_dotenv


# ==================================================
# CONFIG
# ==================================================

ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "backend" / "easyecom"
ENV_FILE = ROOT / ".env.local"

START_DATE = date(2026, 4, 1)
END_DATE = date.today()

REPORT_TYPE = "MINI_SALES_REPORT"
POLL_INTERVAL = 10
MAX_WAIT_SECONDS = 900

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
load_dotenv(ENV_FILE, override=False)

BASE_URL = os.getenv(
    "EASYECOM_BASE_URL",
    "https://api.easyecom.io"
).rstrip("/")

API_KEY = os.getenv("EASYECOM_X_API_KEY")
JWT_TOKEN = os.getenv("EASYECOM_JWT_TOKEN")
LOCATION_KEY = os.getenv("EASYECOM_LOCATION_KEY")

if not all([API_KEY, JWT_TOKEN, LOCATION_KEY]):
    raise RuntimeError(
        "Missing EasyEcom credentials in .env.local. "
        "Required: EASYECOM_X_API_KEY, "
        "EASYECOM_JWT_TOKEN, EASYECOM_LOCATION_KEY."
    )

HEADERS = {
    "Authorization": f"Bearer {JWT_TOKEN}",
    "x-api-key": API_KEY,
    "Content-Type": "application/json",
    "Accept": "application/json",
}

session = requests.Session()
session.headers.update(HEADERS)


# ==================================================
# HELPERS
# ==================================================

def find_value(obj, keys):
    """Recursively find a value using candidate key names."""
    if isinstance(obj, dict):
        for key in keys:
            if key in obj and obj[key] is not None:
                return obj[key]

        for value in obj.values():
            result = find_value(value, keys)
            if result is not None:
                return result

    elif isinstance(obj, list):
        for item in obj:
            result = find_value(item, keys)
            if result is not None:
                return result

    return None


def find_report_records(obj):
    if isinstance(obj, list):
        if any(
            isinstance(item, dict)
            and (
                "reportId" in item
                or "report_id" in item
            )
            for item in obj
        ):
            return obj

        for item in obj:
            result = find_report_records(item)
            if result is not None:
                return result

    elif isinstance(obj, dict):
        for key in ("data", "reports", "result", "results"):
            if key in obj:
                result = find_report_records(obj[key])
                if result is not None:
                    return result

    return None


def make_date_batches(start_date, end_date):
    """
    Split the requested range into batches with a maximum
    difference of 89 days, safely below the API's 90-day limit.
    """
    batches = []
    current = start_date

    while current <= end_date:
        batch_end = min(
            current + timedelta(days=89),
            end_date,
        )
        batches.append((current, batch_end))
        current = batch_end + timedelta(days=1)

    return batches


def read_csv_bytes(csv_bytes):
    last_error = None

    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin1"):
        for delimiter in (",", "\t", ";", "|"):
            try:
                frame = pd.read_csv(
                    io.BytesIO(csv_bytes),
                    dtype=str,
                    keep_default_na=False,
                    encoding=encoding,
                    sep=delimiter,
                    low_memory=False,
                )

                if len(frame.columns) > 1:
                    frame.columns = [
                        str(column).strip()
                        for column in frame.columns
                    ]
                    return frame

            except Exception as exc:
                last_error = exc

    raise RuntimeError(
        f"Could not parse CSV. Last error: {last_error}"
    )


def download_csv(report_id):
    response = session.get(
        f"{BASE_URL}/reports/download",
        params={"reportId": report_id},
        timeout=60,
    )
    response.raise_for_status()

    payload = response.json()

    download_url = find_value(
        payload,
        ("downloadUrl", "downloadURL", "download_url", "url"),
    )

    if not download_url or not str(download_url).startswith("http"):
        raise RuntimeError(
            f"No download URL returned for report {report_id}: "
            f"{payload}"
        )

    # Signed download URL: do not forward API credentials.
    download_response = requests.get(
        download_url,
        timeout=180,
    )
    download_response.raise_for_status()

    content = download_response.content

    if zipfile.is_zipfile(io.BytesIO(content)):
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            csv_names = [
                name for name in archive.namelist()
                if name.lower().endswith(".csv")
                and not name.endswith("/")
            ]

            if not csv_names:
                raise RuntimeError(
                    f"No CSV inside report ZIP {report_id}"
                )

            chosen = max(
                csv_names,
                key=lambda name: archive.getinfo(name).file_size,
            )

            content = archive.read(chosen)

    return read_csv_bytes(content)


def queue_and_wait(start_date, end_date):
    start_text = start_date.isoformat()
    end_text = end_date.isoformat()

    print(f"\nQueueing report: {start_text} to {end_text}")

    queue_payload = {
        "reportType": REPORT_TYPE,
        "params": {
            "invoiceType": "ALL",
            "warehouseIds": LOCATION_KEY,
            "dateType": "ORDER_DATE",
            "startDate": start_text,
            "endDate": end_text,
        },
    }

    response = session.post(
        f"{BASE_URL}/reports/queue",
        json=queue_payload,
        timeout=60,
    )

    if not response.ok:
        try:
            details = response.json()
        except Exception:
            details = response.text[:2000]

        raise RuntimeError(
            f"Queue failed for {start_text} to {end_text}: "
            f"HTTP {response.status_code}: {details}"
        )

    queue_data = response.json()

    report_id = find_value(
        queue_data,
        ("reportId", "report_id"),
    )

    if report_id is None:
        print("Queue response:", queue_data)
        raise RuntimeError("Could not identify the report ID.")

    report_id = str(report_id)
    print(f"Report ID: {report_id}")

    deadline = time.monotonic() + MAX_WAIT_SECONDS

    while time.monotonic() < deadline:
        response = session.get(
            f"{BASE_URL}/reports/list",
            timeout=60,
        )
        response.raise_for_status()

        reports = find_report_records(response.json()) or []
        matching = None

        for report in reports:
            candidate = (
                report.get("reportId")
                or report.get("report_id")
                or report.get("id")
            )

            if str(candidate) == report_id:
                matching = report
                break

        if matching:
            status = str(
                matching.get("status")
                or matching.get("reportStatus")
                or matching.get("report_status")
                or ""
            ).upper()

            print(f"Report {report_id} status: {status}")

            if status in {
                "COMPLETED", "COMPLETE", "SUCCESS", "SUCCEEDED"
            }:
                return report_id

            if status in {
                "FAILED", "ERROR", "CANCELLED", "CANCELED"
            }:
                raise RuntimeError(
                    f"Report {report_id} failed: {matching}"
                )

        time.sleep(POLL_INTERVAL)

    raise TimeoutError(
        f"Report {report_id} did not complete within "
        f"{MAX_WAIT_SECONDS} seconds."
    )


# ==================================================
# MAIN
# ==================================================

print("=" * 65)
print("EASYECOM MINI SALES REPORT - HISTORICAL DOWNLOAD")
print(f"Start date: {START_DATE}")
print(f"End date:   {END_DATE}")
print("=" * 65)

batches = make_date_batches(START_DATE, END_DATE)
print(f"Total report batches: {len(batches)}")

all_frames = []

for index, (batch_start, batch_end) in enumerate(batches, start=1):
    print(f"\n{'=' * 55}")
    print(f"BATCH {index}/{len(batches)}")
    print(f"{'=' * 55}")

    report_id = queue_and_wait(batch_start, batch_end)

    frame = download_csv(report_id)

    # Keep the source fields consistent between batches.
    frame["_source_report_id"] = report_id

    batch_file = OUTPUT_DIR / (
        f"sales_batch_{batch_start}_{batch_end}_{report_id}.csv"
    )
    frame.to_csv(
        batch_file,
        index=False,
        encoding="utf-8-sig",
    )

    print(f"Downloaded rows: {len(frame):,}")
    print(f"Saved batch: {batch_file}")

    all_frames.append(frame)

    # Avoid hammering the report API between requests.
    if index < len(batches):
        time.sleep(2)


# ==================================================
# COMBINE ALL BATCHES
# ==================================================

if not all_frames:
    raise RuntimeError("No report batches were downloaded.")

combined = pd.concat(
    all_frames,
    ignore_index=True,
    sort=False,
)

# Preserve every row returned by the API.
combined_path = OUTPUT_DIR / (
    f"sales_all_{START_DATE}_{END_DATE}_combined.csv"
)

combined.to_csv(
    combined_path,
    index=False,
    encoding="utf-8-sig",
)

print("\n" + "=" * 65)
print("ALL REPORTS DOWNLOADED")
print("=" * 65)
print(f"Date range:       {START_DATE} to {END_DATE}")
print(f"Batches:          {len(batches)}")
print(f"Combined rows:    {len(combined):,}")
print(f"Combined columns: {len(combined.columns):,}")
print(f"Combined CSV:     {combined_path}")
print("\nSupabase was not modified.")
