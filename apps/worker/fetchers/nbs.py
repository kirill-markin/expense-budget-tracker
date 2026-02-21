"""Fetch daily RSD/USD exchange rates from the National Bank of Serbia and insert into Postgres.

Fetches USD/RSD rates from the kurs.resenje.org API (official NBS data),
converts to base_currency=RSD / quote_currency=USD pairs,
and inserts missing dates into exchange_rates.

NBS publishes rates as "RSD per 1 unit of foreign currency".
For USD: exchange_middle=98.9309 means 1 USD = 98.9309 RSD.
So 1 RSD = 1/98.9309 USD, i.e. rate = 1 / exchange_middle.
"""

import logging
from datetime import date, timedelta
from decimal import Decimal
from typing import TypedDict

import psycopg2.extensions
import requests

from config import NBS_API_BASE_URL, NBS_MAX_COUNT

logger = logging.getLogger(__name__)

CURRENCY: str = "RSD"


# ---------------------------------------------------------------------------
# Type definitions
# ---------------------------------------------------------------------------

class NBSRecord(TypedDict):
    rate_date: date
    exchange_middle: Decimal


class ExchangeRateRow(TypedDict):
    base_currency: str
    quote_currency: str
    rate_date: str
    rate: str


class DateRange(TypedDict):
    min_date: date
    max_date: date


# ---------------------------------------------------------------------------
# Pure functions — NBS JSON parsing
# ---------------------------------------------------------------------------

def parse_nbs_response(data: dict) -> list[NBSRecord]:
    """Parse kurs.resenje.org API response into a list of records.

    Single-rate response has fields directly on the object.
    Multi-rate response has a 'rates' array.
    """
    raw_rates: list[dict]
    if "rates" in data:
        raw_rates = data["rates"]
    else:
        raw_rates = [data]

    records: list[NBSRecord] = []
    for entry in raw_rates:
        date_str = entry.get("date")
        middle = entry.get("exchange_middle")
        if date_str is None:
            raise ValueError(f"NBS response entry missing 'date' field: {entry!r}")
        if middle is None:
            raise ValueError(f"NBS response entry missing 'exchange_middle' field for date {date_str}")
        if middle == 0:
            raise ValueError(f"NBS returned zero exchange_middle for date {date_str}")
        records.append(NBSRecord(
            rate_date=date.fromisoformat(date_str),
            exchange_middle=Decimal(str(middle)),
        ))
    return records


def convert_nbs_to_usd(records: list[NBSRecord]) -> list[ExchangeRateRow]:
    """Convert NBS USD/RSD records to base_currency=RSD / quote_currency=USD.

    NBS gives: 1 USD = exchange_middle RSD.
    We need: 1 RSD = ? USD -> rate = 1 / exchange_middle.
    """
    rows: list[ExchangeRateRow] = []
    for record in records:
        rate = (Decimal(1) / record["exchange_middle"]).quantize(Decimal("0.000000001"))
        rows.append(ExchangeRateRow(
            base_currency=CURRENCY,
            quote_currency="USD",
            rate_date=str(record["rate_date"]),
            rate=str(rate),
        ))
    return rows


# ---------------------------------------------------------------------------
# Postgres operations
# ---------------------------------------------------------------------------

def get_rate_date_range(conn: psycopg2.extensions.connection) -> DateRange | None:
    """Query min and max rate_date for RSD already in Postgres."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT MIN(rate_date) AS min_date, MAX(rate_date) AS max_date "
            "FROM exchange_rates "
            "WHERE base_currency = %s AND quote_currency = 'USD'",
            (CURRENCY,),
        )
        row = cur.fetchone()
        if row and row[1] is not None:
            return DateRange(min_date=row[0], max_date=row[1])
    return None


def get_earliest_transaction_date(conn: psycopg2.extensions.connection) -> date:
    """Query the earliest transaction date from ledger_entries."""
    with conn.cursor() as cur:
        cur.execute("SELECT MIN(ts::date) AS min_date FROM ledger_entries")
        row = cur.fetchone()
        if row and row[0] is not None:
            return row[0]
    return date.today() - timedelta(days=30)


def insert_rows(
    conn: psycopg2.extensions.connection,
    rows: list[ExchangeRateRow],
) -> int:
    """Insert rows into Postgres. Returns count of inserted rows."""
    if not rows:
        return 0
    with conn.cursor() as cur:
        values = [
            (r["base_currency"], r["quote_currency"], r["rate_date"], r["rate"])
            for r in rows
        ]
        cur.executemany(
            "INSERT INTO exchange_rates (base_currency, quote_currency, rate_date, rate) "
            "VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (base_currency, quote_currency, rate_date) DO NOTHING",
            values,
        )
        conn.commit()
    return len(rows)


# ---------------------------------------------------------------------------
# NBS API
# ---------------------------------------------------------------------------

def fetch_nbs_rates(start: date, end: date) -> list[dict]:
    """Fetch USD/RSD rates from kurs.resenje.org for a date range.

    The API supports up to 1000 days per request via the /count/ endpoint.
    For ranges exceeding 1000 days, multiple sequential requests are made.
    """
    all_entries: list[dict] = []
    cursor = start

    while cursor <= end:
        remaining_days = (end - cursor).days + 1
        count = min(remaining_days, NBS_MAX_COUNT)
        url = f"{NBS_API_BASE_URL}/currencies/usd/rates/{cursor.isoformat()}/count/{count}"

        logger.info(
            "Fetching NBS rates",
            extra={"url": url, "start": str(cursor), "count": count},
        )

        response = requests.get(url, timeout=30)
        response.raise_for_status()
        data = response.json()

        if "rates" in data:
            all_entries.extend(data["rates"])
        else:
            all_entries.append(data)

        cursor = cursor + timedelta(days=count)

    return all_entries


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def filter_new_rows(
    all_rows: list[ExchangeRateRow],
    existing_range: DateRange | None,
) -> list[ExchangeRateRow]:
    """Keep only rows not already covered by existing data."""
    if existing_range is None:
        return all_rows
    return [
        r for r in all_rows
        if (date.fromisoformat(r["rate_date"]) < existing_range["min_date"]
            or date.fromisoformat(r["rate_date"]) > existing_range["max_date"])
    ]


def run(conn: psycopg2.extensions.connection) -> dict[str, str | int]:
    """Main logic: fetch missing RSD rates from NBS and insert into Postgres."""
    existing_range = get_rate_date_range(conn)
    target_start = get_earliest_transaction_date(conn)

    if existing_range is not None:
        needs_backfill = existing_range["min_date"] > target_start
        if needs_backfill:
            start = target_start
        else:
            start = existing_range["max_date"] + timedelta(days=1)
    else:
        start = target_start

    end = date.today()

    if start > end:
        logger.info("RSD rates are up to date")
        return {"inserted": 0, "latest_date": str(end)}

    raw_entries = fetch_nbs_rates(start, end)
    records = parse_nbs_response({"rates": raw_entries})

    if not records:
        logger.info("No new records from NBS for period %s to %s", start, end)
        latest_str = str(existing_range["max_date"]) if existing_range else str(end)
        return {"inserted": 0, "latest_date": latest_str}

    all_rows = convert_nbs_to_usd(records)
    new_rows = filter_new_rows(all_rows, existing_range)

    inserted = insert_rows(conn, new_rows)

    latest_inserted = max(r["rate_date"] for r in new_rows) if new_rows else str(end)

    logger.info("NBS: inserted %d RSD rows, latest date: %s", inserted, latest_inserted)

    return {"inserted": inserted, "latest_date": latest_inserted}
