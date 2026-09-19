"""Populate satellite_features for one farm from Sentinel-2.

    python -m scripts.fetch_satellite_data <farm_id>
    python -m scripts.fetch_satellite_data <farm_id> --start 2025-01-15 --end 2025-03-15

The bounding box and date window are derived from the farm's own district and
crop, so the same command works for any of the three districts. Run manually
for now; scheduling is a later phase.
"""
import argparse
import sys

from app.db import db
from app.districts import DISTRICTS, INDEX_FEATURES, season_window
from app.gee import fetch_indices


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("farm_id")
    ap.add_argument("--season", help="rabi '2024-25' or kharif '2024'; default: latest")
    ap.add_argument("--start", help="override the season window")
    ap.add_argument("--end", help="override the season window")
    args = ap.parse_args()

    # Confirm the farm exists first. A farm_id typo would otherwise fail on the
    # foreign key AFTER a slow GEE round trip -- fail on the cheap check.
    #
    # Accepts a short id PREFIX as well as a full UUID. Postgres rejects a
    # partial UUID with a raw "invalid input syntax for type uuid" that says
    # nothing about what to do, and UUIDs are routinely quoted in truncated
    # form (logs, dashboards, chat), so matching on a prefix client-side is
    # worth the handful of lines.
    all_farms = (
        db().table("farms")
        .select("id, farmer_name, district, crop_type, season")
        .execute()
    ).data or []

    matches = [f for f in all_farms if f["id"] == args.farm_id]
    if not matches:
        matches = [f for f in all_farms if f["id"].startswith(args.farm_id.rstrip(".-"))]

    if not matches:
        sys.exit(f"no farm matching {args.farm_id!r} "
                 f"(service_role sees all {len(all_farms)} farms, so this is a real miss)")
    if len(matches) > 1:
        print(f"{args.farm_id!r} matches {len(matches)} farms:", file=sys.stderr)
        for m in matches:
            print(f"  {m['id']}  {m['farmer_name']} / {m['district']}", file=sys.stderr)
        sys.exit("be more specific")

    f = matches[0]
    args.farm_id = f["id"]      # everything below writes the full UUID
    district, crop = f["district"], f["crop_type"]

    # The district CHECK constraint and this dict have to agree. If they ever
    # drift, fail loudly here rather than silently sampling the wrong district.
    if district not in DISTRICTS:
        sys.exit(f"farm district {district!r} has no bbox in app/districts.py (have: {list(DISTRICTS)})")

    bbox = DISTRICTS[district]

    if args.start and args.end:
        start, end = args.start, args.end
    else:
        season = args.season or ("2024-25" if crop == "wheat" else "2024")
        start, end = season_window(crop, season)

    print(f"farm: {f['farmer_name']} / {district} / {crop}")
    print(f"querying GEE {start}..{end} over {bbox} ...")
    # ponytail: district-wide mean, so every farm in a district gets identical
    # indices. Correct for a checkpoint demo, wrong for real per-farm yield.
    # Upgrade: ee.Geometry.Point(lng, lat).buffer(500).bounds() from farms.gps_*.
    idx = fetch_indices(bbox=bbox, start=start, end=end)
    print(f"indices: {idx}")

    # Name the columns instead of spreading idx: fetch_indices also returns
    # metadata (n_images) that satellite_features has no column for, and a
    # blind spread turns any future addition there into a PGRST204 here.
    row = {
        "farm_id": args.farm_id,
        "date": idx["date"],
        **{k: idx[k] for k in INDEX_FEATURES},
    }
    # Upsert on (farm_id, date) -- the unique constraint in the migration. Makes
    # re-running the script idempotent instead of piling up duplicate rows.
    res = db().table("satellite_features").upsert(row, on_conflict="farm_id,date").execute()
    print(f"wrote satellite_features id={res.data[0]['id']} date={idx['date']}")


if __name__ == "__main__":
    main()
