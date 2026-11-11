#!/usr/bin/env python3
"""
load.py - load contracts, agencies and geocoded addresses into MySQL.

Run it from the 04_database folder. It reads three CSV files, found by default at:
  ../02_addresses/contracts.csv          the PhilGEPS download
  ../02_addresses/addresses_clean.csv    office_key, clean_address, raw_address
  ../03_geocode/geocoded_addresses.csv   clean_address, lat, long, precision

Try a dry run first. It checks everything and shows how well the files line
up, without touching the database:

    python3 load.py --dry-run

Then load for real (set the password first):

    export DB_PASS='your-app-password'
    python3 load.py

Options: --contracts, --addresses, --coords (file paths), --data-dir (one folder
holding all three files), --host, --user, --db.
It is safe to run again: existing rows are updated, not duplicated.
"""
import argparse
import os
import re
import sys
import json

import pandas as pd

PE = "Procuring Entity (PE)"
CITY = "City/Municipality"
BID = "Bid Reference No."
AWARD = "Award Reference No."
TITLE = "Notice Title"
ABC = "Approved Budget for the Contract (ABC)"
NEEDED = [PE, CITY, BID, TITLE, ABC, "Classification", "Procurement Category",
          "Published Date", "Bid Notice Status", AWARD]


def norm(s):
    return re.sub(r"\s+", " ", str(s)).strip().lower()


def agency_key(office_key):
    """'PE | UNIT | CITY' or 'PE | CITY' -> 'PE | CITY' (one key per agency)."""
    parts = [p.strip() for p in str(office_key).split("|")]
    return parts[0] + " | " + parts[-1] if len(parts) >= 3 else " | ".join(parts)


def none_if_nan(v):
    return None if pd.isna(v) else v


def read_csv(path, label):
    if not os.path.exists(path):
        sys.exit("ERROR: cannot find %s (%s)" % (path, label))
    return pd.read_csv(path, dtype=str, encoding="utf-8-sig")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", help="one folder that holds all three CSV files")
    ap.add_argument("--contracts", default="../02_addresses/contracts.csv")
    ap.add_argument("--addresses", default="../02_addresses/addresses_clean.csv")
    ap.add_argument("--coords", default="../03_geocode/geocoded_addresses.csv")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--user", default="philgeps_app")
    ap.add_argument("--db", default="philgeps")
    args = ap.parse_args()
    if args.data_dir:
        args.contracts = os.path.join(args.data_dir, "contracts.csv")
        args.addresses = os.path.join(args.data_dir, "addresses_clean.csv")
        args.coords = os.path.join(args.data_dir, "geocoded_addresses.csv")

    # ---- contracts -------------------------------------------------------
    c = read_csv(args.contracts, "the PhilGEPS download")
    missing = [col for col in NEEDED if col not in c.columns]
    if missing:
        sys.exit("ERROR: contracts.csv is missing columns: %s\nFound: %s"
                 % (missing, list(c.columns)))
    
    for col in ("Region", "Province", "Awardee Organization Name"):
        if col not in c.columns:
            c[col] = None

    # --- NEW: Pull Awardees from the scraped JSONL file ---
    awardee_map = {}
    jsonl_path = os.path.join(os.path.dirname(args.addresses), "addresses_raw.jsonl")
    if os.path.exists(jsonl_path):
        with open(jsonl_path, "r") as f:
            for line in f:
                try:
                    data = json.loads(line)
                    if data.get("bid_ref") and data.get("awardee"):
                        awardee_map[data["bid_ref"]] = data["awardee"]
                except json.JSONDecodeError:
                    pass
    
    # Map the scraped awardees to the dataframe using the bid_ref
    c["awardee"] = c[BID].map(awardee_map)
    # ------------------------------------------------------
    c["entity_key"] = (c[PE].fillna("").str.upper().str.strip() + " | " +
                       c[CITY].fillna("").str.upper().str.strip())
    c["unit"] = c[TITLE].str.extract(r"\s-\s([^-]+)$", expand=False).str.strip().str.upper()
    c["abc"] = pd.to_numeric(c[ABC].str.replace(",", "", regex=False), errors="coerce")
    try:
        dates = pd.to_datetime(c["Published Date"], errors="coerce", format="mixed")
    except (TypeError, ValueError):
        dates = pd.to_datetime(c["Published Date"], errors="coerce")
    c["published"] = dates.dt.date
    c = c.rename(columns={BID: "bid_ref", AWARD: "award_no", TITLE: "title",
                          "Classification": "classification",
                          "Procurement Category": "category",
                          "Bid Notice Status": "status",
                          "Awardee Organization Name": "awardee"}) # <--- Map the exact CSV name to the database name
    # a bid can span several rows; use the first non-blank budget among them
    c["abc"] = c.groupby("bid_ref")["abc"].transform("first")

    # ---- item lines: one row per item/lot (kept before bids are de-duplicated)
    item_cols = {"Item/Lot Name": "item_name", "Item/Lot Description": "item_desc",
                 "Quantity": "quantity", "Unit of Measure": "uom",
                 "Item Budget": "item_budget"}
    items = None
    if all(col in c.columns for col in item_cols):
        items = c[["bid_ref"] + list(item_cols)].rename(columns=item_cols)
        items = items[items["bid_ref"].notna()].copy()
        for col in ("item_name", "item_desc", "uom"):
            items[col] = items[col].fillna("").str.strip()
        items["item_name"] = items["item_name"].str[:500]
        items["uom"] = items["uom"].str[:60]
        for col in ("quantity", "item_budget"):
            items[col] = pd.to_numeric(items[col].str.replace(",", "", regex=False),
                                       errors="coerce")
        items = items[(items["item_name"] != "") | (items["item_desc"] != "")]
        items = items.drop_duplicates()
        print("item lines: %d (%d with a quantity and budget)" % (
            len(items), (items["quantity"].fillna(0).gt(0) & items["item_budget"].notna()).sum()))
    else:
        print("NOTE: contracts.csv has no item/lot columns, so item search will be empty")

    n_rows = len(c)
    c = c[c["bid_ref"].notna()].drop_duplicates("bid_ref")   # lots repeat the same bid
    print("contracts.csv: %d rows -> %d unique bids" % (n_rows, len(c)))

    # ---- addresses and coordinates --------------------------------------
    a = read_csv(args.addresses, "agency addresses")
    for col in ("office_key", "clean_address"):
        if col not in a.columns:
            sys.exit("ERROR: addresses_clean.csv has no %s column. Found: %s"
                     % (col, list(a.columns)))
    if "raw_address" not in a.columns:
        a["raw_address"] = None
    a["entity_key"] = a["office_key"].map(agency_key)
    a["akey"] = a["clean_address"].map(norm)

    g = read_csv(args.coords, "coordinates")
    for col in ("clean_address", "lat", "long"):
        if col not in g.columns:
            sys.exit("ERROR: geocoded_addresses.csv has no %s column. Found: %s"
                     % (col, list(g.columns)))
    if "precision" not in g.columns:
        g["precision"] = None
    g["akey"] = g["clean_address"].map(norm)
    g["lat"] = pd.to_numeric(g["lat"], errors="coerce")
    g["long"] = pd.to_numeric(g["long"], errors="coerce")
    g = g.drop_duplicates("akey")

    a = a.merge(g[["akey", "lat", "long", "precision"]], on="akey", how="left")

    # one address per agency; warn if an agency has several different ones
    multi = a.groupby("entity_key")["akey"].nunique()
    if (multi > 1).any():
        print("WARNING: %d agencies have more than one address; the first is used:"
              % (multi > 1).sum())
        for k in multi[multi > 1].index[:5]:
            print("   ", k)
    ent_addr = a.drop_duplicates("entity_key")[["entity_key", "akey"]]
    addr_rows = a.drop_duplicates("akey")

    # ---- coverage report -------------------------------------------------
    ents = c.drop_duplicates("entity_key")[["entity_key", PE, CITY, "Region", "Province"]]
    has_addr = set(ent_addr["entity_key"])
    n_ent = len(ents)
    n_with_addr = ents["entity_key"].isin(has_addr).sum()
    coords_ok = set(addr_rows.loc[addr_rows["lat"].notna(), "akey"])
    ent_with_pt = ent_addr[ent_addr["akey"].isin(coords_ok)]["entity_key"]
    n_with_pt = ents["entity_key"].isin(set(ent_with_pt)).sum()
    unmatched_geo = len(set(a["akey"]) - set(g["akey"]))

    print("\nagencies in contracts.csv:             %d" % n_ent)
    print("  matched to an address:               %d" % n_with_addr)
    print("  matched to an address with a point:  %d" % n_with_pt)
    print("addresses without coordinates:         %d" % unmatched_geo)
    nopt = ents[~ents["entity_key"].isin(set(ent_with_pt))]
    if len(nopt):
        print("agencies that will NOT appear on the map (showing up to 5):")
        for k in nopt["entity_key"].head(5):
            print("   ", k)

    if args.dry_run:
        print("\nDry run only: nothing was written to the database.")
        return

    # ---- database --------------------------------------------------------
    try:
        import pymysql
    except ImportError:
        sys.exit("ERROR: run  python3 -m pip install pymysql  first")
    if "DB_PASS" not in os.environ:
        sys.exit("ERROR: set the password first:  export DB_PASS='your-app-password'")
    schema = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

    con = pymysql.connect(host=args.host, user=args.user, password=os.environ["DB_PASS"],
                          database=args.db, charset="utf8mb4")
    cur = con.cursor()
    for stmt in open(schema).read().split(";"):
        if stmt.strip():
            cur.execute(stmt)
    # older databases: add the region and province columns if they are missing
    for col, ddl in (("region", "VARCHAR(100) NULL"), ("province", "VARCHAR(150) NULL")):
        cur.execute("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
                    "AND TABLE_NAME = 'entities' AND COLUMN_NAME = %s", (col,))
        if cur.fetchone()[0] == 0:
            cur.execute("ALTER TABLE entities ADD COLUMN %s %s" % (col, ddl))

    cur.executemany(
        """INSERT INTO addresses (clean_address, raw_address, lat, lon, geo_precision)
           VALUES (%s,%s,%s,%s,%s)
           ON DUPLICATE KEY UPDATE lat=VALUES(lat), lon=VALUES(lon),
                                   geo_precision=VALUES(geo_precision)""",
        [(r.clean_address, none_if_nan(r.raw_address), none_if_nan(r.lat),
          none_if_nan(r.long), none_if_nan(r.precision))
         for r in addr_rows.itertuples()])
    con.commit()

    cur.execute("SELECT clean_address, id FROM addresses")
    addr_id = {norm(k): v for k, v in cur.fetchall()}
    key_to_akey = dict(zip(ent_addr["entity_key"], ent_addr["akey"]))

    cur.executemany(
        """INSERT INTO entities (entity_key, name, city, region, province, address_id)
           VALUES (%s,%s,%s,%s,%s,%s)
           ON DUPLICATE KEY UPDATE address_id=VALUES(address_id), region=VALUES(region),
                                   province=VALUES(province)""",
        [(r[0], r[1], r[2], none_if_nan(r[3]), none_if_nan(r[4]),
          addr_id.get(key_to_akey.get(r[0])))
         for r in ents.itertuples(index=False)])
    con.commit()

    cur.execute("SELECT entity_key, id FROM entities")
    ent_id = dict(cur.fetchall())

    cc = c.astype(object).where(c.notna(), None)
    cur.executemany(
        """INSERT INTO contracts (bid_ref, award_no, entity_id, title, unit,
               classification, category, abc, published, status, awardee)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON DUPLICATE KEY UPDATE award_no=VALUES(award_no), status=VALUES(status),
                                   abc=VALUES(abc), entity_id=VALUES(entity_id), awardee=VALUES(awardee)""",
        [(r.bid_ref, r.award_no, ent_id.get(r.entity_key), r.title, r.unit,
          r.classification, r.category, r.abc, r.published, r.status, r.awardee)
         for r in cc.itertuples()])
    con.commit()

    if items is not None:
        cur.execute("DELETE FROM items")          # items are rebuilt from the CSV each run
        ii = items.astype(object).where(items.notna(), None)
        cur.executemany(
            """INSERT INTO items (bid_ref, item_name, item_desc, quantity, uom, item_budget)
               VALUES (%s,%s,%s,%s,%s,%s)""",
            [(r.bid_ref, r.item_name, r.item_desc, r.quantity, r.uom, r.item_budget)
             for r in ii.itertuples()])
        con.commit()

    print("\nDatabase now holds:")
    for t in ("addresses", "entities", "contracts", "items"):
        cur.execute("SELECT COUNT(*) FROM %s" % t)
        print("  %-10s %d" % (t, cur.fetchone()[0]))
    cur.execute("SELECT COUNT(*) FROM addresses WHERE lat IS NOT NULL")
    print("  addresses with coordinates: %d" % cur.fetchone()[0])
    con.close()


if __name__ == "__main__":
    main()
