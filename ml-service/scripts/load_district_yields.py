"""Load real PBS district yields into the district_yields table.

    python -m scripts.load_district_yields --dry-run
    python -m scripts.load_district_yields

The table existed but held 15 SYNTHETIC wheat rows across 3 districts, so
every "vs district average" figure the dashboard showed was computed from
invented numbers -- which the UI admitted in a caveat that could not be
cleared, because the real figures had nowhere to go.

SOURCE is PBS_all_crops.csv, the same file the training set draws yields
from, standardised the same way (name map + SPLIT_PARENTS) so a farm's
district resolves to the same key in both.

MERGES ARE AREA-WEIGHTED. Where two districts fold into one GAUL-2015
polygon -- Chiniot into Jhang, Nankana Sahib into Sheikhupura -- the combined
yield is total production / total area, never the mean of two yields. A 50 ha
district would otherwise count as heavily as a 50,000 ha one.

ZERO YIELDS ARE DROPPED. A zero is an absence of production, not a
measurement of it, and averaging it in drags the district figure toward
nothing.
"""
import argparse
import csv
import sys
from collections import defaultdict
from pathlib import Path

from app.db import db
from scripts.build_training_dataset import (CROP_FILES, load_name_map,
                                            SEASONS_WITH_IMAGERY_FROM, SPLIT_PARENTS)

DATA = Path(__file__).resolve().parents[1] / "data"
SRC = DATA / "PBS_all_crops.csv"
CHUNK = 500


def norm(s):
    return "".join(c for c in str(s).lower() if c.isalnum())


def build():
    if not SRC.exists():
        sys.exit(f"missing {SRC}. Run: python -m scripts.pbs_all_crops_to_csv")
    nm = load_name_map()
    acc = defaultdict(lambda: [0.0, 0.0])
    with SRC.open(newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            if r["Crop"] not in CROP_FILES:
                continue
            if int(r["Season"].split("-")[0]) < SEASONS_WITH_IMAGERY_FROM:
                continue
            std = nm.get(norm(r["District"]))
            if not std:
                continue
            k = (SPLIT_PARENTS.get(std, std), r["Season"], r["Crop"])
            acc[k][0] += float(r["Production (tonnes)"])
            acc[k][1] += float(r["Area (ha)"])

    rows = [{"district": d, "season": s, "crop_type": c,
             "yield_t_ha": round(p / a, 4), "source": "PBS"}
            for (d, s, c), (p, a) in sorted(acc.items()) if a > 0 and p > 0]
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    rows = build()
    print(f"{len(rows)} rows  "
          f"districts {len({r['district'] for r in rows})}  "
          f"crops {len({r['crop_type'] for r in rows})}  "
          f"seasons {len({r['season'] for r in rows})}")
    print(f"yield range {min(r['yield_t_ha'] for r in rows):.2f} .. "
          f"{max(r['yield_t_ha'] for r in rows):.2f} t/ha")
    if a.dry_run:
        for r in rows[:3]:
            print("  e.g.", r)
        print("\n--dry-run: nothing written")
        return

    # Upsert on the table's own unique key, so re-running is safe and updates
    # rather than duplicating.
    for i in range(0, len(rows), CHUNK):
        batch = rows[i:i + CHUNK]
        db().table("district_yields").upsert(
            batch, on_conflict="district,season,crop_type").execute()
        print(f"  upserted {i + len(batch)}/{len(rows)}")
    print("done.")


if __name__ == "__main__":
    main()
