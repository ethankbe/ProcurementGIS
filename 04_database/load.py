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
# Internal key for an awarded lot whose source row has no award notice number.
# The UI shows the bid reference for these instead of inventing a PhilGEPS link.
NO_AWARD_MARKER = ":NO-AWARD-NO-"
NEEDED = [PE, CITY, BID, TITLE, ABC, "Classification", "Procurement Category",
          "Published Date", "Bid Notice Status", AWARD]


def db_password():
    """Read DB_PASS, tolerating quotes copied from documentation."""
    if "DB_PASS" not in os.environ:
        sys.exit("ERROR: set the password first:  export DB_PASS='your-app-password'")
    pw = os.environ["DB_PASS"].strip()
    for left, right in (("\u2018", "\u2019"), ("\u201c", "\u201d"), ("'", "'"), ('"', '"')):
        if len(pw) >= 2 and pw[0] == left and pw[-1] == right:
            pw = pw[1:-1].strip()
            break
    try:
        pw.encode("latin1")
    except UnicodeEncodeError:
        sys.exit("ERROR: DB_PASS contains a character PyMySQL cannot encode. "
                 "Check for smart quotes: export DB_PASS='actual-password'")
    return pw


def norm(s):
    return re.sub(r"\s+", " ", str(s)).strip().lower()


# Generic bid-title words do not say which lot an award notice covers.
LOOKUP_STOP = {"supply", "delivery", "procurement", "various", "office",
               "equipment", "supplies", "and", "the", "of", "for", "lot",
               "item", "items", "please", "see", "attached"}


def lookup_tokens(text):
    out = set()
    for w in norm(text).split():
        if len(w) < 3 or w in LOOKUP_STOP:
            continue
        out.add(w[:-1] if w.endswith("s") and len(w) > 3 else w)
    return out


def best_award_hit(name, desc, hits):
    """Pick a scraped notice when its title clearly matches this item line."""
    label = lookup_tokens(f"{name} {str(desc or '')[:120]}")
    best, best_score = None, 0.0
    for hit in hits or []:
        title = lookup_tokens(hit.get("title"))
        shared = label & title
        if not shared or not title:
            continue
        score = len(shared) / min(len(label), len(title))
        if len(shared) >= 2 and score >= 0.6 and score > best_score:
            best, best_score = hit, score
    return best


def agency_key(office_key):
    """'PE | UNIT | CITY' or 'PE | CITY' -> 'PE | CITY' (one key per agency)."""
    parts = [p.strip() for p in str(office_key).split("|")]
    return parts[0] + " | " + parts[-1] if len(parts) >= 3 else " | ".join(parts)


def none_if_nan(v):
    return None if pd.isna(v) else v


def compute_award_budgets(c, items):
    """Give every award notice its own budget instead of repeating the bid ABC."""
    c["budget"] = c["abc"]
    if items is None or items.empty:
        return c

    bid_sum = items.groupby("bid_ref")["item_budget"].sum()
    abc_by_bid = c.groupby("bid_ref")["abc"].first().reindex(bid_sum.index)
    diff = (bid_sum - abc_by_bid).abs()
    tol = abc_by_bid.abs() * 0.01 + 1
    genuine = set(bid_sum.index[(diff <= tol) & bid_sum.notna() & abc_by_bid.notna()])

    award_sums = items.groupby(["bid_ref", "award_no"])["item_budget"].sum()
    for (bid, aw), total in award_sums.items():
        if bid in genuine and pd.notna(total):
            c.loc[(c["bid_ref"] == bid) & (c["award_no"] == aw), "budget"] = total

    counts = c.groupby("bid_ref")["award_no"].nunique()
    shared_bids = set(counts[counts > 1].index) - genuine
    if shared_bids:
        seen, assigned = set(), {}
        for r in items[items["bid_ref"].isin(shared_bids)].itertuples(index=False):
            sig = (r.bid_ref, r.item_name, r.item_desc, r.quantity, r.uom, r.item_budget)
            if sig in seen:
                continue
            seen.add(sig)
            if pd.notna(r.item_budget):
                key = (r.bid_ref, r.award_no)
                assigned[key] = assigned.get(key, 0.0) + float(r.item_budget)
        for (bid, aw), total in assigned.items():
            c.loc[(c["bid_ref"] == bid) & (c["award_no"] == aw), "budget"] = total
        # Duplicate lines belonged to an earlier award; do not repeat the ABC.
        for bid in shared_bids:
            mask = c["bid_ref"] == bid
            for aw in c.loc[mask, "award_no"].unique():
                if (bid, aw) not in assigned:
                    c.loc[mask & (c["award_no"] == aw), "budget"] = 0.0
    return c


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
    if args.dry_run:
        print("MODE: DRY RUN — this report does not change MySQL.")
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
    
    for col in ("Region", "Province"):
        if col not in c.columns:
            c[col] = None
    # clean the ".0" spreadsheet artifact from reference numbers
    for col in (BID, AWARD):
        c[col] = c[col].str.replace(r"\.0$", "", regex=True).str.strip()

    # Award numbers/awardees found on PhilGEPS: search results first, the
    # award-notice pages second (these win), the CSV column last. A bid with
    # several published notices is ambiguous, so we never use one notice to
    # fill a different blank-award line of that bid.
    awardee_map, award_no_map, awardee_by_award = {}, {}, {}
    hits_by_bid = {}
    ambiguous_lookup_bids = set()
    base = os.path.dirname(os.path.abspath(args.addresses))
    lookup_path = os.path.join(base, "award_lookup.jsonl")
    if os.path.exists(lookup_path):
        for line in open(lookup_path):
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            bid = str(data.get("bid_ref"))
            hits = [h for h in (data.get("hits") or []) if h.get("award_no")]
            hits_by_bid[bid] = hits
            if len(hits) > 1:
                ambiguous_lookup_bids.add(bid)
            if len(hits) == 1:
                award_no_map.setdefault(bid, str(hits[0]["award_no"]))
            for hit in hits:
                if hit.get("awardee"):
                    awardee_map.setdefault(bid, hit["awardee"])
                    awardee_by_award.setdefault(
                        (bid, str(hit["award_no"])), hit["awardee"])
    jsonl_path = os.path.join(base, "addresses_raw.jsonl")
    if os.path.exists(jsonl_path):
        for line in open(jsonl_path):
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            bid = str(data.get("bid_ref"))
            if data.get("award_no") and bid not in ambiguous_lookup_bids:
                award_no_map[bid] = str(data["award_no"])
            if data.get("awardee"):
                awardee_map[bid] = data["awardee"]
                if data.get("award_no"):
                    awardee_by_award[(bid, str(data["award_no"]))] = data["awardee"]

    # Treat spreadsheet-empty strings as missing before filling anything.
    c[AWARD] = c[AWARD].replace(r"^\s*$", None, regex=True)

    # Only use a PhilGEPS lookup when this bid has at most one award notice in
    # the source. Copying one notice number onto another lot of the same bid
    # would merge separate awards (e.g. bid 50720's antivirus lot into 28178).
    source_awards = c.groupby(BID)[AWARD].nunique()
    unambiguous = c[BID].map(source_awards).le(1)
    blank = c[AWARD].isna()
    fillable = blank & unambiguous
    c.loc[fillable, AWARD] = c.loc[fillable, BID].map(award_no_map)

    # When a bid has several notices, use a scraped title only if it clearly
    # names this item line. A generic bid title matches nothing, so unrelated
    # lots stay separate instead of borrowing another lot's award number.
    blank = c[AWARD].isna()
    matched = 0
    if blank.any() and hits_by_bid:
        name_col = "Item/Lot Name" if "Item/Lot Name" in c.columns else None
        desc_col = "Item/Lot Description" if "Item/Lot Description" in c.columns else None
        for idx, row in c.loc[blank].iterrows():
            hit = best_award_hit(
                (row.get(name_col) or "") if name_col else "",
                (row.get(desc_col) or "") if desc_col else "",
                hits_by_bid.get(str(row[BID]), []))
            if hit:
                c.at[idx, AWARD] = str(hit["award_no"])
                matched += 1
        if matched:
            print("award numbers matched from scraped notice titles: %d" % matched)

    # What remains is a genuine awarded lot whose notice number is absent from
    # the source. Give it a stable internal key so it stays its own contract;
    # the UI shows the bid reference for these rows and makes no award link.
    blank = c[AWARD].isna()
    synthetic, counters, keys = set(), {}, []
    for bid in c.loc[blank, BID]:
        bid_s = str(bid)
        counters[bid_s] = counters.get(bid_s, 0) + 1
        key = "%s%s%d" % (bid_s, NO_AWARD_MARKER, counters[bid_s])
        keys.append(key)
        synthetic.add(key)
    c.loc[blank, AWARD] = keys
    if synthetic:
        print("awarded lots with no notice number in source: %d (kept separate)"
              % len(synthetic))

    source_awardee = (c["Awardee Organization Name"]
                      if "Awardee Organization Name" in c.columns
                      else pd.Series([None] * len(c), index=c.index))
    c["awardee"] = [(str(v).strip() or None) if pd.notna(v) else None
                    for v in source_awardee]
    # Prefer the awardee on the item row, then an award-specific lookup, then
    # the old bid-wide fallback (one bid may have several different awardees).
    c["awardee"] = [a or (None if str(w) in synthetic else (
                        awardee_by_award.get((str(b), str(w))) or awardee_map.get(str(b))))
                    for a, b, w in zip(c["awardee"], c[BID], c[AWARD])]
    c["entity_key"] = (c[PE].fillna("").str.upper().str.strip() + " | " +
                       c[CITY].fillna("").str.upper().str.strip())
    c["unit"] = c[TITLE].str.extract(r"\s-\s([^-]+)$", expand=False).str.strip().str.upper().str[:500]
    c["abc"] = pd.to_numeric(c[ABC].str.replace(",", "", regex=False), errors="coerce")
    try:
        dates = pd.to_datetime(c["Published Date"], errors="coerce", format="mixed")
    except (TypeError, ValueError):
        dates = pd.to_datetime(c["Published Date"], errors="coerce")
    c["published"] = dates.dt.date
    c = c.rename(columns={BID: "bid_ref", AWARD: "award_no", TITLE: "title",
                          "Classification": "classification",
                          "Procurement Category": "category",
                          "Bid Notice Status": "status"})
    # a bid can span several rows; use the first non-blank budget among them
    c["abc"] = c.groupby("bid_ref")["abc"].transform("first")

    # ---- item lines: one row per item/lot (kept before bids are de-duplicated)
    item_cols = {"Item/Lot Name": "item_name", "Item/Lot Description": "item_desc",
                 "Quantity": "quantity", "Unit of Measure": "uom",
                 "Item Budget": "item_budget"}
    items = None
    if all(col in c.columns for col in item_cols):
        items = c[["bid_ref", "award_no"] + list(item_cols)].rename(columns=item_cols)
        items = items[items["bid_ref"].notna()].copy()
        for col in ("item_name", "item_desc", "uom"):
            items[col] = items[col].fillna("").str.strip().str.replace(r"\s+", " ", regex=True)
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

    # The app shows one card per award notice, so each needs its own budget.
    c = compute_award_budgets(c, items)

    n_rows = len(c)
    n_bids = c["bid_ref"].nunique()
    # One bid can produce several award notices, each with its own awardee and
    # item lines. Keep them separate; rows repeating one award are collapsed.
    c = c[c["bid_ref"].notna()].drop_duplicates(["bid_ref", "award_no"])
    print("contracts.csv: %d rows -> %d award notices across %d bids"
          % (n_rows, len(c), n_bids))

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
        print("To apply these numbers, rerun without --dry-run after exporting DB_PASS.")
        return

    # ---- database --------------------------------------------------------
    try:
        import pymysql
    except ImportError:
        sys.exit("ERROR: run  python3 -m pip install pymysql  first")
    schema = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")

    con = pymysql.connect(host=args.host, user=args.user, password=db_password(),
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
    # older databases: add the awardee column and widen unit if needed
    cur.execute("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
                "AND TABLE_NAME = 'contracts' AND COLUMN_NAME = 'awardee'")
    if cur.fetchone()[0] == 0:
        cur.execute("ALTER TABLE contracts ADD COLUMN awardee VARCHAR(255) NULL AFTER award_no")
    cur.execute("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() "
                "AND TABLE_NAME = 'contracts' AND COLUMN_NAME = 'unit' "
                "AND CHARACTER_MAXIMUM_LENGTH < 500")
    if cur.fetchone()[0]:
        cur.execute("ALTER TABLE contracts MODIFY COLUMN unit VARCHAR(500) NULL")

    def has_column(table, name):
        cur.execute("SELECT COUNT(*) FROM information_schema.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s",
                    (table, name))
        return cur.fetchone()[0] > 0

    def has_index(table, name):
        cur.execute("SELECT COUNT(*) FROM information_schema.STATISTICS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND INDEX_NAME = %s",
                    (table, name))
        return cur.fetchone()[0] > 0

    if not has_column("contracts", "budget"):
        cur.execute("ALTER TABLE contracts ADD COLUMN budget DECIMAL(16,2) NULL AFTER abc")
        cur.execute("UPDATE contracts SET budget = abc")

    # Older databases stored one contract per bid, which merged separate award
    # notices. Move to one contract per (bid_ref, award_no) and tag item lines
    # with the award they belong to.
    if not has_column("items", "award_no"):
        cur.execute("ALTER TABLE items ADD COLUMN award_no VARCHAR(40) NULL AFTER bid_ref")
    cur.execute("""UPDATE items i JOIN contracts c ON c.bid_ref = i.bid_ref
                   SET i.award_no = c.award_no
                   WHERE i.award_no IS NULL OR i.award_no = ''""")
    if has_index("contracts", "uq_bid_ref"):
        cur.execute("ALTER TABLE contracts DROP INDEX uq_bid_ref")
    if not has_index("contracts", "idx_con_bid_ref"):
        cur.execute("ALTER TABLE contracts ADD INDEX idx_con_bid_ref (bid_ref)")
    if not has_index("contracts", "uq_contract_award"):
        cur.execute("ALTER TABLE contracts ADD UNIQUE INDEX uq_contract_award (bid_ref, award_no)")
    if not has_index("items", "idx_item_bid_award"):
        cur.execute("ALTER TABLE items ADD INDEX idx_item_bid_award (bid_ref, award_no)")

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
               classification, category, abc, budget, published, status, awardee)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON DUPLICATE KEY UPDATE status=VALUES(status), abc=VALUES(abc),
                                   budget=VALUES(budget), entity_id=VALUES(entity_id),
                                   awardee=VALUES(awardee)""",
        [(r.bid_ref, r.award_no, ent_id.get(r.entity_key), r.title, r.unit,
          r.classification, r.category, r.abc, r.budget, r.published, r.status, r.awardee)
         for r in cc.itertuples()])
    con.commit()

    # A previous load may have merged blank-award lines into a real notice.
    # Those old contract rows are no longer in the source, so remove them.
    live_keys = {(str(r.bid_ref), str(r.award_no)) for r in cc.itertuples()}
    cur.execute("SELECT id, bid_ref, award_no FROM contracts")
    stale = [row[0] for row in cur.fetchall()
             if (str(row[1]), str(row[2])) not in live_keys]
    if stale:
        cur.executemany("DELETE FROM contracts WHERE id = %s", [(i,) for i in stale])
        con.commit()
        print("removed %d stale contract(s) left by an earlier load" % len(stale))

    if items is not None:
        cur.execute("DELETE FROM items")          # items are rebuilt from the CSV each run
        ii = items.astype(object).where(items.notna(), None)
        cur.executemany(
            """INSERT INTO items (bid_ref, award_no, item_name, item_desc, quantity, uom, item_budget)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            [(r.bid_ref, r.award_no, r.item_name, r.item_desc, r.quantity, r.uom, r.item_budget)
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
