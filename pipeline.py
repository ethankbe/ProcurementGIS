#!/usr/bin/env python3
"""
pipeline.py - run the whole data pipeline with one command.

    export DB_PASS='your-own-password'
    export ARCGIS_API_KEY='your-arcgis-key'     # free at developer.arcgis.com
    python3 pipeline.py --input path/to/philgeps_dump.csv

Stages (each one resumes where it left off, so it is safe to re-run):
  1. filter    raw dump -> 02_addresses/contracts.csv   (only with --input)
  2. prepare   contracts.csv -> targets.csv (one row per office)
  3. lookup    search PhilGEPS for award numbers the CSV lacks (scrape.py)
  4. addresses fetch agency addresses + awardees from award notice pages
  5. clean     convert + clean the scraped addresses
  6. geocode   Esri geocoder -> 03_geocode/geocoded_addresses.csv
  7. load      everything into MySQL (load.py)

Useful flags:
  --region NCR        keep only one region at the filter stage (default: all)
  --skip-scrape       skip stages 3-4 (use what was scraped before)
  --skip-geocode      skip stage 6 (e.g. you geocode in QGIS instead)
  --dry-run           stop after a load.py --dry-run coverage report
  --limit N           cap the scraping/geocoding work, for testing
"""
import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


def run(folder, script, *extra):
    print("\n=== %s/%s %s ===" % (folder, script, " ".join(extra)), flush=True)
    r = subprocess.run([sys.executable, script, *extra], cwd=os.path.join(ROOT, folder))
    if r.returncode != 0:
        sys.exit("FAILED: %s/%s (exit %d). Fix the issue and run pipeline.py again; "
                 "finished stages are skipped." % (folder, script, r.returncode))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", help="raw PhilGEPS dump CSV (runs the filter stage)")
    ap.add_argument("--region", help="keep only this region at the filter stage")
    ap.add_argument("--skip-scrape", action="store_true")
    ap.add_argument("--lookup-all", action="store_true",
                    help="search every bid, not just ones missing an award number "
                         "(also backfills awardees from search results)")
    ap.add_argument("--skip-geocode", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="end with load.py --dry-run")
    ap.add_argument("--limit", type=int, help="cap scraping/geocoding work (testing)")
    args = ap.parse_args()

    if args.input and not os.path.exists(args.input):
        sys.exit("ERROR: cannot find %s" % args.input)
    if not args.skip_geocode and not os.environ.get("ARCGIS_API_KEY"):
        sys.exit("ERROR: set ARCGIS_API_KEY first (free at developer.arcgis.com), "
                 "or pass --skip-geocode to geocode in QGIS instead.")
    if not args.dry_run and not os.environ.get("DB_PASS"):
        sys.exit("ERROR: set DB_PASS first:  export DB_PASS='your-own-password'")

    if args.input:
        extra = ["--region", args.region] if args.region else []
        run("01_prepare", "filter.py", os.path.abspath(args.input), *extra)

    run("02_addresses", "prepare.py")

    if not args.skip_scrape:
        limit = ["--limit", str(args.limit)] if args.limit else []
        run("02_addresses", "scrape.py", *(["--all"] if args.lookup_all else []), *limit)
        run("02_addresses", "addresses.py", *limit)

    run("02_addresses", "convert.py")
    run("02_addresses", "clean.py")

    if not args.skip_geocode:
        limit = ["--limit", str(args.limit)] if args.limit else []
        run("03_geocode", "geocode.py", *limit)

    run("04_database", "load.py", *(["--dry-run"] if args.dry_run else []))

    if args.dry_run:
        print("\nDry run finished. Re-run without --dry-run to load into MySQL.")
    else:
        print("\nAll done. Start the app with:\n"
              "  cd 05_app && python3 -m uvicorn main:app --reload")


if __name__ == "__main__":
    main()
