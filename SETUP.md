# Clone-to-running setup

These steps reproduce the app and the processed dataset in this repository.
No PhilGEPS scraping and no Esri key are needed: the app reads the committed
CSVs, then loads them into a local MySQL database.

## 1. Get the code

If you are cloning for the first time:

```bash
git clone <REPOSITORY_URL>
cd ProcurementGIS
git checkout front-end-v2
```

If you already cloned the repo:

```bash
cd ProcurementGIS
git fetch origin
git checkout front-end-v2
git pull origin front-end-v2
```

## 2. Install Python packages

```bash
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
python -m pip install -r requirements.txt
```

If the environment already exists, just activate it and reinstall the list:

```bash
source venv/bin/activate
python -m pip install -r requirements.txt
```

## 3a. If you already have the old database

You do **not** need to recreate the database or MySQL user.

Stop the old server first if it is running, then rebuild the tables from the
committed data:

```bash
export DB_PASS='your-own-password'
cd 04_database
python load.py --dry-run          # optional report, no writes
python load.py                    # writes MySQL; safe to re-run
```

`load.py` upgrades old schemas automatically: it adds the newer columns,
switches contracts to one row per `(bid_ref, award_no)`, rebuilds all item
lines, and removes stale contract rows. Any old award numbers, awardees,
addresses, coordinates, and summaries come from the committed files.

If your MySQL user/database differs, also set `DB_HOST`, `DB_USER`, and
`DB_NAME` before running `load.py`.

## 3b. If you need a fresh database

Create the database once:

```sql
CREATE DATABASE philgeps CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'philgeps_app'@'localhost' IDENTIFIED BY 'your-own-password';
GRANT ALL ON philgeps.* TO 'philgeps_app'@'localhost';
FLUSH PRIVILEGES;
```

Then load the data:

```bash
export DB_PASS='your-own-password'
cd 04_database
python load.py
```

Never commit the password. Each person uses their own.

## 4. Start the app

```bash
cd ../05_app
export DB_PASS='your-own-password'
python -m uvicorn main:app --reload
```

Open <http://localhost:8000>. Hard-refresh the browser after reloading data.

## What is included in git

The processed dataset is committed in these files:

- `02_addresses/contracts.csv`
- `02_addresses/addresses_clean.csv`
- `02_addresses/addresses_raw.jsonl`
- `02_addresses/award_lookup.jsonl`
- `03_geocode/geocoded_addresses.csv`

The large raw PhilGEPS dump (`01_prepare/philgeps2.csv`) is intentionally not
committed; it is not needed to run the app.

## Verify the award-number fix

After loading and starting the API, type either of these in the item search:

```text
Bid 44795
Award 31637
```

You should see award badges such as `Award 31637`, `Award 29586`,
`Award 29595`, and `Award 29600`. Synthetic bid-only rows show only
`Bid 44795` and are intentionally not linked.

## Optional: rebuild from raw data

```bash
export ARCGIS_API_KEY='your-key'
python pipeline.py --input path/to/philgeps_dump.csv
```

To reuse committed scrape/geocode caches:

```bash
python pipeline.py --skip-scrape --skip-geocode
```
