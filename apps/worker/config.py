"""Configuration for exchange rate fetcher worker.

All database config comes from DATABASE_URL environment variable.
API URLs and currency lists are defined here.
"""

import os

# Database connection string (required).
DATABASE_URL: str = os.environ["DATABASE_URL"]

# ---------------------------------------------------------------------------
# ECB (European Central Bank)
# ---------------------------------------------------------------------------

# Currencies to fetch from ECB (converted to USD).
# USD is the target — no rate needed (implicit 1.0).
# RUB is fetched separately via CBR (ECB suspended RUB since March 2022).
# RSD is fetched separately via NBS (National Bank of Serbia).
ECB_CURRENCIES: list[str] = ["BGN", "EUR", "GBP", "TRY"]

ECB_BASE_URL: str = "https://data-api.ecb.europa.eu/service/data/EXR"

# ---------------------------------------------------------------------------
# CBR (Bank of Russia)
# ---------------------------------------------------------------------------

# Bank of Russia internal ID for USD.
# Full list: https://www.cbr.ru/scripts/XML_valFull.asp
CBR_USD_ID: str = "R01235"

CBR_BASE_URL: str = "https://www.cbr.ru/scripts/XML_dynamic.asp"

# ---------------------------------------------------------------------------
# NBS (National Bank of Serbia)
# ---------------------------------------------------------------------------

# Kurs API — free JSON wrapper around official National Bank of Serbia rates.
# Docs: https://kurs.resenje.org/doc/
NBS_API_BASE_URL: str = "https://kurs.resenje.org/api/v1"

# Maximum number of daily rates per single API request.
NBS_MAX_COUNT: int = 1000
