#!/usr/bin/env python3
"""
filter.py - script version of scraper.ipynb.

Filters a raw PhilGEPS dump down to awarded IT-related contracts and writes
02_addresses/contracts.csv, ready for prepare.py.

    python3 filter.py path/to/philgeps_dump.csv              # all regions
    python3 filter.py path/to/philgeps_dump.csv --region NCR # one region

Options: --region (default: all), --out (output path), --status (default: Awarded).
"""
import argparse
import os
import re
import sys

import pandas as pd


def normalize_region(val):
    """'REGION VI' -> 'Region VI', 'CARAGA' -> 'Caraga', etc."""
    if pd.isna(val):
        return val
    v = re.sub(r"\s+", " ", str(val)).strip()
    u = v.upper()
    if u in ("NCR", "CAR"):
        return u
    if u in ("CARAGA",):
        return "Caraga"
    if u in ("NIR", "NEGROS ISLAND REGION"):
        return "Negros Island Region"
    m = re.fullmatch(r"REGION\s+([IVX]+(?:-[AB])?)", u)
    if m:
        return "Region " + m.group(1)
    return v


def normalize_province(val):
    """'METRO MANILA' -> 'Metro Manila', 'Davao Del Sur' -> 'Davao del Sur'.
    Also merges renamed provinces: Compostela Valley -> Davao de Oro (2019)."""
    if pd.isna(val):
        return val
    v = re.sub(r"\s+", " ", str(val)).strip()
    RENAMED = {"COMPOSTELA VALLEY": "Davao de Oro"}
    if v.upper() in RENAMED:
        return RENAMED[v.upper()]
    words = v.title().split(" ")
    return " ".join(w.lower() if i > 0 and w in ("Del", "De", "Las", "Los", "Y") else w
                    for i, w in enumerate(words))

IT_CATS = [
    "Computer Equipment and Accessories",
    "Computer services",
    "Software",
    "Information Technology Service Delivery",
    "Information services",
    "Electronic reference material",
    "Data Voice or Multimedia Network Equipment or Platforms and Accessories",
    "Components for information technology or broadcasting or telecommunications",
    "Communications Devices and Accessories",
    "Telecommunications media services",
    "Electronic hardware and component parts and accessories",
    "Printed circuits and integrated circuits and microassemblies",
    "Office machines and their supplies and accessories",
    "Audio and visual presentation and composing equipment",
    "Photographic or filming or video equipment",
    "Photographic and recording media",
    "Consumer electronics",
    "Security surveillance and detection",
    "Automation control devices and components and accessories",
    "Electrical wire and cable and harness",
    "Electrical wire management devices and accessories and supplies",
    "Batteries and generators and kinetic power transmission",
    "Printing and publishing equipment",
]

COLS = [
    "Procuring Entity (PE)", "Region", "Province", "City/Municipality",
    "Bid Reference No.", "Notice Title", "Classification", "Procurement Category",
    "Approved Budget for the Contract (ABC)", "Published Date", "Closing Date",
    "Item/Lot Name", "Item/Lot Description", "Quantity", "Unit of Measure",
    "Item Budget", "Bid Notice Status", "Award Reference No.",
    "Awardee Organization Name",
]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="raw PhilGEPS dump CSV")
    ap.add_argument("--region", help="keep only this region (e.g. NCR); default: all")
    ap.add_argument("--status", default="Awarded", help="Bid Notice Status to keep")
    ap.add_argument("--out", default=os.path.join(here, "..", "02_addresses", "contracts.csv"))
    args = ap.parse_args()

    try:
        df = pd.read_csv(args.input, encoding="utf-8-sig", low_memory=False)
    except UnicodeDecodeError:
        df = pd.read_csv(args.input, encoding="latin-1", low_memory=False)
    df.columns = df.columns.str.strip()
    print("raw dump: %d rows" % len(df))

    keep = [c for c in COLS if c in df.columns]
    missing = [c for c in COLS if c not in df.columns]
    if missing:
        print("NOTE: dump has no columns %s (continuing without them)" % missing)
    df = df[keep].copy()

    # one spelling per region/province, so the app's filters don't split them
    if "Region" in df.columns:
        df["Region"] = df["Region"].map(normalize_region)
    if "Province" in df.columns:
        df["Province"] = df["Province"].map(normalize_province)

    if args.region:
        df = df[df["Region"].fillna("").str.upper().str.strip() == args.region.upper()]
    df = df[df["Procurement Category"].isin(IT_CATS) &
            (df["Bid Notice Status"].fillna("").str.lower().str.strip() == args.status.lower())]

    for c in ("Approved Budget for the Contract (ABC)", "Item Budget"):
        if c in df.columns:
            df[c] = pd.to_numeric(df[c].astype(str).str.replace(r"[^\d.\-]", "", regex=True),
                                  errors="coerce")
    if "Published Date" in df.columns:
        df["Published Date"] = pd.to_datetime(df["Published Date"], errors="coerce",
                                              format="mixed").dt.strftime("%Y-%m-%d")
    # remove the ".0" spreadsheet artifact from reference numbers
    for c in ("Bid Reference No.", "Award Reference No."):
        if c in df.columns:
            df[c] = (df[c].astype(str).str.replace(r"\.0$", "", regex=True)
                     .str.strip().replace({"nan": "", "None": ""}))

    out = os.path.abspath(args.out)
    df.to_csv(out, index=False, encoding="utf-8-sig")
    print("kept %d rows (%s, %s) -> %s" % (
        len(df), args.region or "all regions", args.status, out))
    print("regions: %s" % df["Region"].value_counts().to_dict())
    print("unique procuring entities: %d" % df["Procuring Entity (PE)"].nunique())
    if "Award Reference No." in df.columns:
        n_aw = df["Award Reference No."].fillna("").str.strip().ne("").sum()
        print("rows with an award reference: %d of %d (the rest can be found by scrape.py)"
              % (n_aw, len(df)))


if __name__ == "__main__":
    main()
