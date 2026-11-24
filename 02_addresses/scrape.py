#!/usr/bin/env python3
"""
scrape.py - find award notice numbers on PhilGEPS for bids that lack one.

Reads contracts.csv, searches the Award Notices bulletin board by Bid Notice
Reference number for bids that still have blank award numbers, and writes
award_lookup.jsonl:
    {"bid_ref": "41455", "hits": [{"award_no": "15941", "title": ..., "awardee": ...,
                                   "award_date": ...}], "status": "ok"}

addresses.py picks this file up automatically. Safe to re-run: bids already
looked up are skipped. Be patient: one search every few seconds.

    python3 scrape.py            # bids with at least one blank award row
    python3 scrape.py --all      # every bid (fresh lookup)
    python3 scrape.py --force    # re-search bids already cached
    python3 scrape.py --limit 5  # test with a few
"""
import argparse
import json
import pathlib
import re
import sys
import time

import pandas as pd
import requests
from bs4 import BeautifulSoup

BASE = "https://philgeps.gov.ph"
SEARCH = BASE + "/Indexes/getAwardNotices"
DELAY = 3          # seconds between searches
MAX_TRIES = 4      # retries when the site pushes back

S = requests.Session()
S.headers["User-Agent"] = "philgeps-mapping-project"


class Blocked(Exception):
    pass


def ref_digits(value):
    """Compare reference numbers even if PhilGEPS adds spaces or a prefix."""
    return re.sub(r"\D", "", str(value or ""))


def csrf_token():
    """The search form needs a token that is tied to the session cookie."""
    last = None
    for attempt in range(MAX_TRIES):
        try:
            r = S.get(SEARCH, timeout=30)
            if r.status_code in (403, 429, 503):
                raise Blocked(r.status_code)
            r.raise_for_status()
            m = re.search(r'name="_csrfToken"[^>]*value="([^"]+)"', r.text)
            if not m:
                sys.exit("ERROR: could not find the search form token; the page layout may have changed")
            return m.group(1)
        except (Blocked, requests.RequestException) as e:
            last = e
            if attempt < MAX_TRIES - 1:
                wait = 5 * (attempt + 1)
                print("  token fetch failed (%s), retrying in %ds" %
                      (type(e).__name__, wait), flush=True)
                time.sleep(wait)
    raise last


def search_bid(bid_ref, token):
    data = {"_csrfToken": token, "searchAwardNoticeNo": "", "searchRefNo": str(bid_ref),
            "searchLineItem": "", "searchAwardee": "",
            "searchAwardDateFrom": "", "searchAwardDateTo": ""}
    r = S.post(SEARCH, data=data, timeout=30, headers={"Referer": SEARCH})
    if r.status_code in (403, 429, 503):
        raise Blocked(r.status_code)
    if r.status_code != 200:
        return None
    soup = BeautifulSoup(r.text, "html.parser")
    hits = []
    for tr in soup.select("table tr"):
        cells = {td.get("data-label"): td for td in tr.find_all("td") if td.get("data-label")}
        link = tr.find("a", href=re.compile(r"viewAwardNotice/(\d+)"))
        if not link or "Bid Notice Reference number" not in cells:
            continue
        found_bid = cells["Bid Notice Reference number"].get_text(strip=True)
        # The search is fuzzy, so keep only rows for this bid. Compare digits
        # only: PhilGEPS sometimes renders a reference with a prefix/spacing.
        if ref_digits(found_bid) != ref_digits(bid_ref):
            continue
        hits.append({
            "award_no": re.search(r"viewAwardNotice/(\d+)", link["href"]).group(1),
            "title": cells.get("Award Title").get_text(" ", strip=True) if cells.get("Award Title") else None,
            "awardee": cells.get("Awardee").get_text(" ", strip=True) if cells.get("Awardee") else None,
            "award_date": cells.get("Award Date").get_text(strip=True) if cells.get("Award Date") else None,
        })
    return hits


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--contracts", default="contracts.csv")
    ap.add_argument("--all", action="store_true",
                    help="look up every bid, not just ones missing an award number "
                         "(also backfills awardees from the search results)")
    ap.add_argument("--out", default="award_lookup.jsonl")
    ap.add_argument("--force", action="store_true",
                    help="search again even if this bid is already in the cache")
    ap.add_argument("--limit", type=int, help="stop after this many searches (for testing)")
    ap.add_argument("--delay", type=float, default=DELAY)
    args = ap.parse_args()

    c = pd.read_csv(args.contracts, dtype=str)
    c["bid"] = c["Bid Reference No."].fillna("").str.replace(r"\.0$", "", regex=True).str.strip()
    c["aw"] = c["Award Reference No."].fillna("").str.replace(r"\.0$", "", regex=True).str.strip()
    # A bid can have some rows already tagged with an award notice and other
    # blank rows. Those partial bids still need a lookup; skipping them was why
    # notices such as 51814 -> 27134 never made it into the cache.
    valid = c[c["bid"] != ""]
    has_blank = valid.groupby("bid")["aw"].apply(lambda s: (s == "").any())
    bids = (sorted(valid["bid"].unique()) if args.all
            else sorted(has_blank[has_blank].index))

    out_path = pathlib.Path(args.out)
    done = set()
    if out_path.exists():
        for line in out_path.open():
            try:
                d = json.loads(line)
                if d.get("status") in ("ok", "no_hits"):
                    done.add(d["bid_ref"])
            except json.JSONDecodeError:
                pass
    todo = [b for b in bids if args.force or b not in done]
    if args.limit:
        todo = todo[:args.limit]
    print("%d bids to consider; %d to search (%d already done)"
          % (len(bids), len(todo), sum(b in done and not args.force for b in bids)))
    if not todo:
        return

    token = csrf_token()
    n_ok = n_none = 0
    try:
        with out_path.open("a") as out:
            for i, bid in enumerate(todo, 1):
                hits = None
                for attempt in range(MAX_TRIES):
                    try:
                        hits = search_bid(bid, token)
                        break
                    except Blocked as e:
                        wait = 60 * (2 ** attempt)
                        print("  got %s, waiting %ds before retry %d/%d"
                              % (e, wait, attempt + 1, MAX_TRIES), flush=True)
                        time.sleep(wait)
                    except requests.RequestException as e:
                        wait = 5 * (attempt + 1)
                        print("  network error (%s), retrying in %ds (%d/%d)"
                              % (type(e).__name__, wait, attempt + 1, MAX_TRIES),
                              flush=True)
                        time.sleep(wait)
                    try:
                        token = csrf_token()
                    except requests.RequestException:
                        pass
                if hits is None:
                    row = {"bid_ref": bid, "hits": [], "status": "fetch_failed"}
                elif hits:
                    row = {"bid_ref": bid, "hits": hits, "status": "ok"}
                    n_ok += 1
                else:
                    row = {"bid_ref": bid, "hits": [], "status": "no_hits"}
                    n_none += 1
                out.write(json.dumps(row) + "\n")
                out.flush()
                print("[%d/%d] bid %s -> %s" % (i, len(todo), bid,
                      ", ".join(h["award_no"] for h in (hits or [])) or row["status"]))
                time.sleep(args.delay)
    except Blocked as e:
        print("STOPPED:", e, "- wait a few hours, then run again; it resumes where it left off.")
    print("done: %d found, %d with no award notice on the site" % (n_ok, n_none))


if __name__ == "__main__":
    main()
