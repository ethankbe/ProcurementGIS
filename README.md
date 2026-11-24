# PhilGEPS procurement map

Maps government procurement notices from PhilGEPS at the address of the buying
agency, with a searchable web page: search for an item (for example "laptop"),
see which locations bought it, and compare two locations.

## Folders

Work goes through the phases in order. Each folder holds its scripts and the
data files it uses or produces.

| Folder | What it does | Main files |
|---|---|---|
| `01_prepare/` | Filters the raw PhilGEPS dump to awarded IT contracts | `filter.py` (or the old `scraper.ipynb`) |
| `02_addresses/` | Builds one row per agency, finds missing award numbers, then collects and cleans agency addresses from award notices | `prepare.py`, `scrape.py`, `addresses.py`, `convert.py`, `clean.py`, `contracts.csv`, `addresses_clean.csv` |
| `03_geocode/` | Turns addresses into coordinates (Esri API, or manually in QGIS) | `geocode.py`, `convert_esri.py`, `geocoded_addresses.csv` |
| `04_database/` | Loads everything into MySQL | `schema.sql`, `load.py` |
| `05_app/` | Web API and map page | `main.py`, `web/index.html` |

## Setup

For the shortest clone-to-running checklist, see [`SETUP.md`](SETUP.md).
You need Python 3 and MySQL.

```
python3 -m venv venv
source venv/bin/activate
python3 -m pip install -r requirements.txt
```

Activate the environment (`source venv/bin/activate`) in each new Terminal window.

Create the MySQL database and an app user once (run `mysql -u root -p`), using
your own password in place of the placeholder:

```sql
CREATE DATABASE philgeps CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'philgeps_app'@'localhost' IDENTIFIED BY 'your-own-password';
GRANT ALL ON philgeps.* TO 'philgeps_app'@'localhost';
```

Never commit passwords. Each person sets their own with `export DB_PASS='...'`.

## Run order

### One command (recommended)

`pipeline.py` runs every stage in order. Each stage resumes where it left off,
so it is safe to stop (Ctrl+C, getting blocked by PhilGEPS, ...) and run again.

```
export DB_PASS='your-own-password'
export ARCGIS_API_KEY='your-key'   # free at https://developer.arcgis.com
python3 pipeline.py --input path/to/philgeps_dump.csv
```

This filters the dump (all regions by default; add `--region NCR` to narrow),
builds the office list, searches PhilGEPS for award numbers the dump lacks,
scrapes agency addresses and awardees, cleans and geocodes the addresses, and
loads MySQL. Then start the app:

```
cd 05_app
python3 -m uvicorn main:app --reload
```

Useful flags: `--dry-run` (coverage report, no database writes), `--limit 10`
(cap scraping/geocoding for testing), `--skip-scrape`, `--skip-geocode`,
`--lookup-all` (search every bid, which also backfills awardees).

No new dump? Run `python3 pipeline.py --skip-scrape` to re-clean and re-load
what is already scraped, or just run 04 and 05 as below.

### Stage by stage (manual)

```
cd 01_prepare
python3 filter.py path/to/philgeps_dump.csv   # -> ../02_addresses/contracts.csv

cd ../02_addresses
python3 prepare.py        # contracts.csv -> targets.csv
python3 scrape.py         # missing award numbers -> award_lookup.jsonl (slow)
python3 addresses.py      # targets.csv -> addresses_raw.jsonl (slow; see notes)
python3 convert.py        # -> addresses_raw.csv, prints status counts
python3 clean.py          # -> addresses_clean.csv

cd ../03_geocode
export ARCGIS_API_KEY='your-key'
python3 geocode.py        # -> geocoded_addresses.csv (cached, resumable)
# or geocode in QGIS with the Esri server, export esri_geocoded.csv, then:
python3 convert_esri.py

cd ../04_database
export DB_PASS='your-own-password'
python3 load.py --dry-run   # check how well the files line up
python3 load.py             # load into MySQL (safe to re-run)

cd ../05_app
export DB_PASS='your-own-password'
python3 -m uvicorn main:app --reload
```

Open http://localhost:8000. Stop the server with Ctrl+C.

### Scraping notes

PhilGEPS rate-limits and sometimes blocks scrapers. The scripts wait a few
seconds between requests, retry with growing waits when pushed back, and stop
politely if blocked for good. Everything is written to disk as it goes, so
re-running continues where it stopped. If blocked, wait a few hours.
