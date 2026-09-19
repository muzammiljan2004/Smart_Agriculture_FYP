"""Step 1 gate: does every standardized district name resolve against GAUL?

    python -m scripts.check_district_names

Run this BEFORE build_training_dataset.py. A name that fails here would
otherwise cost ~11 wasted GEE round trips (one per season) before anyone
noticed, and an unresolved name is a District_Name_Map bug, not a data gap.
"""
import csv
import sys
from pathlib import Path

from app.gee import DistrictNotFound, gaul_district_names, get_district_geometry
from scripts.build_training_dataset import SPLIT_PARENTS

NAME_MAP_CSV = Path(__file__).resolve().parents[1] / "data" / "District_Name_Map.csv"


def main():
    if not NAME_MAP_CSV.exists():
        sys.exit(f"missing {NAME_MAP_CSV}")

    with NAME_MAP_CSV.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        cols = reader.fieldnames or []
        std_col = next((c for c in cols if "standard" in c.lower()), cols[-1])
        names = sorted({(r.get(std_col) or "").strip() for r in reader if (r.get(std_col) or "").strip()})

    print(f"{len(names)} standardized name(s) from {std_col!r}\n")

    gaul = gaul_district_names()
    print(f"GAUL has {len(gaul)} ADM2 names for Pakistan\n")

    # Validate what the batch join will ACTUALLY request: post-2015 districts
    # are harmonised onto their GAUL-era parent before any geometry lookup, so
    # checking the raw names would report failures that never occur in practice.
    requested = sorted({SPLIT_PARENTS.get(n, n) for n in names})
    redirected = {n: SPLIT_PARENTS[n] for n in names if n in SPLIT_PARENTS}
    if redirected:
        print(f"{len(redirected)} post-GAUL district(s) harmonised to a parent:")
        for child, parent in sorted(redirected.items()):
            print(f"  {child:16s} -> {parent}")
        print(f"\nresolving {len(requested)} GAUL-era district(s):\n")

    ok, bad = [], []
    for n in requested:
        try:
            get_district_geometry(n)
            ok.append(n)
            print(f"  [ OK ] {n}")
        except DistrictNotFound as e:
            bad.append((n, str(e)))
            print(f"  [FAIL] {n}")
    names = requested

    print(f"\nresolved {len(ok)}/{len(names)}")
    if bad:
        print("\nUNRESOLVED -- fix District_Name_Map before running the batch join:")
        for n, msg in bad:
            print(f"\n  {n}\n    {msg}")
        sys.exit(1)
    print("all names resolve; safe to run scripts.build_training_dataset")


if __name__ == "__main__":
    main()
