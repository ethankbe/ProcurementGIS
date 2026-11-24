#!/usr/bin/env python3
"""
geocode.py - geocode addresses with the Esri World Geocoder (same service QGIS
uses), so no manual QGIS step is needed.

Needs a free ArcGIS developer API key (https://developer.arcgis.com -> create
an account -> API keys; the free tier covers ~20,000 geocodes/month):

    export ARCGIS_API_KEY='your-key'
    python3 geocode.py                 # addresses_clean.csv -> geocoded_addresses.csv
    python3 geocode.py --limit 10      # test with a few

Results are cached in geocode_cache.jsonl, so re-runs only geocode addresses
that are new or previously failed. The QGIS route (convert_esri.py) still works
if you prefer it.
"""
import argparse
import json
import os
import pathlib
import sys
import time

import pandas as pd
import requests

URL = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates"
DELAY = 0.2        # seconds between requests; the free tier is rate-limited
MAX_TRIES = 4

# map Esri's match type to a precision label (same as convert_esri.py)
PRECISION = {
    "PointAddress": "full", "Subaddress": "full", "StreetAddress": "full",
    "StreetAddressExt": "full", "StreetInt": "full", "POI": "full",
    "StreetName": "street",
    "Locality": "locality", "Postal": "locality", "PostalExt": "locality",
    "PostalLoc": "locality",
}


def geocode_one(addr, key):
    params = {"f": "json", "singleLine": addr, "sourceCountry": "PH",
              "maxLocations": 1, "outFields": "Score,Addr_type,Match_addr",
              "token": key}
    r = requests.get(URL, params=params, timeout=30)
    if r.status_code in (403, 429, 503):
        raise RuntimeError("rate-limited (%d)" % r.status_code)
    r.raise_for_status()
    d = r.json()
    if "error" in d:
        code = d["error"].get("code")
        if code in (498, 499):
            sys.exit("ERROR: Esri rejected the API key (%s). Check ARCGIS_API_KEY."
                     % d["error"].get("message"))
        raise RuntimeError("esri error %s" % code)
    cands = d.get("candidates") or []
    if not cands:
        return None
    best = cands[0]
    attrs = best.get("attributes", {})
    loc = best.get("location", {})
    return {"lat": loc.get("y"), "long": loc.get("x"),
            "score": attrs.get("Score"),
            "precision": PRECISION.get(attrs.get("Addr_type"), "unknown"),
            "address_ma": attrs.get("Match_addr")}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--addresses", default="../02_addresses/addresses_clean.csv")
    ap.add_argument("--cache", default="geocode_cache.jsonl")
    ap.add_argument("--out", default="geocoded_addresses.csv")
    ap.add_argument("--limit", type=int, help="stop after this many new geocodes (for testing)")
    ap.add_argument("--delay", type=float, default=DELAY)
    args = ap.parse_args()

    key = os.environ.get("ARCGIS_API_KEY")
    if not key:
        sys.exit("ERROR: set your key first:  export ARCGIS_API_KEY='your-key'\n"
                 "(free at https://developer.arcgis.com, or use the QGIS route instead)")

    a = pd.read_csv(args.addresses, dtype=str)
    addrs = a["clean_address"].dropna().drop_duplicates().tolist()

    cache_path = pathlib.Path(args.cache)
    cache = {}
    if cache_path.exists():
        for line in cache_path.open():
            try:
                d = json.loads(line)
                cache[d["clean_address"]] = d
            except json.JSONDecodeError:
                pass
    todo = [x for x in addrs if cache.get(x, {}).get("status") != "ok"]
    if args.limit:
        todo = todo[:args.limit]
    print("%d unique addresses; %d to geocode (%d cached)"
          % (len(addrs), len(todo), len(addrs) - len(todo)))

    n_ok = n_fail = 0
    with cache_path.open("a") as out:
        for i, addr in enumerate(todo, 1):
            row = {"clean_address": addr, "status": "failed"}
            for attempt in range(MAX_TRIES):
                try:
                    res = geocode_one(addr, key)
                    if res and res["lat"] is not None:
                        row.update(res, status="ok")
                        n_ok += 1
                    else:
                        row["status"] = "no_match"
                        n_fail += 1
                    break
                except RuntimeError as e:
                    wait = 15 * (2 ** attempt)
                    print("  %s; waiting %ds (retry %d/%d)" % (e, wait, attempt + 1, MAX_TRIES))
                    time.sleep(wait)
            else:
                print("STOPPED: still rate-limited; run again later, it resumes from the cache.")
                break
            out.write(json.dumps(row) + "\n")
            out.flush()
            cache[addr] = row
            if i % 25 == 0 or i == len(todo):
                print("[%d/%d] %d matched, %d failed" % (i, len(todo), n_ok, n_fail))
            time.sleep(args.delay)

    rows = [d for d in cache.values() if d.get("status") == "ok"]
    g = pd.DataFrame(rows)[["clean_address", "lat", "long", "precision", "score", "address_ma"]]
    g = g.drop_duplicates("clean_address")
    g.to_csv(args.out, index=False)
    print("%d rows written to %s" % (len(g), args.out))
    print(g["precision"].value_counts().to_string())
    low = g[pd.to_numeric(g["score"], errors="coerce") < 90]
    print("%d rows with score below 90, worth checking by eye" % len(low))


if __name__ == "__main__":
    main()
