import requests, time, json, pathlib
import pandas as pd
from bs4 import BeautifulSoup

BASE = "https://philgeps.gov.ph"
RECORD = BASE + "/Indexes/viewAwardNotice/{}"
DELAY = 3

S = requests.Session()
S.headers["User-Agent"] = "philgeps-mapping-project"

class Blocked(Exception): pass

def fetch_record(award_no):
    r = S.get(RECORD.format(award_no), timeout=30)
    if r.status_code in (403, 429, 503):
        raise Blocked(r.status_code)
    time.sleep(DELAY)
    return r.text if r.status_code == 200 else None

def parse_entity(html, bid_ref):
    soup = BeautifulSoup(html, "html.parser")
    name = soup.select_one("center.verdhana_bold_twelvepx")
    addr = soup.select_one("center.verdhana_twelvepx")
    ref_match = str(bid_ref) in soup.get_text(" ")   # sanity check
    return (name.get_text(" ", strip=True) if name else None,
            addr.get_text(" ", strip=True) if addr else None,
            ref_match)

targets = pd.read_csv("targets.csv", dtype=str)     # office_key, bid_ref, award_ref
# for testing, uncomment the next line:
# targets = targets.head(10)

# award numbers found by scrape.py (bid-ref search), if you ran it
lookup = {}
p = pathlib.Path("award_lookup.jsonl")
if p.exists():
    for line in p.open():
        d = json.loads(line)
        if d["hits"]:
            lookup[d["bid_ref"]] = d["hits"][0]["award_no"]

out_path = pathlib.Path("addresses_raw.jsonl")
done = {json.loads(l)["office_key"] for l in out_path.open()} if out_path.exists() else set()

try:
    with out_path.open("a") as out:
        for _, t in targets.iterrows():
            if t.office_key in done:
                continue
            award_no = t.award_ref if pd.notna(t.award_ref) and t.award_ref else lookup.get(t.bid_ref)
            row = {"office_key": t.office_key, "bid_ref": t.bid_ref, "award_no": award_no,
                   "entity_name": None, "raw_address": None, "ref_match": None,
                   "status": "ok"}
            if not award_no:
                row["status"] = "no_award_no"
            else:
                html = fetch_record(award_no)
                if not html:
                    row["status"] = "fetch_failed"
                else:
                    name, addr, ok = parse_entity(html, t.bid_ref)
                    row.update(entity_name=name, raw_address=addr, ref_match=ok)
                    if not addr:
                        row["status"] = "no_address"
                    elif not ok:
                        row["status"] = "check_ref_mismatch"
            out.write(json.dumps(row) + "\n")
            out.flush()
except Blocked as e:
    print("STOPPED, got", e, ". Wait a few hours before trying again.")