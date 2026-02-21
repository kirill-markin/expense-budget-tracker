"""AWS Lambda entrypoint for exchange rate fetchers.

Invoked by EventBridge schedule rules. Runs all fetchers sequentially
against the Postgres database specified by DATABASE_URL.
"""

import json
import logging

import psycopg2

from config import DATABASE_URL
from fetchers.ecb import run as run_ecb
from fetchers.cbr import run as run_cbr
from fetchers.nbs import run as run_nbs

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def handler(event: dict, context: object) -> dict:
    """Lambda handler: run all exchange rate fetchers."""
    conn = psycopg2.connect(DATABASE_URL)
    try:
        results = {
            "ecb": run_ecb(conn),
            "cbr": run_cbr(conn),
            "nbs": run_nbs(conn),
        }
    finally:
        conn.close()

    logger.info("All fetchers complete: %s", json.dumps(results, default=str))

    return {
        "statusCode": 200,
        "body": json.dumps(results, default=str),
    }
