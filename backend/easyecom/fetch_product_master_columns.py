
import os
import sys
import json
import time
from pathlib import Path
from urllib.parse import urlparse, urljoin, parse_qsl, urlencode, urlunparse
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv
from supabase import create_client


# ============================================================
# 1. CONFIGURATION
# ============================================================

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]

load_dotenv(PROJECT_ROOT / ".env.local")
load_dotenv(PROJECT_ROOT / ".env", override=False)
load_dotenv(SCRIPT_DIR / ".env", override=False)

# Sustainable-specific EasyEcom credentials
EASYECOM_BASE_URL = os.getenv(
    "EASYECOM_BASE_URL",
    "https://api.easyecom.io",
).rstrip("/")

EASYECOM_API_KEY = os.getenv("EASYECOM_X_API_KEY_SUSTAINABLE")
EASYECOM_JWT_TOKEN = os.getenv("EASYECOM_JWT_TOKEN_SUSTAINABLE")
EASYECOM_LOCATION_KEY = os.getenv("EASYECOM_LOCATION_KEY_SUSTAINABLE")

# Supabase credentials
SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# Exact destination
SUPABASE_SCHEMA = "FG Closer"
SUPABASE_TABLE = "easyecom_product_master"

# EasyEcom API
API_PATH = "/Products/GetProductMaster"
API_PARAMS = {"custom_fields": "1"}

# Request settings
BATCH_SIZE = 200
REQUEST_TIMEOUT = 60
MAX_RETRIES = 3
MAX_PAGES = 1000

# Safety guard:
# Do not enable this just to bypass a pagination issue.
ALLOW_200_PRODUCT_CATALOG = (
    os.getenv("ALLOW_200_PRODUCT_CATALOG", "false").lower() == "true"
)

USE_LOCATION_HEADER = (
    os.getenv(
        "EASYECOM_USE_LOCATION_HEADER_SUSTAINABLE", "false"
    ).lower() == "true"
)


# ============================================================
# 2. SUPABASE COLUMNS
# ============================================================

DB_COLUMNS = {
    "product_id",
    "cp_id",
    "sku",
    "product_name",
    "description",
    "product_type",
    "active",
    "flammable",
    "expiry_type",
    "material_type",
    "brand",
    "brand_id",
    "c_id",
    "category_id",
    "category_name",
    "accounting_sku",
    "accounting_unit",
    "ean_upc",
    "colour",
    "size",
    "model_no",
    "hsn_code",
    "company_name",
    "vendor_code",
    "cost",
    "mrp",
    "tax_rate",
    "tax_rule_name",
    "inventory",
    "cp_inventory",
    "cp_sub_products_count",
    "height",
    "length",
    "width",
    "weight",
    "category_shelf_life",
    "category_shelf_life_percentage",
    "product_shelf_life",
    "packaging_version_name",
    "product_image_url",
    "custom_fields",
    "created_at",
    "updated_at",
    "synced_at",
}

COLUMN_MAP = {
    "EANUPC": "ean_upc",
    "Flammable": "flammable",
    "product shelf life": "product_shelf_life",
}


# ============================================================
# 3. VALIDATE CONFIGURATION
# ============================================================

def validate_config():
    required = {
        "EASYECOM_X_API_KEY_SUSTAINABLE": EASYECOM_API_KEY,
        "EASYECOM_JWT_TOKEN_SUSTAINABLE": EASYECOM_JWT_TOKEN,
        "NEXT_PUBLIC_SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_SERVICE_ROLE_KEY": SUPABASE_SERVICE_ROLE_KEY,
    }

    missing = [
        name for name, value in required.items()
        if not value
    ]

    if missing:
        raise RuntimeError(
            "Missing environment variables: "
            + ", ".join(missing)
        )

    if not SUPABASE_URL.startswith("https://"):
        raise RuntimeError(
            "Supabase URL must start with https://"
        )

    base = urlparse(EASYECOM_BASE_URL)

    if base.scheme != "https" or not base.hostname:
        raise RuntimeError(
            "EASYECOM_BASE_URL must be a valid HTTPS URL."
        )

    if USE_LOCATION_HEADER and not EASYECOM_LOCATION_KEY:
        raise RuntimeError(
            "Location header is enabled, but "
            "EASYECOM_LOCATION_KEY_SUSTAINABLE is missing."
        )


# ============================================================
# 4. AUTHENTICATION HEADERS
# ============================================================

def build_headers():
    headers = {
        "x-api-key": EASYECOM_API_KEY,
        "Authorization": f"Bearer {EASYECOM_JWT_TOKEN}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    if USE_LOCATION_HEADER:
        headers["x-location-key"] = EASYECOM_LOCATION_KEY

    return headers


# ============================================================
# 5. HTTP REQUEST WITH RETRIES
# ============================================================

def request_json(session, url, params=None):
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = session.get(
                url,
                headers=build_headers(),
                params=params,
                timeout=REQUEST_TIMEOUT,
            )

            if response.status_code in (401, 403):
                raise RuntimeError(
                    f"EasyEcom authentication failed: HTTP "
                    f"{response.status_code}. Check the Sustainable "
                    "API key, JWT token and account permissions."
                )

            response.raise_for_status()

            try:
                payload = response.json()
            except ValueError as exc:
                raise RuntimeError(
                    "EasyEcom returned invalid JSON."
                ) from exc

            return payload

        except RuntimeError:
            raise

        except requests.RequestException as exc:
            last_error = exc

            if attempt < MAX_RETRIES:
                delay = attempt * 2

                print(
                    f"Request failed on attempt "
                    f"{attempt}/{MAX_RETRIES}: {exc}"
                )
                print(f"Retrying in {delay} seconds...")
                time.sleep(delay)

    raise RuntimeError(
        f"EasyEcom request failed after {MAX_RETRIES} attempts: "
        f"{last_error}"
    )


# ============================================================
# 6. EXTRACT PRODUCT RECORDS
# ============================================================

def extract_records(payload):
    if isinstance(payload, list):
        return payload

    if not isinstance(payload, dict):
        raise RuntimeError(
            f"Unexpected response type: {type(payload).__name__}"
        )

    if isinstance(payload.get("data"), list):
        return payload["data"]

    for key in ("products", "product_master", "results"):
        if isinstance(payload.get(key), list):
            return payload[key]

    raise RuntimeError(
        "Could not find the product list in the API response. "
        f"Response keys: {list(payload.keys())}"
    )


# ============================================================
# 7. PAGINATION: SUPPORT nextUrl
# ============================================================

def find_next_page(payload):
    """
    EasyEcom's observed response uses the top-level `nextUrl`
    property. Other common explicit next-page properties are
    supported as fallbacks.
    """
    if not isinstance(payload, dict):
        return None

    candidates = [
        payload.get("nextUrl"),
        payload.get("next"),
        payload.get("next_page_url"),
        payload.get("nextPageUrl"),
    ]

    links = payload.get("links")
    if isinstance(links, dict):
        candidates.append(links.get("next"))

    pagination = payload.get("pagination")
    if isinstance(pagination, dict):
        candidates.extend([
            pagination.get("nextUrl"),
            pagination.get("next"),
            pagination.get("next_page_url"),
            pagination.get("nextPageUrl"),
        ])

    for value in candidates:
        if isinstance(value, str) and value.strip():
            return value.strip()

    return None


def validate_next_url(next_url):
    """
    Resolve relative next-page URLs and ensure that pagination
    stays on the configured EasyEcom host before sending credentials.
    """
    resolved_url = urljoin(
        f"{EASYECOM_BASE_URL}/",
        next_url,
    )

    base = urlparse(EASYECOM_BASE_URL)
    target = urlparse(resolved_url)

    if (
        target.scheme != "https"
        or target.hostname != base.hostname
        or target.port != base.port
        or target.username is not None
        or target.password is not None
    ):
        raise RuntimeError(
            "EasyEcom returned a next-page URL on an unexpected "
            "host or scheme. Stopped to protect API credentials."
        )

    return resolved_url


def preserve_custom_fields(url):
    """
    Preserve the API-provided cursor and other query parameters.
    Add custom_fields=1 only if it is not already present.
    """
    parts = urlparse(url)
    query = parse_qsl(
        parts.query,
        keep_blank_values=True,
    )

    if not any(
        key == "custom_fields"
        for key, _ in query
    ):
        query.append(("custom_fields", "1"))

    return urlunparse(
        parts._replace(query=urlencode(query))
    )


# ============================================================
# 8. FETCH ALL PAGES AND SAVE BACKUP
# ============================================================

def fetch_all_products():
    url = f"{EASYECOM_BASE_URL}{API_PATH}"
    params = dict(API_PARAMS)

    all_products = []
    seen_urls = set()
    page_number = 1
    explicit_pagination_seen = False

    with requests.Session() as session:
        while url:
            if page_number > MAX_PAGES:
                raise RuntimeError(
                    f"Pagination exceeded MAX_PAGES={MAX_PAGES}. "
                    "Stopped to avoid an endless request loop."
                )

            # Detect repeated URLs and cursor loops.
            if url in seen_urls:
                raise RuntimeError(
                    f"Pagination loop detected at page {page_number}."
                )

            seen_urls.add(url)

            print(
                f"\nFetching Product Master page {page_number}..."
            )

            payload = request_json(
                session,
                url,
                params=params,
            )

            records = extract_records(payload)

            if not all(
                isinstance(record, dict)
                for record in records
            ):
                raise RuntimeError(
                    f"Page {page_number} contains an invalid "
                    "product record."
                )

            all_products.extend(records)

            print(
                f"Page {page_number}: {len(records)} records | "
                f"Total received: {len(all_products)}"
            )

            # FIX: Read the actual EasyEcom `nextUrl` property.
            next_url = find_next_page(payload)

            if next_url:
                url = validate_next_url(next_url)
                url = preserve_custom_fields(url)

                explicit_pagination_seen = True

                # The next URL already contains the cursor/query.
                params = None
            else:
                url = None

            page_number += 1

    if not all_products:
        raise RuntimeError(
            "The API returned no products. "
            "Supabase has NOT been modified."
        )

    # --------------------------------------------------------
    # Deduplicate by product_id.
    # If a product occurs more than once, keep its latest
    # occurrence in the fetched sequence.
    # --------------------------------------------------------

    products_by_id = {}
    missing_id_count = 0

    for product in all_products:
        product_id = product.get("product_id")

        if product_id is None:
            missing_id_count += 1
            continue

        products_by_id[str(product_id)] = product

    products = list(products_by_id.values())

    if missing_id_count:
        print(
            f"Warning: {missing_id_count} records without "
            "product_id will not be imported."
        )

    if not products:
        raise RuntimeError(
            "No valid products with product_id were fetched. "
            "Supabase has NOT been modified."
        )

    # --------------------------------------------------------
    # Save local backup before touching Supabase.
    # --------------------------------------------------------

    backup_path = SCRIPT_DIR / "product_master_fetched.json"

    with backup_path.open("w", encoding="utf-8") as file:
        json.dump(
            products,
            file,
            ensure_ascii=False,
            indent=2,
            default=str,
        )

    print("\nFETCH SUMMARY")
    print("-" * 50)
    print(f"Pages fetched: {page_number - 1}")
    print(f"Raw records received: {len(all_products)}")
    print(f"Unique products: {len(products)}")
    print(f"Explicit pagination followed: {explicit_pagination_seen}")
    print(f"Local backup: {backup_path}")

    # --------------------------------------------------------
    # Safety guard against the original 200-record issue.
    # --------------------------------------------------------

    if len(products) == 200 and not explicit_pagination_seen:
        if not ALLOW_200_PRODUCT_CATALOG:
            raise RuntimeError(
                "\nSAFETY STOP: Exactly 200 unique products were "
                "returned and no next-page URL was provided.\n"
                "Supabase has NOT been modified.\n"
                "Verify catalog completeness before proceeding. "
                "Do not enable ALLOW_200_PRODUCT_CATALOG merely "
                "to bypass this check."
            )

        print(
            "WARNING: ALLOW_200_PRODUCT_CATALOG=true. "
            "Proceeding with the 200-record catalog."
        )

    print("Pagination ended: API returned no further next-page URL.")

    return products


# ============================================================
# 9. MAP API FIELDS TO SUPABASE COLUMNS
# ============================================================

def map_product_to_supabase(product):
    mapped = {}

    for api_column, value in product.items():
        db_column = COLUMN_MAP.get(api_column)

        if db_column is None:
            db_column = (
                api_column.strip()
                .lower()
                .replace(" ", "_")
            )

        if db_column in DB_COLUMNS:
            mapped[db_column] = value

    if mapped.get("product_id") is None:
        return None

    mapped["synced_at"] = datetime.now(
        timezone.utc
    ).isoformat()

    return mapped


# ============================================================
# 10. PREPARE AND VALIDATE DATABASE RECORDS
# ============================================================

def prepare_products(products):
    mapped_products = []
    skipped = 0
    seen_ids = set()

    for product in products:
        mapped = map_product_to_supabase(product)

        if mapped is None:
            skipped += 1
            continue

        product_id = str(mapped["product_id"])

        if product_id in seen_ids:
            raise RuntimeError(
                f"Duplicate product_id after mapping: {product_id}"
            )

        seen_ids.add(product_id)
        mapped_products.append(mapped)

    if not mapped_products:
        raise RuntimeError(
            "No valid mapped products available for insertion. "
            "Supabase has NOT been modified."
        )

    print(f"Mapped products ready: {len(mapped_products)}")

    if skipped:
        print(f"Skipped products without product_id: {skipped}")

    return mapped_products


# ============================================================
# 11. DELETE EXISTING ROWS FROM TARGET TABLE
# ============================================================

def delete_existing_products(client):
    """
    Destructive operation: deletes existing product rows from the
    configured table only. The local JSON backup is saved first.

    Note: deletion and subsequent inserts are separate requests,
    not one atomic database transaction.
    """
    table = client.schema(
        SUPABASE_SCHEMA
    ).table(SUPABASE_TABLE)

    print(
        f"\nDeleting existing records from "
        f"{SUPABASE_SCHEMA}.{SUPABASE_TABLE}..."
    )

    try:
        table.delete().not_.is_(
            "product_id", "null"
        ).execute()

    except Exception as exc:
        raise RuntimeError(
            "Failed to delete existing product records. "
            "No new records have been inserted. "
            f"Original error: {exc}"
        ) from exc

    print("Existing non-null product_id records deleted.")


# ============================================================
# 12. INSERT FRESH RECORDS
# ============================================================

def insert_fresh_products(client, mapped_products):
    table = client.schema(
        SUPABASE_SCHEMA
    ).table(SUPABASE_TABLE)

    total = len(mapped_products)
    inserted = 0

    print(f"\nInserting {total} fresh products...")

    for start in range(0, total, BATCH_SIZE):
        batch = mapped_products[
            start:start + BATCH_SIZE
        ]

        try:
            table.insert(batch).execute()

        except Exception as exc:
            raise RuntimeError(
                f"Fresh insert failed for batch starting at "
                f"record {start + 1}. The table may currently "
                "contain only part of the new catalog because "
                "deletion and insertion are not atomic. "
                f"Local backup is available. Original error: {exc}"
            ) from exc

        inserted += len(batch)

        print(f"Inserted: {inserted}/{total}")

    return inserted


# ============================================================
# 13. MAIN WORKFLOW
# ============================================================

def main():
    validate_config()

    print("=" * 65)
    print("EASYECOM SUSTAINABLE PRODUCT MASTER -> SUPABASE")
    print("=" * 65)
    print(f"API endpoint: {EASYECOM_BASE_URL}{API_PATH}")
    print(f"Supabase schema: {SUPABASE_SCHEMA}")
    print(f"Supabase table: {SUPABASE_TABLE}")
    print("Mode: DELETE OLD ROWS, THEN INSERT FRESH ROWS")

    # Fetch every available page before any database modification.
    products = fetch_all_products()

    # Validate mappings before deletion.
    mapped_products = prepare_products(products)

    # Confirm the destination client can be initialized.
    client = create_client(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
    )

    # Destructive refresh: only the configured target table.
    delete_existing_products(client)

    # Insert fresh catalog in batches.
    inserted = insert_fresh_products(
        client,
        mapped_products,
    )

    print("\n" + "=" * 65)
    print("PRODUCT MASTER REFRESH COMPLETED")
    print(f"Fresh records inserted: {inserted}")
    print(f"Destination: {SUPABASE_SCHEMA}.{SUPABASE_TABLE}")
    print("=" * 65)


if __name__ == "__main__":
    try:
        main()

    except KeyboardInterrupt:
        print(
            "\nSync cancelled by user.",
            file=sys.stderr,
        )
        sys.exit(130)

    except Exception as exc:
        print(
            f"\nSYNC FAILED: {exc}",
            file=sys.stderr,
        )
        sys.exit(1)
