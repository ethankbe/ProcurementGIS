import os
import re
import statistics
import difflib
import time
import pymysql
from pymysql.cursors import DictCursor
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="PhilGEPS procuring entity map")
HERE = os.path.dirname(os.path.abspath(__file__))


def db_password():
    """Read DB_PASS, tolerating quotes copied from documentation."""
    pw = os.environ.get("DB_PASS")
    if pw is None:
        raise RuntimeError("DB_PASS is not set; export DB_PASS='your-app-password'")
    pw = pw.strip()
    for left, right in (("\u2018", "\u2019"), ("\u201c", "\u201d"), ("'", "'"), ('"', '"')):
        if len(pw) >= 2 and pw[0] == left and pw[-1] == right:
            pw = pw[1:-1].strip()
            break
    try:
        pw.encode("latin1")
    except UnicodeEncodeError as exc:
        raise RuntimeError("DB_PASS has a character PyMySQL cannot encode; check for "
                           "smart quotes: export DB_PASS='actual-password'") from exc
    return pw


def query(sql, args=()):
    con = pymysql.connect(host=os.environ.get("DB_HOST", "localhost"),
                          user=os.environ.get("DB_USER", "philgeps_app"),
                          password=db_password(),
                          database=os.environ.get("DB_NAME", "philgeps"),
                          charset="utf8mb4", cursorclass=DictCursor)
    try:
        with con.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()
    finally:
        con.close()


FILTER_COLS = {"region": "e.region", "province": "e.province", "city": "e.city",
               "agency": "e.name", "category": "c.category", "status": "c.status"}


def filter_params(region: str | None = None, province: str | None = None, city: str | None = None,
                  agency: str | None = None, category: str | None = None, status: str | None = None):
    f = {"region": region, "province": province, "city": city,
         "agency": agency, "category": category, "status": status}
    return {k: v for k, v in f.items() if v}


def filter_sql(f):
    """Exact-match filters chosen from the masterlists -> (conditions, args)."""
    conds = ["%s = %%s" % FILTER_COLS[k] for k in FILTER_COLS if f.get(k)]
    return conds, [f[k] for k in FILTER_COLS if f.get(k)]


def contract_budget_expr(line_bids=None):
    """Per-award budget computed at load time; fall back for older databases."""
    return "COALESCE(c.budget, c.abc, ib.total)", []


@app.get("/api/filters")
def filters():
    """Masterlists for the filter boxes, built from the loaded data."""
    ents = query("""SELECT DISTINCT e.name, e.city, e.province, e.region
                    FROM entities e
                    JOIN contracts c ON c.entity_id = e.id
                    JOIN addresses a ON a.id = e.address_id
                    WHERE a.lat IS NOT NULL""")
    regions, provinces, cities, agencies = {}, {}, {}, {}
    for r in ents:
        if r["region"]:
            regions[r["region"]] = regions.get(r["region"], 0) + 1
        if r["province"]:
            k = (r["province"], r["region"])
            provinces[k] = provinces.get(k, 0) + 1
        if r["city"]:
            k = (r["city"], r["province"], r["region"])
            cities[k] = cities.get(k, 0) + 1
        if r["name"]:
            agencies[r["name"]] = {"name": r["name"], "city": r["city"],
                                   "province": r["province"], "region": r["region"]}
    def tally(col):
        return [{"name": x["name"], "n": int(x["n"])} for x in query(
            "SELECT %s AS name, COUNT(*) AS n FROM contracts WHERE %s IS NOT NULL AND %s <> '' "
            "GROUP BY %s ORDER BY n DESC" % (col, col, col, col))]
            
    # --- Fetch the latest published date ---
    date_res = query("SELECT DATE_FORMAT(MAX(published), '%%M %%e, %%Y') AS max_date FROM contracts WHERE published IS NOT NULL")
    latest_date = date_res[0]["max_date"] if date_res and date_res[0]["max_date"] else "Unknown Date"

    return {
        "regions": [{"name": k, "n": n} for k, n in sorted(regions.items())],
        "provinces": [{"name": k[0], "region": k[1], "n": n} for k, n in sorted(provinces.items(), key=lambda i: str(i[0]))],
        "cities": [{"name": k[0], "province": k[1], "region": k[2], "n": n} for k, n in sorted(cities.items(), key=lambda i: str(i[0]))],
        "agencies": sorted(agencies.values(), key=lambda a: a["name"]),
        "categories": tally("category"), "statuses": tally("status"),
        "last_updated": latest_date 
    }


@app.get("/api/pins")
def pins(q: str | None = None, min_budget: float = 0, max_budget: float | None = None,
         min_lon: float = -180, min_lat: float = -90,
         max_lon: float = 180, max_lat: float = 90, f: dict = Depends(filter_params)):
    """One pin per address, with award counts and budget totals (GeoJSON)."""
    budget_expr, budget_args = contract_budget_expr()
    sql = f"""
      SELECT a.id, a.clean_address AS address, a.lat, a.lon,
             a.geo_precision AS `precision`,
             COUNT(c.id) AS contracts,
             COALESCE(SUM({budget_expr}), 0) AS total_budget,
             GROUP_CONCAT(DISTINCT e.name ORDER BY e.name SEPARATOR '; ') AS entities
      FROM addresses a
      JOIN entities e ON e.address_id = a.id
      JOIN contracts c ON c.entity_id = e.id
      LEFT JOIN (SELECT bid_ref, award_no, SUM(item_budget) AS total
                 FROM items GROUP BY bid_ref, award_no) ib
             ON ib.bid_ref = c.bid_ref AND ib.award_no <=> c.award_no
      WHERE a.lat BETWEEN %s AND %s AND a.lon BETWEEN %s AND %s
    """
    args = budget_args + [min_lat, max_lat, min_lon, max_lon]
    if q:
        sql += " AND e.name LIKE %s"
        args.append(f"%{q}%")
    fc, fa = filter_sql(f)
    for cond in fc:
        sql += " AND " + cond
    args += fa
    sql += " GROUP BY a.id, a.clean_address, a.lat, a.lon, a.geo_precision"
    sql += " HAVING total_budget >= %s"
    args.append(min_budget)
    if max_budget is not None:
        sql += " AND total_budget <= %s"
        args.append(max_budget)
    rows = query(sql, args)
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature",
         "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
         "properties": {"id": r["id"], "address": r["address"],
                        "precision": r["precision"], "contracts": r["contracts"],
                        "total_budget": float(r["total_budget"]),
                        "entities": r["entities"]}}
        for r in rows]}


@app.get("/api/pins/{address_id}/contracts")
def contracts(address_id: int, limit: int = Query(50, le=200), offset: int = 0,
              details: bool = False, f: dict = Depends(filter_params)):
    """Contracts for one pin. With details=1, include each contract's item lines."""
    fc, fa = filter_sql(f)
    extra = "".join(" AND " + x for x in fc)
    budget_expr, budget_args = contract_budget_expr()
    rows = query(f"""
      SELECT c.bid_ref, c.award_no, c.title, c.unit, {budget_expr} AS abc,
             ((c.budget IS NOT NULL AND c.budget <> c.abc)
              OR (c.abc IS NULL AND ib.total IS NOT NULL)) AS derived,
             c.published, c.status, c.awardee, e.name
      FROM contracts c JOIN entities e ON e.id = c.entity_id
      LEFT JOIN (SELECT bid_ref, award_no, SUM(item_budget) AS total
                 FROM items GROUP BY bid_ref, award_no) ib
             ON ib.bid_ref = c.bid_ref AND ib.award_no <=> c.award_no
      WHERE e.address_id = %s""" + extra +
      " ORDER BY c.published DESC, c.bid_ref DESC, c.award_no DESC LIMIT %s OFFSET %s",
      budget_args + [address_id] + fa + [limit, offset])

    out = [{**r, "abc": float(r["abc"]) if r["abc"] is not None else None,
            "derived": bool(r["derived"]),
            "award_id": r["award_no"], "awardee": r["awardee"],
            "published": str(r["published"]) if r["published"] else None}
           for r in rows]

    if details and out:
        pairs = [(r["bid_ref"], r["award_no"]) for r in out]
        where = " OR ".join("(i.bid_ref = %s AND i.award_no <=> %s)" for _ in pairs)
        item_rows = query(f"""
          SELECT i.bid_ref, i.award_no, i.item_name, i.item_desc,
                 i.quantity, i.uom, i.item_budget
          FROM items i WHERE {where}
          ORDER BY i.bid_ref, i.award_no, i.id
        """, [v for pair in pairs for v in pair])
        line_bids = line_item_bids()
        titles = {(r["bid_ref"], r["award_no"]): r["title"] for r in out}
        by_key = {}
        for ir in item_rows:
            qty = float(ir["quantity"]) if ir["quantity"] is not None else None
            bud = float(ir["item_budget"]) if ir["item_budget"] is not None else None
            uom = (ir["uom"] or "").strip().lower()
            name = clean_text(ir["item_name"])
            desc = clean_text(ir["item_desc"])
            bundled = bool(BUNDLE_TERMS.search(f"{name} {desc}"))
            comparable = bool(ir["bid_ref"] in line_bids and qty and qty > 0 and bud is not None
                              and uom not in NON_UNIT and not bundled)
            key = (ir["bid_ref"], ir["award_no"])
            primary, secondary = best_item_label(name, desc, titles.get(key, ""))
            by_key.setdefault(key, []).append({
                "item": primary,
                "item_name": name or None,
                "item_desc": desc or None,
                "item_secondary": secondary,
                "description": desc or None,
                "quantity": qty, "uom": clean_text(ir["uom"]), "item_budget": bud,
                "unit_budget": bud / qty if comparable else None,
                "comparable": comparable,
            })
        for r in out:
            r["items"] = by_key.get((r["bid_ref"], r["award_no"]), [])

    return out


# ---------------------------------------------------------------------------
# Item search and price comparison
# ---------------------------------------------------------------------------
# Quantities in these units describe a bundle, not one piece, so dividing the
# budget by the quantity does not give a comparable per-unit figure.
NON_UNIT = {"lot", "lots", "set", "sets", "job", "project", "package", "pkg",
            "lump sum", "lumpsum", "ls", "contract", "service", "services",
            "pack", "box", "bundle", "ream", "carton", "case", "month", "year"}
# A description that lists several goods ("... and five (5) others ...") means
# the budget covers a basket, not the single item being searched for.
BUNDLE_TERMS = re.compile(r"(?:\band\b|\bothers?\b|\bvarious\b|\bassorted\b|"
                          r"\bincluding\b|\bplus\b|\betc\b|&|/)", re.I)
# A bid notice title lists every lot ("laptop ..., antivirus ..."), so it must
# not be enough on its own to put a row in a product search. It may only supply
# the *other* half of a multi-word query once an item field anchors the match.
# Device searches also skip accessories/consumables that mention the device.
DEVICE_TERMS = {
    "computer", "laptop", "notebook", "notebook computer", "mobile workstation",
    "desktop", "desktop computer", "personal computer", "pc", "all in one computer",
    "printer", "inkjet printer", "multi function printer", "multifunction printer", "mfp",
    "photocopier", "copier", "copy machine", "xerox",
    "scanner", "barcode scanner", "qr code scanner",
    "projector", "multimedia projector", "lcd projector",
    "monitor", "lcd monitor", "computer monitor", "tv", "television", "smart tv",
    "cellphone", "mobile phone", "cell phone", "smartphone",
    "camera", "cctv", "camcorder", "video camera",
    "drone", "aerial camera", "uav", "quadcopter",
    "server", "tablet", "router",
    "ssd", "solid state drive", "hdd", "hard drive", "hard disk", "external hard drive",
    "flash drive", "usb drive", "thumb drive", "pen drive",
    "network cable", "lan cable", "utp cable", "ethernet cable", "patch cord",
    "two way radio", "walkie talkie", "handheld radio",
    "headset", "headphone", "headphones", "microphone", "mic",
    "generator", "genset", "generator set", "license", "licence",
}
# A head noun in this set means the line is a part, accessory or consumable
# even when its name/description starts with the searched device ("Computer
# cable", "Computer accessory kits", "RJ 45 Connector Cat 6").
ACCESSORY_TERMS = (
    "charging cable", "power adapter", "carrying case", "docking station",
    "screen protector", "mouse pad", "crimping tool", "patch panel", "patch cord",
    "keystone jack", "network connector", "rj 45 connector", "rj45 connector",
    "connector", "accessory", "accessories", "kit", "spare", "component",
    "enclosure", "cover", "screen", "display screen",
    "charger", "adapter", "bag", "sleeve",
    "stand", "mount", "bracket", "dock", "cable", "cord", "mouse", "keyboard",
    "battery", "pouch", "strap", "tripod", "lens", "filter", "ink", "toner",
    "print head", "printhead", "developer", "cartridge", "paper", "ribbon", "drum",
    "cleaning solution", "cleaning tool",
    "software", "subscription", "license", "licence",
)
ACCESSORY_RE = re.compile(r"\b(?:" + "|".join(
    re.escape(t) for t in sorted(ACCESSORY_TERMS, key=len, reverse=True)) + r")\b")
DEVICE_RE = re.compile(r"\b(?:" + "|".join(
    r"\s+".join(re.escape(w) for w in t.split()) + r"s?"
    for t in sorted(DEVICE_TERMS, key=len, reverse=True)) + r")\b")
# Taxonomy names for computers are more specific than the bare word. A plain
# "computer" search should accept all of them as the same head noun.
COMPUTER_TERMS = {
    "computer", "desktop computer", "personal computer", "notebook computer",
    "all in one computer", "tablet computer",
    "mobile workstation", "laptop", "notebook", "pc", "tablet", "minicomputer",
}
# When these words directly follow a device name, they are the real head noun:
# "computer speakers" is a speaker, not a computer.
OVERRIDE_HEAD_RE = re.compile(
    r"^(?:data input device|data|peripherals?|speakers?|earphones?|headphones?|"
    r"microphones?|televisions?|tvs?|tuners?|monitors?|screens?|displays?|"
    r"memory|ram|motherboards?|processors?|cpus?|chassis|cabinets?|lockers?|"
    r"servers?|covers?|connectors?|cables?|kits?|accessor(?:y|ies)|software|"
    r"subscription|switches|switch|boxes?|cooling|fan|thermal pad)\b")
HEAD_TOKENS = 9
ROW_LIMIT = 5000


def norm_term(t):
    return re.sub(r"[^a-z0-9]+", " ", str(t).lower()).strip()


def clean_text(t):
    """Collapse spreadsheet newlines/tabs so item descriptions display cleanly."""
    return re.sub(r"\s+", " ", str(t or "")).strip()


def singular_device(word):
    return word[:-1] if word.endswith("s") and not word.endswith("ss") else word


def accessory_set(text):
    """Accessory words found in text, normalized so singular/plural both work."""
    return {singular_device(w) for w in ACCESSORY_RE.findall(norm_term(text))}


def accessory_head(name, desc):
    """True when the leading words name an accessory rather than the device.

    Only the head of each label is checked: long specifications often list
    included peripherals (mouse, keyboard, cable) for a genuine computer.
    """
    for text in (name, desc):
        head = " ".join(norm_term(text).split()[:HEAD_TOKENS])
        if head and ACCESSORY_RE.search(head):
            return True
    return False


def query_device_terms(alts):
    terms = set(alts)
    if "computer" in terms:
        terms |= COMPUTER_TERMS
    return terms


def device_head_ok(name, desc, allowed):
    """True when the label is headed by the device being searched for.

    "Computer speakers" and "Desktop Computer Memory" mention the device but
    are actually another product. ``pc`` after a number is a quantity, not a
    device, so "1 pc Earphone" cannot pose as a computer.
    """
    def check(text):
        lead = " ".join(norm_term(text).split()[:HEAD_TOKENS])
        blocked = False
        for m in DEVICE_RE.finditer(lead):
            term = singular_device(m.group(0))
            before = lead[:m.start()].split()
            if term == "pc" and before and before[-1].isdigit():
                continue
            rest = lead[m.end():].strip()
            if OVERRIDE_HEAD_RE.match(rest):
                return "bad"
            if term in allowed:
                return "good" if not blocked else "bad"
            blocked = True
        return None

    name_result = check(name)
    if name_result:
        return name_result == "good"
    return check(desc) == "good"


# PhilGEPS gives a controlled taxonomy name and a free-text description. Neither
# is always the better label, so score both and promote the more specific one.
BOILERPLATE = re.compile(
    r"\b(?:supply(?: and delivery)?|procurement(?: of)?|please see attached|"
    r"request for quotation|rfq no|schedule of requirements|terms of reference|"
    r"for the use of|various|others?|etc\.?|lot)\b", re.I)
SPECIFIC_UNIT = re.compile(
    r"\b\d+\s*(?:gb|tb|mb|ghz|mhz|w|watts?|mm|cm|inches|inch|pcs?|pieces?|units?|sets?)\b",
    re.I)
MODEL_NO = re.compile(r"\b[A-Z]{1,5}[-/]?\d{2,}[A-Z0-9/-]*\b")
DIGITS = re.compile(r"\d+")


def label_tokens(text):
    out = set()
    for w in norm_term(text).split():
        if len(w) < 3:
            continue
        out.add(w[:-1] if w.endswith("s") and len(w) > 3 else w)
    return out


def label_score(text, other=""):
    t = clean_text(text)
    if not t:
        return -100.0
    score = min(len(t), 90) / 30
    score += min(len(DIGITS.findall(t)), 6) * 0.75
    if SPECIFIC_UNIT.search(t):
        score += 2
    if MODEL_NO.search(t):
        score += 2
    score -= 2.5 * len(BOILERPLATE.findall(t))
    if BOILERPLATE.match(t):
        score -= 3
    if len(t) > 180:
        score -= (len(t) - 180) / 60

    # A short label with no words in common is often the real item name
    # ("Laptop" vs "Notebook computers"). Near-duplicates add no information.
    a, b = label_tokens(t), label_tokens(other)
    if a and b:
        overlap = len(a & b) / min(len(a), len(b))
        if not overlap and len(t) <= 90:
            score += 1.5
        elif overlap >= 0.8:
            score -= 1.5
    return score


def best_item_label(name, desc, title=""):
    """Return (primary label, optional secondary label) from name/description."""
    n, d = clean_text(name), clean_text(desc)
    if not n and not d:
        return clean_text(title), None
    if not d or n.lower() == d.lower() or norm_term(n) == norm_term(d):
        return n or d, None

    ns = label_score(n, d)
    ds = label_score(d, n)
    if title and norm_term(d) == norm_term(title):
        ds -= 4  # description is just the lot notice copied over
    use_desc = ds >= ns + 0.4

    primary = d if use_desc else n
    other = n if use_desc else d
    secondary = None
    if other and label_score(other, primary) >= 0.5 and \
            norm_term(other) != norm_term(primary):
        secondary = other if len(other) <= 160 else other[:157] + "..."
    return clean_text(primary), secondary


def like(text):
    return "%" + re.sub(r"([\\%_])", r"\\\1", text) + "%"


_syn = {"mtime": None, "index": {}}
SYN_FILE = os.environ.get("SYNONYMS_FILE") or os.path.join(HERE, "synonyms.txt")


def synonyms():
    """term -> set of equivalent terms, re-read whenever synonyms.txt changes."""
    try:
        mtime = os.path.getmtime(SYN_FILE)
    except OSError:
        return {}
    if mtime != _syn["mtime"]:
        index = {}
        for line in open(SYN_FILE, encoding="utf-8"):
            line = line.split("#", 1)[0]
            if "=" not in line:
                continue
            left, right = line.split("=", 1)
            group = {norm_term(left)} | {norm_term(t) for t in right.split(",")}
            group.discard("")
            for t in group:
                index.setdefault(t, set()).update(group)
        _syn.update(mtime=mtime, index=index)
    return _syn["index"]


def expand_term(w, index):
    """Known synonyms; also close matches, so small typos still find something."""
    if w in index:
        return index[w]
    alts = {w}
    if len(w) >= 4:
        for hit in difflib.get_close_matches(w, index.keys(), n=2, cutoff=0.82):
            alts |= index[hit]
    return alts


REF_PREFIX_RE = re.compile(
    r"^\s*(?:award(?:\s+(?:notice|no\.?|number|ref(?:erence)?)?)?|"
    r"bid(?:\s+(?:notice|no\.?|number|ref(?:erence)?)?)?|"
    r"ref(?:erence)?)\s*[:\-#]?\s*", re.I)


def reference_query(q):
    """Return (kind, refs) for a pure bid/award reference search, else None.

    ``44795`` searches both fields. ``Bid 44795`` and ``Award 31637`` search
    one field. Comma-separated references are OR'd. Product terms are left to
    the normal item search, so ``laptop 44795`` is not mistaken for a number.
    """
    parts = [p.strip() for p in str(q or "").split(",") if p.strip()]
    if not parts or len(parts) > 5:
        return None
    refs, kinds = [], set()
    for part in parts:
        m = REF_PREFIX_RE.match(part)
        if m:
            value = re.sub(r"\D", "", part[m.end():])
            kind = ("award" if m.group(0).lower().startswith("award") else
                    "bid" if m.group(0).lower().startswith("bid") else None)
        else:
            if not re.fullmatch(r"[\d\s-]+", part):
                return None
            value = re.sub(r"\D", "", part)
            kind = None
        if not value:
            return None
        refs.append(value)
        kinds.add(kind or "both")
        if len(kinds) > 1:
            return None
    return next(iter(kinds)), refs


def reference_clause(kind, refs):
    """SQL condition and args for a reference search."""
    parts, args = [], []
    for ref in refs:
        if kind in ("both", "bid"):
            parts.append("c.bid_ref = %s")
            args.append(ref)
        if kind in ("both", "award"):
            parts.append("c.award_no = %s")
            args.append(ref)
    return "(" + " OR ".join(parts) + ")", args


def parse_query(q):
    """Comma = OR, space = AND, quoted phrase = exact phrase.
    Words also match their synonyms, plurals and small typos.
    Returns OR-groups; each is a list of AND-parts; each part is a list of alternatives."""
    index, groups = synonyms(), []
    for g in [x.strip() for x in q.split(",") if x.strip()][:5]:
        phrase = g.startswith('"') and g.endswith('"') and len(g) > 2
        gn = norm_term(g[1:-1] if phrase else g)
        if not gn:
            continue
        if phrase or gn in index:             # a whole phrase / known term
            groups.append([sorted(a[:60] for a in (index.get(gn) or {gn}))])
        else:
            groups.append([sorted(a[:60] for a in expand_term(w, index))
                           for w in gn.split()[:5]])
    if not groups:
        raise HTTPException(status_code=400, detail="Enter at least one search word")
    return groups


def search_clause(groups):
    """Loose SQL filter (first word of each alternative); exact matching happens in Python."""
    ors, args = [], []
    for parts in groups:
        ands = []
        for alts in parts:
            inner = []
            for a in alts:
                inner.append("(i.item_name LIKE %s OR i.item_desc LIKE %s OR c.title LIKE %s)")
                args += [like(a.split()[0])] * 3
            ands.append("(" + " OR ".join(inner) + ")")
        ors.append("(" + " AND ".join(ands) + ")")
    return "(" + " OR ".join(ors) + ")", args


def make_matcher(groups):
    """Whole-word matching, anchored on the item fields.

    With one argument this behaves as before. When ``secondary`` (the bid
    notice title) is supplied, at least one part must match the item name or
    description; the title may only satisfy the remaining parts. This keeps a
    lot from inheriting every other lot named in a shared bid title.
    """
    def rx(alt):
        words = alt.split()
        last = words[-1]
        pat = r"\b" + r"\s+".join(re.escape(w) for w in words)
        # "laptop" also matches "laptops", without matching "laptopbag"
        if len(last) >= 3 and not last.endswith("s"):
            pat += r"(?:es|s)?"
        return re.compile(pat + (r"\b" if len(last) <= 3 else ""))
    comp = [[[rx(a) for a in alts] for alts in parts] for parts in groups]

    def hit(alts, text):
        return any(r.search(text) for r in alts)

    def ok(primary, secondary=None):
        t = norm_term(primary)
        if secondary is None:
            return any(all(hit(alts, t) for alts in parts) for parts in comp)
        s = norm_term(secondary)
        for parts in comp:
            anchored = [hit(alts, t) for alts in parts]
            if not any(anchored):
                continue
            if all(anchored) or all(anchored[i] or hit(alts, s)
                                    for i, alts in enumerate(parts)):
                return True
        return False
    return ok


def device_query_text(q, groups):
    """Normalized query text when it names a main device, else None."""
    for parts in groups:
        alternatives = {alt for alts in parts for alt in alts}
        if alternatives & DEVICE_TERMS:
            return norm_term(q)
    return None


_line_bids = {"at": 0, "ids": set()}


def line_item_bids():
    """Bids whose item budgets are real per-line budgets, not the whole contract
    budget copied onto every row. A line budget exists when several item rows
    add up to the contract ABC (or a single row is smaller than the ABC).
    Cached briefly; refresh happens automatically after a DB reload."""
    if time.time() - _line_bids["at"] < 60:
        return _line_bids["ids"]
    rows = query("""SELECT i.bid_ref, COUNT(*) AS n, SUM(i.item_budget) AS total,
                           MAX(c.abc) AS abc
                    FROM items i JOIN contracts c
                      ON c.bid_ref = i.bid_ref AND c.award_no <=> i.award_no
                    GROUP BY i.bid_ref""")
    ids = set()
    for r in rows:
        total, abc = r["total"], r["abc"]
        if total is None or abc is None:
            continue
        tol = max(1.0, abs(float(abc)) * 0.01)
        diff = abs(float(total) - float(abc))
        if (r["n"] > 1 and diff <= tol) or (r["n"] == 1 and float(total) < float(abc) - tol):
            ids.add(r["bid_ref"])
    _line_bids.update(at=time.time(), ids=ids)
    return ids


def fetch_rows(q, address_ids=None, filters=None, min_budget=0, max_budget=None):
    ref_search = reference_query(q)
    if ref_search:
        kind, refs = ref_search
        clause, args = reference_clause(kind, refs)
        matches = lambda primary, secondary=None: True
        groups, device_q = [], None
    else:
        groups = parse_query(q)
        clause, args = search_clause(groups)
        matches = make_matcher(groups)
        device_q = device_query_text(q, groups)
    device_has_accessory = bool(device_q and ACCESSORY_RE.search(device_q))
    # One plain device term (not "laptop charger" or an OR query): a taxonomy
    # name for a different device should not win just because the shared bid
    # title mentions the searched one.
    device_alt, query_accessories = None, set()
    if device_q and len(groups) == 1:
        alts = {alt for parts in groups[0] for alt in parts}
        device_alt = sorted(alts & DEVICE_TERMS) or None
        query_accessories = accessory_set(device_q)
    line_bids = line_item_bids()
    where = ["a.lat IS NOT NULL", clause]

    if min_budget > 0:
        where.append("i.item_budget >= %s")
        args.append(min_budget)

    if max_budget is not None:
        where.append("i.item_budget <= %s")
        args.append(max_budget)

    fc, fa = filter_sql(filters or {})
    where += fc
    args = args + fa
    if address_ids:
        where.append("a.id IN (" + ",".join(["%s"] * len(address_ids)) + ")")
        args = args + list(address_ids)
    rows = query("""
      SELECT i.bid_ref, i.item_name, i.item_desc, i.quantity, i.uom, i.item_budget,
             c.title, c.published, c.status, c.award_no, c.awardee,
             e.name AS entity, e.region AS region,
             a.id AS address_id, a.clean_address AS address,
             a.lat, a.lon, a.geo_precision AS `precision`
      FROM items i
      JOIN contracts c ON c.bid_ref = i.bid_ref AND c.award_no <=> i.award_no
      JOIN entities e ON e.id = c.entity_id
      JOIN addresses a ON a.id = e.address_id
      WHERE """ + " AND ".join(where) + " ORDER BY c.published DESC LIMIT %s",
      args + [ROW_LIMIT + 1])
    
    truncated = len(rows) > ROW_LIMIT
    out = []
    for r in rows[:ROW_LIMIT]:
        name = clean_text(r["item_name"])
        desc = clean_text(r["item_desc"])
        item_text = f"{name} {desc}"
        if not matches(item_text, r["title"] or ""):
            continue
        # "computer" should find computers, not RJ45 connectors, speakers,
        # monitors or TVs. Check the head of each label; specifications often
        # list included peripherals further down.
        if device_q and not device_has_accessory and accessory_head(name, desc):
            continue
        if device_q and not device_has_accessory and device_alt and not device_head_ok(
                name, desc, query_device_terms(device_alt)):
            continue
        if device_alt:
            lead160 = norm_term(f"{name} {desc[:160]}")
            # "laptop charger" must actually name the charger in the product
            # label, not merely list one among the inclusions further down.
            if query_accessories and not query_accessories.issubset(
                    accessory_set(lead160)):
                continue
            name_devices = {singular_device(x) for x in DEVICE_RE.findall(norm_term(name))}
            allowed = query_device_terms(device_alt)
            if name_devices and not (name_devices & allowed):
                lead = norm_term(desc[:80])
                starts = list(device_alt)
                if "computer" in device_alt:
                    starts += list(COMPUTER_TERMS)
                starts_with_query = any(
                    re.match(r"\b" + r"\s+".join(re.escape(w) for w in alt.split()) +
                             r"(?:es|s)?\b", lead)
                    for alt in starts)
                if not starts_with_query:
                    continue
        qty = float(r["quantity"]) if r["quantity"] is not None else None
        bud = float(r["item_budget"]) if r["item_budget"] is not None else None
        uom = (r["uom"] or "").strip().lower()
        bundled = bool(BUNDLE_TERMS.search(f"{name} {desc}"))
        comparable = bool(r["bid_ref"] in line_bids and qty and qty > 0 and bud is not None
                          and uom not in NON_UNIT and not bundled)

        primary, secondary = best_item_label(name, desc, r["title"])
        out.append({
            "bid_ref": r["bid_ref"], "award_id": r["award_no"], "awardee": r["awardee"],
            "item": primary,
            "item_name": name or None,
            "item_desc": desc or None,
            "item_secondary": secondary,
            "description": desc or None, "title": r["title"],
            "quantity": qty, "uom": clean_text(r["uom"]), "item_budget": bud,
            "unit_budget": bud / qty if comparable else None,
            "comparable": comparable,
            "published": str(r["published"]) if r["published"] else None,
            "status": r["status"], "entity": r["entity"], "region": r["region"],
            "address_id": r["address_id"], "address": r["address"],
            "lat": r["lat"], "lon": r["lon"], "precision": r["precision"],
        })
    return out, truncated


def summarize(rows):
    units = [r["unit_budget"] for r in rows if r["comparable"]]
    lots = [r["item_budget"] for r in rows
            if not r["comparable"] and r["item_budget"] is not None]
    return {
        "n_items": len(rows),
        "n_comparable": len(units),
        "n_lots": len(rows) - len(units),
        "total_qty": sum(r["quantity"] for r in rows if r["comparable"]),
        "min_unit": min(units) if units else None,
        "median_unit": statistics.median(units) if units else None,
        "mean_unit": statistics.fmean(units) if units else None,
        "max_unit": max(units) if units else None,
        "lot_min": min(lots) if lots else None,
        "lot_median": statistics.median(lots) if lots else None,
        "lot_max": max(lots) if lots else None,
    }


SUMMARY_FIELDS = ("address_id", "entity", "region", "address", "award_id", "bid_ref",
                  "awardee", "item", "item_secondary", "quantity", "uom",
                  "item_budget", "unit_budget", "published")


def summary_row(r):
    """Keep enough detail in an extreme row to identify and open its location."""
    out = {k: r.get(k) for k in SUMMARY_FIELDS}
    if not out.get("region"):
        out["region"] = "Unspecified region"
    return out


def price_extremes(rows, field):
    """Lowest and highest value in a group, with stable tie-breaking."""
    ordered = sorted(rows, key=lambda r: (
        round(float(r[field]), 2),
        str(r.get("item") or "").lower(),
        str(r.get("bid_ref") or ""),
        str(r.get("award_id") or ""),
    ))
    return summary_row(ordered[0]), summary_row(ordered[-1])


def summarize_group(rows, field):
    """National and regional extremes for one kind of budget value."""
    usable = []
    for r in rows:
        try:
            if r.get(field) is None or float(r[field]) <= 0:
                continue
        except (TypeError, ValueError):
            continue
        usable.append(r)
    if not usable:
        return {"available": 0, "national": None, "regions": []}

    by_region = {}
    for r in usable:
        by_region.setdefault((r.get("region") or "").strip() or "Unspecified region", []).append(r)

    regions = []
    for name, rs in sorted(by_region.items(), key=lambda kv: kv[0].lower()):
        low, high = price_extremes(rs, field)
        regions.append({
            "region": name,
            "count": len(rs),
            "median": statistics.median([float(r[field]) for r in rs]),
            "lowest": low,
            "highest": high,
        })

    low, high = price_extremes(usable, field)
    return {
        "available": len(usable),
        "national": {
            "count": len(usable),
            "median": statistics.median([float(r[field]) for r in usable]),
            "lowest": low,
            "highest": high,
        },
        "regions": regions,
    }


def price_summaries(rows):
    """National and regional cheapest/dearest lines for one item search.

    Per-item estimates and whole-lot budgets are kept apart: a whole-lot value
    covers the full bundle, so mixing the two would be misleading.
    """
    per_item = [r for r in rows if r.get("comparable")]
    whole_lot = [r for r in rows if not r.get("comparable")]
    return {
        "per_item": summarize_group(per_item, "unit_budget"),
        "whole_lot": summarize_group(whole_lot, "item_budget"),
    }


@app.get("/api/items/pins")
def item_pins(q: str = Query(..., min_length=2, max_length=200), 
              min_budget: float = 0, max_budget: float = 10000000, 
              f: dict = Depends(filter_params)):
    """Locations that bought items matching q, with per-location price stats."""
    rows, truncated = fetch_rows(q, None, f, min_budget, max_budget)
    by_addr = {}
    for r in rows:
        by_addr.setdefault(r["address_id"], []).append(r)
    features = []
    for aid, rs in by_addr.items():
        first = rs[0]
        props = {"id": aid, "address": first["address"], "precision": first["precision"],
                 "entities": "; ".join(sorted({x["entity"] for x in rs})),
                 **summarize(rs)}
        features.append({"type": "Feature",
                         "geometry": {"type": "Point", "coordinates": [first["lon"], first["lat"]]},
                         "properties": props})
    return {"type": "FeatureCollection", "features": features, "truncated": truncated,
            "summary": price_summaries(rows)}


@app.get("/api/items/compare")
def item_compare(q: str = Query(..., min_length=2, max_length=200), a: int = 0, b: int = 0,
                 min_budget: float = 0, max_budget: float = 10000000, # <--- Added these!
                 f: dict = Depends(filter_params)):
    """Side-by-side price stats and item lines for two locations."""
    
    # Pass the budgets into fetch_rows so the comparison tray matches the map!
    rows, truncated = fetch_rows(q, [a, b], f, min_budget, max_budget) 
    
    result = {"truncated": truncated}
    for key, aid in (("a", a), ("b", b)):
        rs = sorted((r for r in rows if r["address_id"] == aid),
                    key=lambda r: (r["unit_budget"] is None, r["unit_budget"] or 0))
        result[key] = {
            "address_id": aid,
            "address": rs[0]["address"] if rs else None,
            "entities": sorted({r["entity"] for r in rs}),
            **summarize(rs),
            "lines": [{k: r[k] for k in ("bid_ref", "award_id", "awardee", "item",
                                         "item_name", "item_desc", "item_secondary",
                                         "quantity", "uom", "item_budget", "unit_budget",
                                         "comparable", "published", "status", "entity")}
                      for r in rs[:100]],
        }
    return result


@app.get("/api/items/suggest")
def item_suggest(q: str = Query(..., min_length=2, max_length=60)):
    """Search-box suggestions: reference numbers, synonyms, then item names."""
    ref_search = reference_query(q)
    if ref_search:
        kind, refs = ref_search
        clause, args = reference_clause(kind, refs)
        rows = query("SELECT DISTINCT bid_ref, award_no, published FROM contracts WHERE " +
                     clause + " ORDER BY published DESC LIMIT 10", args)
        out = []
        for r in rows:
            if kind in ("both", "bid") and r.get("bid_ref"):
                label = "Bid " + str(r["bid_ref"])
                if label not in out:
                    out.append(label)
            award = r.get("award_no")
            if kind in ("both", "award") and award and "NO-AWARD-NO-" not in str(award):
                label = "Award " + str(award)
                if label not in out:
                    out.append(label)
        return out[:10]
    ql = norm_term(q)
    vocab = sorted(synonyms())
    out = [t for t in vocab if t.startswith(ql)]
    for hit in difflib.get_close_matches(ql, vocab, n=5, cutoff=0.8):
        if hit not in out:
            out.append(hit)
    rows = query("""SELECT item_name, COUNT(*) AS n FROM items WHERE item_name LIKE %s
                    GROUP BY item_name ORDER BY n DESC LIMIT 10""", (like(q.strip()),))
    seen = {o.lower() for o in out}
    for r in rows:
        name = (r["item_name"] or "").strip()
        if name and name.lower() not in seen:
            out.append(name); seen.add(name.lower())
    return out[:10]


app.mount("/", StaticFiles(directory=os.path.join(HERE, "web"), html=True), name="web")
