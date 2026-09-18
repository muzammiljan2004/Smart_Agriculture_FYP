"""Populate satellite_features for one farm from Sentinel-2.

    python -m scripts.fetch_satellite_data <farm_id>
    python -m scripts.fetch_satellite_data <farm_id> --start 2025-01-15 --end 2025-03-15

Run manually for now; scheduling is a later phase.
"""
import argparse
import sys

from app.db import db
from app.gee import SHEIKHUPURA_BBOX, fetch_indices


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("farm_id")
    ap.add_argument("--start", default="2025-01-15", help="rabi peak vegetative growth")
    ap.add_argument("--end", default="2025-03-15")
    args = ap.parse_args()

    # Confirm the farm exists first. A farm_id typo would otherwise fail on the
    # foreign key AFTER a slow GEE round trip -- fail on the cheap check.
    farm = db().table("farms").select("id, farmer_name, district").eq("id", args.farm_id).execute()
    if not farm.data:
        sys.exit(f"no farm {args.farm_id} (service_role sees all farms, so this is a real miss)")
    print(f"farm: {farm.data[0]['farmer_name']} / {farm.data[0]['district']}")

    print(f"querying GEE {args.start}..{args.end} over {SHEIKHUPURA_BBOX} ...")
    # ponytail: district-wide mean, so every Sheikhupura farm gets identical
    # indices. Correct for a checkpoint demo, wrong for real per-farm yield.
    # Upgrade: ee.Geometry.Point(lng, lat).buffer(500).bounds() from farms.gps_*.
    idx = fetch_indices(bbox=SHEIKHUPURA_BBOX, start=args.start, end=args.end)
    print(f"indices: {idx}")

    row = {"farm_id": args.farm_id, **idx}
    # Upsert on (farm_id, date) -- the unique constraint in the migration. Makes
    # re-running the script idempotent instead of piling up duplicate rows.
    res = db().table("satellite_features").upsert(row, on_conflict="farm_id,date").execute()
    print(f"wrote satellite_features id={res.data[0]['id']} date={idx['date']}")


if __name__ == "__main__":
    main()
