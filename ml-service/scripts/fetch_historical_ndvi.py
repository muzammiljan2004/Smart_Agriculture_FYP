"""Build the model's training CSV: district x season vegetation indices.

    python -m scripts.fetch_historical_ndvi                      # wheat, 5 rabi seasons, 3 districts
    python -m scripts.fetch_historical_ndvi --crop rice          # kharif equivalent
    python -m scripts.fetch_historical_ndvi --seasons 2023-24 2024-25

Writes data/training.csv with one row per (district, season, crop_type).
The yield_t_ha column is left EMPTY for you to fill from PBS district yield
tables -- that is the join key between this satellite data and ground truth,
and it is the one number that cannot be fabricated.

Re-running MERGES: rows you have already filled keep their yield, indices are
refreshed. That matters because the whole point of this file is the yield
column you type in by hand; a plain overwrite would delete an afternoon of work.
"""
import argparse
import csv
from pathlib import Path

from app.districts import CROPS, CROP_SEASON, DISTRICTS, INDEX_FEATURES, season_window
from app.gee import fetch_indices

CSV_PATH = Path(__file__).resolve().parents[1] / "data" / "training.csv"

# Five most recent complete seasons at time of writing. Rabi spans two years
# ("2020-21"), kharif is a single year ("2020").
DEFAULT_SEASONS = {
    "wheat": ["2020-21", "2021-22", "2022-23", "2023-24", "2024-25"],
    "rice": ["2020", "2021", "2022", "2023", "2024"],
}

FIELDNAMES = [
    "district", "season", "crop_type", "start", "end",
    *INDEX_FEATURES, "image_date", "yield_t_ha",
]

KEY = ("district", "season", "crop_type")


def load_existing(path):
    """Existing rows keyed by (district, season, crop) so we can merge."""
    if not path.exists():
        return {}
    with path.open(newline="", encoding="utf-8-sig") as fh:
        return {tuple(r[k] for k in KEY): r for r in csv.DictReader(fh)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--crop", choices=CROPS, default="wheat")
    ap.add_argument("--seasons", nargs="+", help="override the default 5 seasons")
    ap.add_argument("--districts", nargs="+", choices=list(DISTRICTS), default=list(DISTRICTS))
    args = ap.parse_args()

    seasons = args.seasons or DEFAULT_SEASONS[args.crop]
    rows = load_existing(CSV_PATH)
    print(f"{args.crop} ({CROP_SEASON[args.crop]}) · {len(args.districts)} districts "
          f"x {len(seasons)} seasons = {len(args.districts) * len(seasons)} rows")

    ok = failed = 0
    for district in args.districts:
        for season in seasons:
            key = (district, season, args.crop)
            start, end = season_window(args.crop, season)
            try:
                idx = fetch_indices(bbox=DISTRICTS[district], start=start, end=end)
            except Exception as e:
                # One bad season (heavy cloud, pre-launch dates) must not throw
                # away the rows already fetched -- keep going, report at the end.
                print(f"  {district:12s} {season:8s} FAILED: {e}")
                failed += 1
                continue

            prev = rows.get(key, {})
            rows[key] = {
                "district": district,
                "season": season,
                "crop_type": args.crop,
                "start": start,
                "end": end,
                **{k: idx[k] for k in INDEX_FEATURES},
                "image_date": idx["date"],
                # Preserve a yield already typed in by hand.
                "yield_t_ha": prev.get("yield_t_ha", ""),
            }
            print(f"  {district:12s} {season:8s} ndvi={idx['ndvi']}")
            ok += 1

    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CSV_PATH.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDNAMES)
        w.writeheader()
        for key in sorted(rows):
            w.writerow(rows[key])

    filled = sum(1 for r in rows.values() if (r.get("yield_t_ha") or "").strip())
    print(f"\nwrote {CSV_PATH}  ({ok} fetched, {failed} failed, {len(rows)} rows total)")
    print(f"{filled}/{len(rows)} rows have a yield. Fill yield_t_ha from PBS district "
          f"tables, then: python -m app.train")


if __name__ == "__main__":
    main()
