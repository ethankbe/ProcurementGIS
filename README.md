# PhilGEPS procurement map

Maps government procurement notices from PhilGEPS at the address of the buying
agency, with a searchable web page: search for an item (for example "laptop"),
see which locations bought it, and compare two locations.

## Folders

Work goes through the phases in order. Each folder holds its scripts and the
data files it uses or produces.

| Folder | What it does | Main files |
|---|---|---|
| `01_prepare/` | Notebook used to collect the PhilGEPS data | scraper `.ipynb` |
| `02_addresses/` | Builds one row per agency, then collects and cleans agency addresses from award notices | `prepare.py`, `addresses.py`, `convert.py`, `clean.py`, `contracts.csv`, `addresses_clean.csv` |
| `03_geocode/` | Turns addresses into coordinates (geocoded in QGIS with the Esri server), then converts the export | `convert_esri.py`, `esri_geocoded.csv`, `geocoded_addresses.csv` |
| `04_database/` | Loads everything into MySQL | `schema.sql`, `load.py` |
| `05_app/` | Web API and map page | `main.py`, `web/index.html` |

## Setup

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

No need to run the ones in 02 and 03 for the app. Start with 04 and 05.

```
cd 02_addresses
python3 prepare.py        # contracts.csv -> targets.csv
python3 addresses.py      # targets.csv -> addresses_raw.jsonl (slow; see notes)
python3 convert.py        # -> addresses_raw.csv, prints status counts
python3 clean.py          # -> addresses_clean.csv

cd ../03_geocode
# geocode the unique addresses in QGIS, export as esri_geocoded.csv
python3 convert_esri.py   # -> geocoded_addresses.csv

cd ../04_database
export DB_PASS='your-own-password'
python3 load.py --dry-run   # check how well the files line up
python3 load.py             # load into MySQL (safe to re-run)

cd ../05_app
export DB_PASS='your-own-password'
python3 -m uvicorn main:app --reload
```

Open http://localhost:8000. Stop the server with Ctrl+C.
