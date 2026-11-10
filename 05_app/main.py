import os
import re
import statistics
import pymysql
from pymysql.cursors import DictCursor
from fastapi import FastAPI, HTTPException, Query
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


@app.get("/api/pins")
def pins(q: str | None = None, min_budget: float = 0,
         min_lon: float = -180, min_lat: float = -90,
         max_lon: float = 180, max_lat: float = 90):
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
def contracts(address_id: int, limit: int = Query(50, le=200), offset: int = 0):
    rows = query("""
      SELECT c.bid_ref, c.title, c.unit, COALESCE(c.abc, ib.total) AS abc,
             (c.abc IS NULL AND ib.total IS NOT NULL) AS derived,
             c.published, c.status, e.name
      FROM contracts c JOIN entities e ON e.id = c.entity_id
      LEFT JOIN (SELECT bid_ref, SUM(item_budget) AS total FROM items GROUP BY bid_ref) ib
             ON ib.bid_ref = c.bid_ref
      WHERE e.address_id = %s ORDER BY c.published DESC LIMIT %s OFFSET %s""",
      (address_id, limit, offset))
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


def search_clause(q):
    """'laptop, notebook computer' -> (laptop) OR (notebook AND computer)."""
    groups = [g for g in (x.strip() for x in q.split(",")) if g][:5]
    ors, args = [], []
    for g in groups:
        ands = []
        for t in [t for t in g.split() if t][:5]:
            like = "%" + re.sub(r"([\\%_])", r"\\\1", t[:50]) + "%"
            ands.append("(i.item_name LIKE %s OR i.item_desc LIKE %s OR c.title LIKE %s)")
            args += [like, like, like]
        if ands:
            ors.append("(" + " AND ".join(ands) + ")")
    if not ors:
        raise HTTPException(status_code=400, detail="Enter at least one search word")
    return "(" + " OR ".join(ors) + ")", args


def fetch_rows(q, address_ids=None):
    clause, args = search_clause(q)
    where = ["a.lat IS NOT NULL", clause]
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
def item_pins(q: str = Query(..., min_length=2, max_length=200)):
    """Locations that bought items matching q, with per-location price stats."""
    rows, truncated = fetch_rows(q)
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
def item_compare(q: str = Query(..., min_length=2, max_length=200), a: int = 0, b: int = 0):
    """Side-by-side price stats and item lines for two locations."""
    rows, truncated = fetch_rows(q, [a, b])
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


app.mount("/", StaticFiles(directory=os.path.join(HERE, "web"), html=True), name="web")
