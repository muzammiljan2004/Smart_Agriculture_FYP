"""Score the harvest detector against real harvest dates.

    python -m scripts.validate_harvest data/harvest_truth.csv
    python -m scripts.validate_harvest data/harvest_truth.csv --refresh

Input CSV, one row per field:

    field_id,actual_harvest_date
    9f2c...,2025-04-18

`field_id` is a farms.id, and a unique PREFIX is accepted -- UUIDs get
truncated in logs and notebooks constantly, and matching the prefix here is
cheaper than asking anyone to paste 36 characters correctly.

NOTHING IS FABRICATED. With no truth file the script prints what it needs and
exits non-zero. There is no sample data, no synthetic mode and no default
path, because a validation script that can produce a number without real
inputs is worse than no validation script -- somebody eventually quotes it.

Run --refresh once per field to pull the imagery, then re-run without it as
often as you like while tuning thresholds; the series is cached in
satellite_features and the GEE round trip is the slow part.
"""
import argparse
import csv
import statistics
import sys
from datetime import date
from pathlib import Path

from app.db import db
from app.growth import default_sowing_date
from app.harvest import detect

# Dates we report against. ±3 days is the tolerance the collection effort
# targets, so it is the headline; ±7 is one Sentinel-2 revisit gap, which is
# roughly the best any optical detector can do on a single field.
TOLERANCES = (3, 7, 14)


def load_truth(path: Path):
    if not path.exists():
        sys.exit(
            f"no truth file at {path}.\n\n"
            "Create it with one row per field that has a REAL, farmer-reported\n"
            "harvest date:\n\n"
            "    field_id,actual_harvest_date\n"
            "    9f2c1a4e-...,2025-04-18\n\n"
            "Do not populate it with estimates, calendar dates, or the\n"
            "detector's own output -- scoring a detector against itself\n"
            "returns a perfect result that means nothing."
        )
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for i, r in enumerate(csv.DictReader(fh), start=2):
            fid = (r.get("field_id") or r.get("farm_id") or "").strip()
            raw = (r.get("actual_harvest_date") or r.get("harvest_date") or "").strip()
            if not fid or not raw:
                sys.exit(f"{path}:{i}: needs both field_id and actual_harvest_date")
            try:
                rows.append((fid, date.fromisoformat(raw)))
            except ValueError:
                sys.exit(f"{path}:{i}: {raw!r} is not an ISO date (YYYY-MM-DD)")
    if not rows:
        sys.exit(f"{path} has a header but no rows")
    return rows


def resolve(fid, farms):
    exact = [f for f in farms if f["id"] == fid]
    if exact:
        return exact[0]
    pre = [f for f in farms if f["id"].startswith(fid)]
    if len(pre) == 1:
        return pre[0]
    if len(pre) > 1:
        sys.exit(f"{fid!r} matches {len(pre)} farms; use more characters")
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("truth_csv", type=Path)
    ap.add_argument("--refresh", action="store_true",
                    help="re-fetch each field's imagery from GEE first (slow)")
    args = ap.parse_args()

    truth = load_truth(args.truth_csv)
    farms = (db().table("farms").select(
        "id, farmer_name, crop_type, gps_lat, gps_lng, area_hectares, planting_date"
    ).execute()).data or []

    detected, missed, errors = [], [], []

    for fid, actual in truth:
        farm = resolve(fid, farms)
        if farm is None:
            errors.append((fid, "no such farm"))
            continue

        if args.refresh:
            from app.field import field_series, season_bounds
            sown = (date.fromisoformat(farm["planting_date"]) if farm["planting_date"]
                    else default_sowing_date(farm["crop_type"], date.today()))
            a, b = season_bounds(farm["crop_type"], sown)
            try:
                rows = field_series(farm["gps_lat"], farm["gps_lng"],
                                    farm.get("area_hectares"), a, b)
            except Exception as e:                   # noqa: BLE001
                errors.append((fid, f"fetch failed: {e}"))
                continue
            from app.main import _store_series
            _store_series(farm["id"], rows)
            print(f"  fetched {len(rows)} observations for {farm['id'][:8]}")

        series = (db().table("satellite_features").select(
            "date, ndvi, evi, ndwi, savi, nbr, vv, vh, cloud_pct, valid_px"
        ).eq("farm_id", farm["id"]).order("date").execute()).data or []

        sown = (date.fromisoformat(farm["planting_date"]) if farm["planting_date"]
                else default_sowing_date(farm["crop_type"], date.today()))

        # confirmed_date is deliberately NOT passed. Most of these fields will
        # have their confirmation stored, and handing the detector the answer
        # it is being scored on would return a flawless result every time.
        r = detect(series, farm["crop_type"], sown, today=max(actual, date.today()))

        est = r["estimated_harvest_date"]
        if est is None:
            missed.append((farm, actual, r))
        else:
            detected.append((farm, actual, date.fromisoformat(est), r))

    # ------------------------------------------------------------- report
    n = len(truth)
    print()
    print("=" * 66)
    print("HARVEST DETECTOR VALIDATION")
    print("=" * 66)
    print(f"  fields with ground truth   {n}")
    print(f"  detected                   {len(detected)}")
    print(f"  missed (no date returned)  {len(missed)}")
    print(f"  errors                     {len(errors)}")

    for fid, why in errors:
        print(f"      ! {fid[:12]}  {why}")

    if not detected:
        print()
        print("  Nothing detected, so no error statistics. Every miss is listed")
        print("  below -- check that each field has imagery stored (--refresh).")
        for farm, actual, r in missed:
            print(f"      - {farm['id'][:8]} {farm['crop_type']:9s} "
                  f"actual {actual}  status={r['status']} "
                  f"obs={r['observations']}")
        return 1

    errs = [abs((est - actual).days) for _, actual, est, _ in detected]
    signed = [(est - actual).days for _, actual, est, _ in detected]

    print()
    print(f"  mean absolute error        {statistics.mean(errs):.1f} days")
    print(f"  median absolute error      {statistics.median(errs):.1f} days")
    # Sign matters: a detector consistently late is biased and fixable by
    # shifting the estimator, while one scattered both ways is just noisy.
    print(f"  mean signed error          {statistics.mean(signed):+.1f} days "
          f"({'late' if statistics.mean(signed) > 0 else 'early'})")
    print(f"  worst                      {max(errs)} days")
    print()
    for t in TOLERANCES:
        hit = sum(e <= t for e in errs)
        print(f"  within +/-{t:<2d} days           {hit}/{len(detected)}  "
              f"{hit / len(detected):.0%}  (of all truth: {hit / n:.0%})")

    print()
    print("  per field")
    print(f"    {'farm':10s} {'crop':10s} {'actual':12s} {'detected':12s} "
          f"{'err':>5s} {'conf':>5s}  status")
    for farm, actual, est, r in sorted(detected, key=lambda x: abs((x[2] - x[1]).days)):
        print(f"    {farm['id'][:8]:10s} {farm['crop_type']:10s} {actual!s:12s} "
              f"{est!s:12s} {(est - actual).days:>+5d} {r['confidence']:>5.2f}  "
              f"{r['status']}")
    for farm, actual, r in missed:
        print(f"    {farm['id'][:8]:10s} {farm['crop_type']:10s} {actual!s:12s} "
              f"{'-- none --':12s} {'':>5s} {'':>5s}  {r['status']}")

    print()
    print("  These are DETECTION-date errors against farmer-reported dates.")
    print("  A farmer recalling a date months later is itself imprecise, so")
    print("  treat the floor of this measurement as a few days, not zero.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
