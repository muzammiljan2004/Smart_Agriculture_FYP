"""Seed PLACEHOLDER district yields so the comparison/trend UI has something to show.

    python -m scripts.seed_district_yields          # insert
    python -m scripts.seed_district_yields --clear  # remove them again

Every row is written with source='synthetic'. That is load-bearing, not
cosmetic: assess() in app/main.py counts only source='PBS' rows as validated,
so these rows drive the district-average and trend widgets while the UI keeps
saying "preliminary". Replacing them with real PBS figures is what flips the
status -- no code change.

Numbers are rough Punjab district wheat averages with year-to-year variation.
They are NOT survey data and must not end up in a report.
"""
import argparse

from app.db import db
from app.districts import DISTRICTS

SEASONS = ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"]

# Rough district baselines (t/ha), then per-season variation applied below.
BASELINE = {"Sheikhupura": 3.20, "Okara": 3.55, "Sahiwal": 3.40}
YEAR_FACTOR = [0.93, 1.02, 0.97, 1.06, 1.00]   # weather-ish wobble


def rows():
    for district in DISTRICTS:
        for season, factor in zip(SEASONS, YEAR_FACTOR):
            yield {
                "district": district,
                "season": season,
                "crop_type": "wheat",
                "yield_t_ha": round(BASELINE[district] * factor, 2),
                "source": "synthetic",
            }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--clear", action="store_true", help="delete the synthetic rows")
    args = ap.parse_args()

    if args.clear:
        # Only ever deletes source='synthetic'. Real PBS rows are never touched
        # by this script, so it stays safe to run after real data lands.
        res = db().table("district_yields").delete().eq("source", "synthetic").execute()
        print(f"deleted {len(res.data or [])} synthetic row(s)")
        return

    payload = list(rows())
    res = (
        db().table("district_yields")
        .upsert(payload, on_conflict="district,season,crop_type")
        .execute()
    )
    print(f"upserted {len(res.data or [])} placeholder row(s) (source='synthetic')")
    for r in (res.data or [])[:3]:
        print(f"  {r['district']:12s} {r['season']}  {r['yield_t_ha']} t/ha")
    print("  ...")
    print("Replace with PBS figures (source='PBS') to flip the UI to 'validated'.")


if __name__ == "__main__":
    main()
