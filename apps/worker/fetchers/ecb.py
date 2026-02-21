"""Fetch daily exchange rates from ECB and insert into Postgres.

Fetches EUR-based rates from the ECB SDMX REST API, converts to
base_currency/quote_currency/rate pairs (quote_currency=USD),
and inserts missing dates into exchange_rates.
"""

import csv
import io
import logging
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import TypedDict

import psycopg2.extensions
import requests

from config import ECB_BASE_URL, ECB_CURRENCIES

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Type definitions
# ---------------------------------------------------------------------------

class ExchangeRateRow(TypedDict):
    base_currency: str
    quote_currency: str
    rate_date: str
    rate: str


class ECBRate(TypedDict):
    currency: str
    rate_date: str
    rate_eur: Decimal


class DateRange(TypedDict):
    min_date: date
    max_date: date


# ---------------------------------------------------------------------------
# Pure functions — ECB data parsing
# ---------------------------------------------------------------------------

def parse_ecb_csv(csv_text: str) -> list[ECBRate]:
    """Parse ECB CSV response into a list of rates.

    ECB CSV columns include CURRENCY, TIME_PERIOD, OBS_VALUE among others.
    Each row is one daily rate: how many units of CURRENCY per 1 EUR.
    """
    reader = csv.DictReader(io.StringIO(csv_text))
    rates: list[ECBRate] = []
    for row in reader:
        currency = row["CURRENCY"]
        time_period = row["TIME_PERIOD"]
        obs_value = row["OBS_VALUE"]
        if not obs_value:
            continue
        try:
            rate_eur = Decimal(obs_value)
        except InvalidOperation as exc:
            raise ValueError(
                f"Invalid rate value from ECB: currency={currency} "
                f"date={time_period} value={obs_value!r}"
            ) from exc
        rates.append(ECBRate(currency=currency, rate_date=time_period, rate_eur=rate_eur))
    return rates


def convert_eur_rates_to_usd(ecb_rates: list[ECBRate]) -> list[ExchangeRateRow]:
    """Convert EUR-based ECB rates to base_currency/USD pairs.

    ECB gives: 1 EUR = X units of CCY (rate_eur_ccy)
    ECB gives: 1 EUR = Y USD (rate_eur_usd)

    We produce rows with quote_currency=USD:
    - EUR→USD: rate = rate_eur_usd
    - CCY→USD: rate = rate_eur_usd / rate_eur_ccy
    """
    rates_by_date: dict[str, dict[str, Decimal]] = {}
    for rate in ecb_rates:
        rates_by_date.setdefault(rate["rate_date"], {})[rate["currency"]] = rate["rate_eur"]

    rows: list[ExchangeRateRow] = []
    for rate_date, day_rates in sorted(rates_by_date.items()):
        if "USD" not in day_rates:
            raise ValueError(
                f"No EUR/USD rate from ECB for {rate_date}. "
                f"Available currencies: {sorted(day_rates.keys())}"
            )
        eur_usd = day_rates["USD"]

        for currency, rate_eur in sorted(day_rates.items()):
            if currency == "USD":
                rows.append(ExchangeRateRow(
                    base_currency="EUR",
                    quote_currency="USD",
                    rate_date=rate_date,
                    rate=str(eur_usd),
                ))
            else:
                rate_to_usd = (eur_usd / rate_eur).quantize(Decimal("0.000000001"))
                rows.append(ExchangeRateRow(
                    base_currency=currency,
                    quote_currency="USD",
                    rate_date=rate_date,
                    rate=str(rate_to_usd),
                ))

    return rows


# ---------------------------------------------------------------------------
# Postgres operations
# ---------------------------------------------------------------------------

def get_rate_date_ranges(
    conn: psycopg2.extensions.connection,
    currencies: list[str],
) -> dict[str, DateRange]:
    """Query min and max rate_date per base_currency already in Postgres."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT base_currency, MIN(rate_date) AS min_date, MAX(rate_date) AS max_date "
            "FROM exchange_rates "
            "WHERE base_currency = ANY(%s) AND quote_currency = 'USD' "
            "GROUP BY base_currency",
            (currencies,),
        )
        return {
            row[0]: DateRange(min_date=row[1], max_date=row[2])
            for row in cur.fetchall()
        }


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
# ECB API
# ---------------------------------------------------------------------------

def fetch_ecb_rates(currencies_with_usd: list[str], start_period: str, end_period: str) -> str:
    """Fetch daily rates from ECB SDMX REST API as CSV."""
    currency_key = "+".join(currencies_with_usd)
    url = f"{ECB_BASE_URL}/D.{currency_key}.EUR.SP00.A"
    params = {"format": "csvdata", "startPeriod": start_period, "endPeriod": end_period}

    logger.info(
        "Fetching ECB rates",
        extra={"url": url, "params": params},
    )

    response = requests.get(url, params=params, timeout=30)
    response.raise_for_status()
    return response.text


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def determine_ecb_currencies(requested: list[str]) -> list[str]:
    """Build the currency list for the ECB API call.

    ECB rates are EUR-based. We always need USD in the response to convert
    other currencies to USD. For EUR itself, we only need the USD rate.
    Non-EUR/USD currencies are fetched directly.
    """
    ecb_currencies: set[str] = {"USD"}
    for ccy in requested:
        if ccy == "USD":
            raise ValueError("USD should not be in ECB_CURRENCIES config (it's the target)")
        if ccy != "EUR":
            ecb_currencies.add(ccy)
    return sorted(ecb_currencies)


def filter_new_rows(
    all_rows: list[ExchangeRateRow],
    date_ranges: dict[str, DateRange],
    requested_currencies: list[str],
) -> list[ExchangeRateRow]:
    """Keep only rows not already covered by existing data."""
    new_rows: list[ExchangeRateRow] = []
    for row in all_rows:
        if row["base_currency"] not in requested_currencies:
            continue
        row_date = date.fromisoformat(row["rate_date"])
        existing = date_ranges.get(row["base_currency"])
        if existing is None or row_date < existing["min_date"] or row_date > existing["max_date"]:
            new_rows.append(row)
    return new_rows


def run(conn: psycopg2.extensions.connection) -> dict[str, str | int | list[str]]:
    """Main logic: fetch missing rates from ECB and insert into Postgres."""
    ecb_currencies = determine_ecb_currencies(ECB_CURRENCIES)
    date_ranges = get_rate_date_ranges(conn, ECB_CURRENCIES)
    target_start = get_earliest_transaction_date(conn)

    all_currencies_present = all(c in date_ranges for c in ECB_CURRENCIES)
    needs_backfill = (
        not all_currencies_present
        or any(r["min_date"] > target_start for r in date_ranges.values())
    )

    if needs_backfill:
        start = target_start
    else:
        earliest_max = min(r["max_date"] for r in date_ranges.values())
        start = earliest_max + timedelta(days=1)

    end = date.today()

    if start > end:
        logger.info("All ECB rates are up to date")
        return {"inserted": 0, "latest_date": str(end), "missing_currencies": []}

    csv_text = fetch_ecb_rates(ecb_currencies, str(start), str(end))
    ecb_rates = parse_ecb_csv(csv_text)
    all_rows = convert_eur_rates_to_usd(ecb_rates)

    returned_currencies = {r["base_currency"] for r in all_rows}
    missing: list[str] = [c for c in ECB_CURRENCIES if c not in returned_currencies]
    if missing:
        logger.warning(
            "ECB did not return rates for currencies: %s (they may be suspended)",
            missing,
        )

    new_rows = filter_new_rows(all_rows, date_ranges, ECB_CURRENCIES)
    inserted = insert_rows(conn, new_rows)

    latest_inserted = max((r["rate_date"] for r in new_rows), default=str(end))

    logger.info("ECB: inserted %d rows, latest date: %s", inserted, latest_inserted)

    return {
        "inserted": inserted,
        "latest_date": latest_inserted,
        "missing_currencies": missing,
    }
