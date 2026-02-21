"""Fetch daily RUB/USD exchange rates from the Bank of Russia and insert into Postgres.

Fetches USD/RUB rates from the CBR XML API, converts to
base_currency=RUB / quote_currency=USD pairs,
and inserts missing dates into exchange_rates.

CBR publishes rates as "RUB per Nominal units of foreign currency".
For USD: Nominal=1, Value=77.0223 means 1 USD = 77.0223 RUB.
So 1 RUB = 1/77.0223 USD, i.e. rate = Nominal / Value.
"""

import logging
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import TypedDict

import psycopg2.extensions
import requests

from config import CBR_BASE_URL, CBR_USD_ID

logger = logging.getLogger(__name__)

CURRENCY: str = "RUB"


# ---------------------------------------------------------------------------
# Type definitions
# ---------------------------------------------------------------------------

class CBRRecord(TypedDict):
    rate_date: date
    nominal: int
    value: Decimal


class ExchangeRateRow(TypedDict):
    base_currency: str
    quote_currency: str
    rate_date: str
    rate: str


class DateRange(TypedDict):
    min_date: date
    max_date: date


# ---------------------------------------------------------------------------
# Pure functions — CBR XML parsing
# ---------------------------------------------------------------------------

def parse_cbr_decimal(raw: str) -> Decimal:
    """Parse CBR decimal format (comma as separator): '77,0223' -> Decimal('77.0223')."""
    cleaned = raw.strip().replace(",", ".")
    try:
        return Decimal(cleaned)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid CBR decimal value: {raw!r}") from exc


def parse_cbr_date(raw: str) -> date:
    """Parse CBR date format: 'DD.MM.YYYY' -> date."""
    parts = raw.strip().split(".")
    if len(parts) != 3:
        raise ValueError(f"Invalid CBR date format: {raw!r}")
    return date(int(parts[2]), int(parts[1]), int(parts[0]))


def parse_cbr_xml(xml_bytes: bytes) -> list[CBRRecord]:
    """Parse CBR XML_dynamic.asp response into a list of records."""
    root = ET.fromstring(xml_bytes)
    records: list[CBRRecord] = []
    for record_el in root.findall("Record"):
        date_attr = record_el.get("Date")
        if date_attr is None:
            raise ValueError("CBR Record element missing Date attribute")
        nominal_el = record_el.find("Nominal")
        value_el = record_el.find("Value")
        if nominal_el is None or nominal_el.text is None:
            raise ValueError(f"CBR Record missing Nominal element for date {date_attr}")
        if value_el is None or value_el.text is None:
            raise ValueError(f"CBR Record missing Value element for date {date_attr}")
        records.append(CBRRecord(
            rate_date=parse_cbr_date(date_attr),
            nominal=int(nominal_el.text.strip()),
            value=parse_cbr_decimal(value_el.text),
        ))
    return records


def convert_cbr_to_usd(records: list[CBRRecord]) -> list[ExchangeRateRow]:
    """Convert CBR USD/RUB records to base_currency=RUB / quote_currency=USD.

    CBR gives: 1 USD = Value/Nominal RUB (Nominal is always 1 for USD).
    We need: 1 RUB = ? USD -> rate = Nominal / Value.
    """
    rows: list[ExchangeRateRow] = []
    for record in records:
        if record["value"] == 0:
            raise ValueError(f"CBR returned zero rate for date {record['rate_date']}")
        rate = (Decimal(record["nominal"]) / record["value"]).quantize(Decimal("0.000000001"))
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
    """Query min and max rate_date for RUB already in Postgres."""
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
# CBR API
# ---------------------------------------------------------------------------

def format_cbr_date(d: date) -> str:
    """Format date as DD/MM/YYYY for CBR API request parameters."""
    return d.strftime("%d/%m/%Y")


def fetch_cbr_rates(start: date, end: date) -> bytes:
    """Fetch USD/RUB rates from CBR XML_dynamic.asp endpoint."""
    params = {
        "date_req1": format_cbr_date(start),
        "date_req2": format_cbr_date(end),
        "VAL_NM_RQ": CBR_USD_ID,
    }

    logger.info(
        "Fetching CBR rates",
        extra={"url": CBR_BASE_URL, "params": params},
    )

    response = requests.get(CBR_BASE_URL, params=params, timeout=30)
    response.raise_for_status()
    return response.content


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
    """Main logic: fetch missing RUB rates from CBR and insert into Postgres."""
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
        logger.info("RUB rates are up to date")
        return {"inserted": 0, "latest_date": str(end)}

    xml_bytes = fetch_cbr_rates(start, end)
    records = parse_cbr_xml(xml_bytes)

    if not records:
        logger.info("No new records from CBR for period %s to %s", start, end)
        latest_str = str(existing_range["max_date"]) if existing_range else str(end)
        return {"inserted": 0, "latest_date": latest_str}

    all_rows = convert_cbr_to_usd(records)
    new_rows = filter_new_rows(all_rows, existing_range)

    inserted = insert_rows(conn, new_rows)

    latest_inserted = max(r["rate_date"] for r in new_rows) if new_rows else str(end)

    logger.info("CBR: inserted %d RUB rows, latest date: %s", inserted, latest_inserted)

    return {"inserted": inserted, "latest_date": latest_inserted}
