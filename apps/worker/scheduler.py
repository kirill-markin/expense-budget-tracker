"""Local Docker entrypoint: run exchange rate fetchers on a daily schedule.

Schedule (UTC):
  - ECB  08:00
  - CBR  08:05
  - NBS  08:10

Usage:
    python scheduler.py
"""

import json
import logging
import time

import psycopg2
import schedule

from config import DATABASE_URL
from fetchers.ecb import run as run_ecb
from fetchers.cbr import run as run_cbr
from fetchers.nbs import run as run_nbs

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def _run_fetcher(name: str, fetcher_fn) -> None:
    logger.info("Starting %s fetch", name)
    conn = psycopg2.connect(DATABASE_URL)
    try:
        result = fetcher_fn(conn)
        logger.info("%s result: %s", name, json.dumps(result, default=str))
    finally:
        conn.close()


def run_all() -> None:
    """Run all fetchers sequentially."""
    _run_fetcher("ECB", run_ecb)
    _run_fetcher("CBR", run_cbr)
    _run_fetcher("NBS", run_nbs)


schedule.every().day.at("08:00", "UTC").do(lambda: _run_fetcher("ECB", run_ecb))
schedule.every().day.at("08:05", "UTC").do(lambda: _run_fetcher("CBR", run_cbr))
schedule.every().day.at("08:10", "UTC").do(lambda: _run_fetcher("NBS", run_nbs))


if __name__ == "__main__":
    logger.info("Scheduler started. Running initial fetch...")
    run_all()

    logger.info("Entering schedule loop (ECB 08:00, CBR 08:05, NBS 08:10 UTC)")
    while True:
        schedule.run_pending()
        time.sleep(30)
