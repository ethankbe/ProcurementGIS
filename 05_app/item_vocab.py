#!/usr/bin/env python3
"""
item_vocab.py - see what vocabulary your data uses, to build search synonyms.

Run it from the 05_app folder:

    python3 item_vocab.py

It reads ../02_addresses/contracts.csv (change with --input) and writes four
files into a vocab/ subfolder (change with --outdir):

  item_names.csv        every distinct item name (lowercased) with how many
                        item lines, bids and agencies use it, its most common
                        categories, and its most common original spelling
  item_words.csv        every word, with how often it appears in item names
                        and in item descriptions
  alias_candidates.csv  names written as "A (B)" or "A / B": the two parts are
                        often synonyms, for example "notebook (laptop)"
  spelling_variants.csv rare words that look like typos of a common word

How to use them: open item_names.csv and item_words.csv in a spreadsheet, find
different words for the same thing, and add a line for each group to
synonyms.txt, for example:  laptop = notebook, note book
"""
import argparse
import collections
import difflib
import os
import re
import sys

import pandas as pd

NAME, DESC = "Item/Lot Name", "Item/Lot Description"
CAT, BID, PE = "Procurement Category", "Bid Reference No.", "Procuring Entity (PE)"

STOP = {"the", "and", "for", "with", "of", "to", "in", "on", "an", "or", "per",
        "as", "from", "its", "all", "not", "are", "pcs", "pc", "etc", "incl"}


def norm(s):
    s = re.sub(r"\s+", " ", str(s).lower()).strip()
    return s.strip(" .,;:-\"'")


def words(s):
    return [w for w in re.findall(r"[a-z][a-z0-9\-]{2,}", str(s).lower()) if w not in STOP]


UNITS = {"pcs", "pc", "set", "sets", "unit", "units", "pack", "box", "gb", "tb", "mb",
         "mm", "cm", "inch", "inches", "pair", "pairs", "roll", "rolls"}


def has_real_word(s):
    """True if the text has a word of 3+ letters that is not just a unit or size."""
    return any(t not in UNITS for t in re.findall(r"[a-z]{3,}", s))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", "-i", default="../02_addresses/contracts.csv")
    ap.add_argument("--top", type=int, default=20, help="rows to print on screen")
    ap.add_argument("--outdir", default="vocab", help="folder for the output CSV files")
    args = ap.parse_args()

    try:
        df = pd.read_csv(args.input, dtype=str, encoding="utf-8-sig")
    except FileNotFoundError:
        sys.exit("ERROR: cannot find %s (use --input to point at contracts.csv)" % args.input)
    if NAME not in df.columns:
        sys.exit("ERROR: no '%s' column. Found: %s" % (NAME, list(df.columns)))
    for c in (DESC, CAT, BID, PE):
        if c not in df.columns:
            df[c] = ""
        df[c] = df[c].fillna("")

    df["name_raw"] = df[NAME].fillna("").str.strip()
    df = df[df["name_raw"] != ""].copy()
    df["name_norm"] = df["name_raw"].map(norm)
    os.makedirs(args.outdir, exist_ok=True)
    out = lambda f: os.path.join(args.outdir, f)
    print("%d item lines, %d distinct names" % (len(df), df["name_norm"].nunique()))

    # ---- 1. distinct names --------------------------------------------------
    names = (df.groupby("name_norm")
             .agg(n_lines=("name_norm", "size"), n_bids=(BID, "nunique"),
                  n_agencies=(PE, "nunique"),
                  categories=(CAT, lambda s: "; ".join(s[s != ""].value_counts().head(3).index)),
                  most_common_spelling=("name_raw", lambda s: s.value_counts().index[0]))
             .reset_index()
             .sort_values(["n_lines", "name_norm"], ascending=[False, True]))
    names.to_csv(out("item_names.csv"), index=False)

    # ---- 2. word counts -----------------------------------------------------
    in_names, in_desc = collections.Counter(), collections.Counter()
    for n, d in zip(df["name_raw"], df[DESC]):
        in_names.update(set(words(n)))
        in_desc.update(set(words(d)))
    vocab = sorted(set(in_names) | set(in_desc))
    wt = pd.DataFrame({"word": vocab,
                       "in_names": [in_names[w] for w in vocab],
                       "in_descriptions": [in_desc[w] for w in vocab]})
    wt = wt.sort_values(["in_names", "in_descriptions"], ascending=False)
    wt.to_csv(out("item_words.csv"), index=False)

    # ---- 3. alias candidates: "A (B)" and "A / B" ---------------------------
    pairs = collections.Counter()
    for raw in df["name_raw"]:
        low = raw.lower()
        m = re.match(r"^(.*?)\(([^)]{3,60})\)", low)
        if m and has_real_word(m.group(1)) and has_real_word(m.group(2)):
            pairs[(norm(m.group(1)), norm(m.group(2)))] += 1
        parts = [norm(p) for p in re.split(r"\s*/\s*", low) if p.strip()]
        if len(parts) == 2 and all(has_real_word(p) for p in parts):
            pairs[(parts[0], parts[1])] += 1
    al = pd.DataFrame([(a, b, n) for (a, b), n in pairs.most_common()],
                      columns=["term_a", "term_b", "times_seen"])
    al.to_csv(out("alias_candidates.csv"), index=False)

    # ---- 4. spelling variants: rare words close to a common word -------------
    total = {w: in_names[w] + in_desc[w] for w in vocab}
    common = [w for w in vocab if total[w] >= 5 and len(w) >= 4]
    buckets = collections.defaultdict(list)
    for w in common:
        buckets[w[0]].append(w)
    variants = []
    for w in vocab:
        if total[w] <= 2 and len(w) >= 5:
            near = [c for c in buckets.get(w[0], []) if abs(len(c) - len(w)) <= 2 and c != w]
            hit = difflib.get_close_matches(w, near, n=1, cutoff=0.88)
            if hit:
                variants.append((w, hit[0], total[w], total[hit[0]]))
    sv = pd.DataFrame(variants, columns=["rare_word", "likely_word", "rare_count", "likely_count"])
    sv = sv.sort_values("likely_count", ascending=False)
    sv.to_csv(out("spelling_variants.csv"), index=False)

    # ---- summary -------------------------------------------------------------
    print("\nMost common item names:")
    print(names[["name_norm", "n_lines", "n_agencies"]].head(args.top).to_string(index=False))
    print("\nMost common words in item names:")
    print(wt[["word", "in_names", "in_descriptions"]].head(args.top).to_string(index=False))
    print("\nWrote to %s/: item_names.csv (%d), item_words.csv (%d), alias_candidates.csv (%d), "
          "spelling_variants.csv (%d)" % (args.outdir, len(names), len(wt), len(al), len(sv)))
    print("Next: open them in a spreadsheet and add groups to synonyms.txt")


if __name__ == "__main__":
    main()
