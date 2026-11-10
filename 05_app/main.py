import os
import re
import statistics
import pymysql
from pymysql.cursors import DictCursor
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="PhilGEPS procuring entity map")
HERE = os.path.dirname(os.path.abspath(__file__))


def query(sql, args=()):
    con = pymysql.connect(host=os.environ.get("DB_HOST", "localhost"),
                          user=os.environ.get("DB_USER", "philgeps_app"),
                          password=os.environ["DB_PASS"],
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


@app.get("/api/filters")
def filters():
    """Masterlists for the filter boxes, built from the loaded data."""
    ents = query("""SELECT e.name, e.city, e.province, e.region FROM entities e
                    JOIN addresses a ON a.id = e.address_id WHERE a.lat IS NOT NULL""")
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
    return {
        "regions": [{"name": k, "n": n} for k, n in sorted(regions.items())],
        "provinces": [{"name": k[0], "region": k[1], "n": n} for k, n in sorted(provinces.items(), key=lambda i: str(i[0]))],
        "cities": [{"name": k[0], "province": k[1], "region": k[2], "n": n} for k, n in sorted(cities.items(), key=lambda i: str(i[0]))],
        "agencies": sorted(agencies.values(), key=lambda a: a["name"]),
        "categories": tally("category"), "statuses": tally("status"),
    }


@app.get("/api/pins")
def pins(q: str | None = None, min_budget: float = 0,
         min_lon: float = -180, min_lat: float = -90,
         max_lon: float = 180, max_lat: float = 90, f: dict = Depends(filter_params)):
    """One pin per address, with contract counts and budget totals (GeoJSON)."""
    sql = """
      SELECT a.id, a.clean_address AS address, a.lat, a.lon,
             a.geo_precision AS `precision`,
             COUNT(c.id) AS contracts,
             COALESCE(SUM(COALESCE(c.abc, ib.total)), 0) AS total_budget,
             GROUP_CONCAT(DISTINCT e.name ORDER BY e.name SEPARATOR '; ') AS entities
      FROM addresses a
      JOIN entities e ON e.address_id = a.id
      LEFT JOIN contracts c ON c.entity_id = e.id
      LEFT JOIN (SELECT bid_ref, SUM(item_budget) AS total FROM items GROUP BY bid_ref) ib
             ON ib.bid_ref = c.bid_ref
      WHERE a.lat BETWEEN %s AND %s AND a.lon BETWEEN %s AND %s
    """
    args = [min_lat, max_lat, min_lon, max_lon]
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
              f: dict = Depends(filter_params)):
    fc, fa = filter_sql(f)
    extra = "".join(" AND " + x for x in fc)
    rows = query("""
      SELECT c.bid_ref, c.title, c.unit, COALESCE(c.abc, ib.total) AS abc,
             (c.abc IS NULL AND ib.total IS NOT NULL) AS derived,
             c.published, c.status, e.name
      FROM contracts c JOIN entities e ON e.id = c.entity_id
      LEFT JOIN (SELECT bid_ref, SUM(item_budget) AS total FROM items GROUP BY bid_ref) ib
             ON ib.bid_ref = c.bid_ref
      WHERE e.address_id = %s""" + extra + " ORDER BY c.published DESC LIMIT %s OFFSET %s",
      [address_id] + fa + [limit, offset])
    return [{**r, "abc": float(r["abc"]) if r["abc"] is not None else None,
             "derived": bool(r["derived"]),
             "published": str(r["published"]) if r["published"] else None}
            for r in rows]


# ---------------------------------------------------------------------------
# Item search and price comparison
# ---------------------------------------------------------------------------
# Quantities in these units describe a bundle, not one piece, so dividing the
# budget by the quantity does not give a comparable per-unit figure.
NON_UNIT = {"lot", "lots", "set", "sets", "job", "project", "package", "pkg",
            "lump sum", "lumpsum", "ls", "contract", "service", "services"}
ROW_LIMIT = 5000


def norm_term(t):
    return re.sub(r"[^a-z0-9]+", " ", str(t).lower()).strip()


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


def parse_query(q):
    """Comma = OR, space = AND, and every word or phrase also matches its synonyms.
    Returns OR-groups; each is a list of AND-parts; each part is a list of alternatives."""
    index, groups = synonyms(), []
    for g in [x.strip() for x in q.split(",") if x.strip()][:5]:
        gn = norm_term(g)
        if not gn:
            continue
        if gn in index:                       # the whole group is a known term or phrase
            groups.append([sorted(a[:60] for a in index[gn])])
        else:
            groups.append([sorted(a[:60] for a in index.get(w, {w})) for w in gn.split()[:5]])
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
    """Whole-word matching: a term must start at a word boundary, and terms of
    3 letters or fewer must be whole words (so 'ink' does not match 'inkjet')."""
    def rx(alt):
        words = alt.split()
        pat = r"\b" + r"\s+".join(re.escape(w) for w in words)
        return re.compile(pat + (r"\b" if len(words[-1]) <= 3 else ""))
    comp = [[[rx(a) for a in alts] for alts in parts] for parts in groups]
    def ok(text):
        t = norm_term(text)
        return any(all(any(r.search(t) for r in alts) for alts in parts) for parts in comp)
    return ok


def fetch_rows(q, address_ids=None, filters=None):
    groups = parse_query(q)
    clause, args = search_clause(groups)
    matches = make_matcher(groups)
    where = ["a.lat IS NOT NULL", clause]
    fc, fa = filter_sql(filters or {})
    where += fc
    args = args + fa
    if address_ids:
        where.append("a.id IN (" + ",".join(["%s"] * len(address_ids)) + ")")
        args = args + list(address_ids)
    rows = query("""
      SELECT i.bid_ref, i.item_name, i.item_desc, i.quantity, i.uom, i.item_budget,
             c.title, c.published, c.status,
             e.name AS entity, a.id AS address_id, a.clean_address AS address,
             a.lat, a.lon, a.geo_precision AS `precision`
      FROM items i
      JOIN contracts c ON c.bid_ref = i.bid_ref
      JOIN entities e ON e.id = c.entity_id
      JOIN addresses a ON a.id = e.address_id
      WHERE """ + " AND ".join(where) + " ORDER BY c.published DESC LIMIT %s",
      args + [ROW_LIMIT + 1])
    truncated = len(rows) > ROW_LIMIT
    out = []
    for r in rows[:ROW_LIMIT]:
        if not matches(f"{r['item_name'] or ''} {r['item_desc'] or ''} {r['title'] or ''}"):
            continue
        qty = float(r["quantity"]) if r["quantity"] is not None else None
        bud = float(r["item_budget"]) if r["item_budget"] is not None else None
        uom = (r["uom"] or "").strip().lower()
        comparable = bool(qty and qty > 0 and bud is not None and uom not in NON_UNIT)
        out.append({
            "bid_ref": r["bid_ref"], "item": r["item_name"] or r["title"],
            "description": r["item_desc"], "title": r["title"],
            "quantity": qty, "uom": r["uom"], "item_budget": bud,
            "unit_budget": bud / qty if comparable else None,
            "comparable": comparable,
            "published": str(r["published"]) if r["published"] else None,
            "status": r["status"], "entity": r["entity"],
            "address_id": r["address_id"], "address": r["address"],
            "lat": r["lat"], "lon": r["lon"], "precision": r["precision"],
        })
    return out, truncated


def summarize(rows):
    units = [r["unit_budget"] for r in rows if r["comparable"]]
    return {
        "n_items": len(rows),
        "n_comparable": len(units),
        "n_lots": len(rows) - len(units),
        "total_qty": sum(r["quantity"] for r in rows if r["comparable"]),
        "min_unit": min(units) if units else None,
        "median_unit": statistics.median(units) if units else None,
        "mean_unit": statistics.fmean(units) if units else None,
        "max_unit": max(units) if units else None,
    }


@app.get("/api/items/pins")
def item_pins(q: str = Query(..., min_length=2, max_length=200), f: dict = Depends(filter_params)):
    """Locations that bought items matching q, with per-location price stats."""
    rows, truncated = fetch_rows(q, None, f)
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
    return {"type": "FeatureCollection", "features": features, "truncated": truncated}


@app.get("/api/items/compare")
def item_compare(q: str = Query(..., min_length=2, max_length=200), a: int = 0, b: int = 0,
                 f: dict = Depends(filter_params)):
    """Side-by-side price stats and item lines for two locations."""
    rows, truncated = fetch_rows(q, [a, b], f)
    result = {"truncated": truncated}
    for key, aid in (("a", a), ("b", b)):
        rs = sorted((r for r in rows if r["address_id"] == aid),
                    key=lambda r: (r["unit_budget"] is None, r["unit_budget"] or 0))
        result[key] = {
            "address_id": aid,
            "address": rs[0]["address"] if rs else None,
            "entities": sorted({r["entity"] for r in rs}),
            **summarize(rs),
            "lines": [{k: r[k] for k in ("bid_ref", "item", "quantity", "uom", "item_budget",
                                         "unit_budget", "comparable", "published", "status", "entity")}
                      for r in rs[:100]],
        }
    return result


@app.get("/api/items/suggest")
def item_suggest(q: str = Query(..., min_length=2, max_length=60)):
    """Search-box suggestions: synonym terms first, then real item names."""
    ql = norm_term(q)
    out = [t for t in sorted(synonyms()) if t.startswith(ql)]
    rows = query("""SELECT item_name, COUNT(*) AS n FROM items WHERE item_name LIKE %s
                    GROUP BY item_name ORDER BY n DESC LIMIT 10""", (like(q.strip()),))
    seen = {o.lower() for o in out}
    for r in rows:
        name = (r["item_name"] or "").strip()
        if name and name.lower() not in seen:
            out.append(name); seen.add(name.lower())
    return out[:10]


app.mount("/", StaticFiles(directory=os.path.join(HERE, "web"), html=True), name="web")
