"""Join the PBS/MNFSR wheat yield table to Sentinel-2 rabi indices.

    python -m scripts.build_training_dataset
    python -m scripts.build_training_dataset --dry-run     # plan only, no GEE calls
    python -m scripts.build_training_dataset --limit 20    # smoke test

Inputs  (place both in ml-service/data/):
    Wheat_Yield_Data.csv    District, Season, Wheat Area (ha), Wheat Production (tonnes),
                            Wheat Yield (kg/ha), Source, Source URL, Verification Status
    District_Name_Map.csv   source-printed name -> standardized name

Output  data/training_data_real.csv
    district, season, ndvi, evi, ndwi, savi, nbr, actual_yield, yield_confidence

RESUMABLE: rows already present in the output are never re-fetched, so an
interrupted run continues where it stopped. Delete the output file to start over.
"""
import argparse
import csv
import random
import sys
import time
from pathlib import Path

from app.gee import DistrictNotFound, NoImagery, fetch_indices, get_district_geometry

DATA = Path(__file__).resolve().parents[1] / "data"
YIELD_CSV = DATA / "Wheat_Yield_Data.csv"
NAME_MAP_CSV = DATA / "District_Name_Map.csv"
OUT_CSV = DATA / "training_data_real.csv"

FIELDNAMES = [
    "district", "season", "ndvi", "evi", "ndwi", "savi", "nbr",
    "actual_yield", "yield_confidence",
]

# Seasons with no source yield data at all. Never fetched, never expected.
EXCLUDED_SEASONS = {"2019-20", "2023-24"}

# Districts created after the FAO/GAUL/2015 vintage, mapped to the GAUL-era
# district whose polygon still contains them.
#
# Boundary harmonisation, not a name fix. GAUL 2015 knows 34 Punjab districts;
# the PBS data uses 40. Pointing a child at its parent's polygon WITHOUT also
# merging the yields would give parent and child identical index values with
# different yields -- same X, different y, an irreducible error floor in the
# training set. So the yields are aggregated back to the parent too: areas and
# productions are summed and the yield recomputed, reconstructing the district
# as GAUL sees it. Verified against this dataset: production*1000/area
# reproduces the reported yield to within 2.8 kg/ha (rounding).
SPLIT_PARENTS = {
    "Nankana Sahib": "Sheikhupura",   # 2005
    "Chiniot": "Jhang",               # 2009
    "Kot Addu": "Muzaffargarh",       # 2022
    "Talagang": "Chakwal",            # 2022
    "Wazirabad": "Gujranwala",        # 2022
    "Murree": "Rawalpindi",           # 2022
}

# Sentinel-2 L2A begins 2017-03-28, so a rabi window ending before then has no
# imagery. Rather than hardcode a season list, derive it: this stays correct if
# the window or the collection ever changes.
SEASONS_WITH_IMAGERY_FROM = 2017   # first year of the "YYYY-YY" label

# The source reports kg/ha. Everything downstream -- the model, district_yields,
# the dashboard's 0-6 scale, the PDF -- is t/ha. Converting here keeps one unit
# in the system; leaving kg/ha would have the model predict 3200 where the UI
# renders "3200 t/ha".
KG_PER_HA_TO_T_PER_HA = 1 / 1000

# Be a polite GEE citizen: it is a free tier and 400+ reduceRegion calls in a
# tight loop will get throttled.
DELAY_SECONDS = 1.5
MAX_RETRIES = 4

# Reduction scale for DISTRICT-wide statistics, in metres.
#
# Not the same decision as the farm-level fetch, which stays at 20 m. A whole
# district is ~4,000-8,000 km2; at 20 m that is ~25 million pixels, and a
# median composite over ~100 scenes at that size exceeds GEE's free-tier
# memory ("User memory limit exceeded"). At 100 m it is ~1 million pixels.
#
# This does not touch the index computation -- the SCL mask, /10000 scaling and
# Gao NDWI formula are untouched. It only changes the grid the district MEAN is
# sampled on, and for an area this large a 100 m sample and a 20 m sample give
# essentially the same mean. Consistency matters more than resolution here:
# every row in the dataset must use the SAME scale, or the scale becomes a
# hidden variable the model could read.
DISTRICT_SCALE = 100

# If even that exceeds memory, coarsen rather than lose the row. Logged, so a
# row computed at a fallback scale is never silently mixed in unnoticed.
FALLBACK_SCALES = [250, 500]


def season_window(season: str) -> tuple[str, str]:
    """Rabi window for a 'YYYY-YY' season label: 1 Dec -> 15 Mar."""
    start_year = int(season.split("-")[0])
    return f"{start_year}-12-01", f"{start_year + 1}-03-15"


def load_name_map() -> dict:
    """source-printed district name -> standardized name.

    Keys are normalised so 'R.Y. Khan', 'R.Y Khan' and 'r y khan' all match --
    source-printed names are inconsistent about punctuation by nature.
    """
    if not NAME_MAP_CSV.exists():
        sys.exit(f"missing {NAME_MAP_CSV}")

    def norm(s):
        return "".join(ch for ch in str(s).lower() if ch.isalnum())

    mapping = {}
    with NAME_MAP_CSV.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        cols = reader.fieldnames or []
        # Accept whatever the two columns are called; first = raw, second =
        # standardized, unless headers say otherwise.
        raw_col = next((c for c in cols if "source" in c.lower() or "raw" in c.lower()
                        or c.lower().strip() == "district"), cols[0])
        std_col = next((c for c in cols if "standard" in c.lower()), cols[-1])
        for row in reader:
            raw, std = row.get(raw_col), row.get(std_col)
            if not raw or not std:
                continue
            # One row can list several printed spellings separated by '|',
            # e.g. "R.Y. Khan | Rahim Yar Khan | Rahimyar Khan". Each alias
            # needs its own key or the source rows using it never resolve.
            for alias in str(raw).split("|"):
                alias = alias.strip()
                if alias:
                    mapping[norm(alias)] = std.strip()
            mapping[norm(std)] = std.strip()   # standardized name maps to itself
    print(f"name map: {len(mapping)} alias(es) ({raw_col!r} -> {std_col!r})")
    return mapping


def load_yield_rows() -> list:
    if not YIELD_CSV.exists():
        sys.exit(f"missing {YIELD_CSV}")
    with YIELD_CSV.open(newline="", encoding="utf-8-sig") as fh:
        return list(csv.DictReader(fh))


def load_done() -> set:
    """(district, season) pairs already written. Drives resumability."""
    if not OUT_CSV.exists():
        return set()
    with OUT_CSV.open(newline="", encoding="utf-8-sig") as fh:
        return {(r["district"], r["season"]) for r in csv.DictReader(fh)}


def _is_memory_error(e) -> bool:
    return "memory limit" in str(e).lower()


def fetch_with_backoff(geometry, start, end):
    """Retry transient GEE failures; let NoImagery through immediately.

    A data gap is not transient -- retrying it four times with backoff would
    add ~30s per empty district-season, and there are a lot of those.

    A memory error is not transient either, but it IS fixable: back off on
    resolution instead of on time. Returns (indices, scale_used) so the caller
    can report any row that needed a coarser grid.
    """
    for scale in [DISTRICT_SCALE, *FALLBACK_SCALES]:
        delay = 2.0
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                return fetch_indices(geometry=geometry, start=start, end=end, scale=scale), scale
            except NoImagery:
                raise
            except Exception as e:
                if _is_memory_error(e):
                    break                      # retrying at the same scale cannot help
                if attempt == MAX_RETRIES:
                    raise
                sleep = delay * (2 ** (attempt - 1)) + random.uniform(0, 1)
                print(f"      retry {attempt}/{MAX_RETRIES - 1} in {sleep:.1f}s ({type(e).__name__})")
                time.sleep(sleep)
        print(f"      memory limit at {scale} m; coarsening")

    raise RuntimeError(f"memory limit exceeded even at {FALLBACK_SCALES[-1]} m")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="plan only, no GEE calls")
    ap.add_argument("--limit", type=int, help="stop after N fetches (smoke test)")
    ap.add_argument("--only", nargs="+", metavar="DISTRICT",
                    help="restrict to these GAUL-era districts (spot checks)")
    args = ap.parse_args()

    name_map = load_name_map()
    rows = load_yield_rows()
    done = load_done()
    print(f"yield rows: {len(rows)}   already built: {len(done)}")

    def norm(s):
        return "".join(ch for ch in str(s).lower() if ch.isalnum())

    # ---- pass 1: group source rows onto GAUL-era districts ----------------
    groups, skips = {}, {"excluded_season": 0, "pre_sentinel2": 0, "unmapped": 0,
                         "no_yield": 0, "already_done": 0}

    for r in rows:
        season = (r.get("Season") or "").strip()
        raw_district = (r.get("District") or "").strip()
        yield_kg = (r.get("Wheat Yield (kg/ha)") or "").strip()

        if season in EXCLUDED_SEASONS:
            skips["excluded_season"] += 1
            continue
        try:
            if int(season.split("-")[0]) < SEASONS_WITH_IMAGERY_FROM:
                skips["pre_sentinel2"] += 1
                continue
        except (ValueError, IndexError):
            skips["unmapped"] += 1
            print(f"  SKIP unparseable season {season!r} ({raw_district})")
            continue

        std = name_map.get(norm(raw_district))
        if not std:
            skips["unmapped"] += 1
            print(f"  SKIP unmapped district {raw_district!r} ({season})")
            continue

        if not yield_kg:
            # Legitimately missing combinations. Never estimated or filled.
            skips["no_yield"] += 1
            continue

        gaul_district = SPLIT_PARENTS.get(std, std)
        g = groups.setdefault((gaul_district, season),
                              {"members": [], "area": 0.0, "production": 0.0,
                               "yields": [], "statuses": []})
        g["members"].append(std)
        g["yields"].append(float(yield_kg))
        g["statuses"].append((r.get("Verification Status") or "").strip())
        try:
            g["area"] += float(r.get("Wheat Area (ha)") or 0)
            g["production"] += float(r.get("Wheat Production (tonnes)") or 0)
        except ValueError:
            g["area"] = g["production"] = 0.0   # forces the fallback below

    # ---- pass 2: resolve each group to one training row ------------------
    plan, merged_count = [], 0

    for (district, season), g in sorted(groups.items()):
        if len(g["members"]) == 1:
            # Untouched district: keep the source's own figure rather than a
            # recomputed one, so "directly reported" stays literally true.
            yield_kg = g["yields"][0]
            confidence = g["statuses"][0]
        elif g["area"] > 0:
            # Merged: production-weighted, which is what summing area and
            # production gives. A plain mean of the two yields would be wrong
            # whenever the districts differ in size, which they always do.
            yield_kg = g["production"] * 1000 / g["area"]
            confidence = (f"Calculated: merged {' + '.join(sorted(g['members']))} "
                          f"to GAUL-2015 {district}")
            merged_count += 1
            print(f"  MERGE {district:16s} {season}  <- {', '.join(sorted(g['members']))}"
                  f"  yield {yield_kg:.0f} kg/ha")
        else:
            skips["no_yield"] += len(g["members"])
            print(f"  SKIP  {district:16s} {season}  merge needs area/production, none usable")
            continue

        if (district, season) in done:
            skips["already_done"] += 1
            continue

        plan.append({
            "district": district, "season": season,
            "actual_yield": round(yield_kg * KG_PER_HA_TO_T_PER_HA, 4),
            "yield_confidence": confidence,
        })

    if merged_count:
        print(f"\n  merged {merged_count} parent-season group(s) to GAUL-2015 boundaries")

    if args.only:
        wanted = {norm(d) for d in args.only}
        before = len(plan)
        plan = [p for p in plan if norm(p["district"]) in wanted]
        print(f"  --only {args.only}: {len(plan)} of {before} row(s)")

    print("\nplan:")
    for k, v in skips.items():
        print(f"  skipped {k:16s} {v}")
    print(f"  to fetch              {len(plan)}")

    if args.dry_run:
        print("\n--dry-run: no GEE calls made")
        return

    if not plan:
        print("\nnothing to do")
        return

    # ---- fetch -----------------------------------------------------------
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    new_file = not OUT_CSV.exists()
    # Append mode is what makes this resumable: each row is durable the moment
    # it is fetched, so a crash at row 300 keeps the first 299.
    with OUT_CSV.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDNAMES)
        if new_file:
            writer.writeheader()

        ok = no_imagery = failed = 0
        coarsened = []
        for i, item in enumerate(plan, 1):
            if args.limit and ok >= args.limit:
                print(f"--limit {args.limit} reached")
                break
            try:
                geom = get_district_geometry(item["district"])
                idx, used_scale = fetch_with_backoff(geom, *season_window(item["season"]))
                if used_scale != DISTRICT_SCALE:
                    coarsened.append((item["district"], item["season"], used_scale))
            except DistrictNotFound as e:
                failed += 1
                print(f"  SKIP {item['district']:18s} {item['season']}  {e}")
                continue
            except NoImagery:
                no_imagery += 1
                print(f"  SKIP {item['district']:18s} {item['season']}  no imagery")
                continue
            except Exception as e:
                failed += 1
                print(f"  FAIL {item['district']:18s} {item['season']}  {type(e).__name__}: {e}")
                continue

            writer.writerow({
                "district": item["district"], "season": item["season"],
                "ndvi": idx["ndvi"], "evi": idx["evi"], "ndwi": idx["ndwi"],
                "savi": idx["savi"], "nbr": idx["nbr"],
                "actual_yield": item["actual_yield"],
                "yield_confidence": item["yield_confidence"],
            })
            fh.flush()
            ok += 1

            if i % 20 == 0 or i == len(plan):
                print(f"{i}/{len(plan)} done, {no_imagery} no-imagery, {failed} failed")

            time.sleep(DELAY_SECONDS)

    total = ok + no_imagery + failed
    rate = (no_imagery + failed) / total * 100 if total else 0
    if coarsened:
        print(f"\n{len(coarsened)} row(s) needed a coarser scale than {DISTRICT_SCALE} m:")
        for d, s, sc in coarsened:
            print(f"  {d} {s} at {sc} m")
    print(f"\nwrote {ok} row(s) -> {OUT_CSV}")
    print(f"skip rate this run: {rate:.1f}% ({no_imagery} no-imagery, {failed} failed)")
    if rate > 15:
        print("Skip rate above 15% -- check before training on this.")


if __name__ == "__main__":
    main()
