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

from app.districts import CROPS, season_window
from app.gee import DistrictNotFound, NoImagery, fetch_indices, get_district_geometry

DATA = Path(__file__).resolve().parents[1] / "data"
# One input file per crop. Rice is filtered to Rice Category == "Total Rice"
# (see load_yield_rows): Basmati and Non-Basmati are subcomponents of the
# same district-season, so including them would triple-count each
# observation and smuggle in a variety dimension the model cannot use.
# Every crop now reads from ONE normalised file rather than a file per crop.
# Built by scripts.pbs_all_crops_to_csv from the PBS all-Pakistan workbook,
# which was cross-checked against the CRS wheat series: 391 of 393 overlapping
# district-seasons matched to within 5 kg/ha, so the two sources corroborate.
#
# Only crops that ALSO have an observation window in data/crops.csv can be
# fetched -- a yield with no window has no imagery to join to. The registry is
# the gate, so adding a crop here means adding it there first.
PBS_ALL = "PBS_all_crops.csv"
PBS_COLS = ("Yield", "Area (ha)", "Production (tonnes)")

CROP_FILES = {
    c: (PBS_ALL, *PBS_COLS)
    for c in ("wheat", "rice", "maize", "sugarcane", "cotton", "barley",
              "bajra", "jowar", "potato", "onion", "tomato")
}
NAME_MAP_CSV = DATA / "District_Name_Map.csv"
OUT_CSV = DATA / "training_data_real.csv"

# crop_type is part of the row identity now, not just a label: the resume
# check and the model feature both key on it.
FIELDNAMES = [
    "district", "season", "crop_type", "ndvi", "evi", "ndwi", "savi", "nbr",
    "actual_yield", "yield_confidence",
]

# Seasons with no source yield data at all. Never fetched, never expected.
# Seasons with no source yield data at all. Emptied once the PBS all-crops
# workbook arrived: it covers 2017-18 through 2024-25 continuously, including
# the two seasons the older CRS spreadsheet was missing. Kept as a hook rather
# than deleted, because a future crop may genuinely have gaps.
EXCLUDED_SEASONS = set()

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


# season_window now comes from app.districts -- see the import above. The local
# rabi-only copy that used to live here shadowed it, which is why rice windows
# were defined but never reachable from this script.


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


def load_yield_rows(crop: str) -> list:
    """Source yield rows for one crop, already filtered to one row per
    district-season."""
    filename = CROP_FILES[crop][0]
    path = DATA / filename
    if not path.exists():
        sys.exit(f"missing {path}. Run: python -m scripts.pbs_all_crops_to_csv")

    with path.open(newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))

    # The normalised file holds every crop in one table, so select this one.
    if rows and "Crop" in rows[0]:
        rows = [r for r in rows if (r.get("Crop") or "").strip().lower() == crop]
        if not rows:
            sys.exit(f"{filename} has no rows for {crop!r}")

    if crop == "rice" and rows and any("category" in c.lower() for c in rows[0]):
        # "Total Rice" only. Basmati and Non-Basmati are subcomponents of the
        # SAME district-season, so keeping all three would enter each
        # observation three times with three different yields -- inflating the
        # row count while contradicting itself, and adding a variety dimension
        # the feature vector has no column for.
        cat_col = next((c for c in (rows[0] if rows else {}) if "category" in c.lower()), None)
        if not cat_col:
            sys.exit(f"{filename} has no 'Rice Category' column; refusing to guess "
                     f"which rows are totals")
        before = len(rows)
        rows = [r for r in rows if (r.get(cat_col) or "").strip().lower() == "total rice"]
        print(f"  {filename}: {before} row(s) -> {len(rows)} 'Total Rice' row(s)")

    return rows


def yield_to_t_per_ha(value: str, unit: str | None, crop: str) -> float:
    """Normalise a reported yield to t/ha.

    The rice file carries an explicit 'Yield Unit' column, so the unit is read
    rather than assumed. Assuming kg/ha for a file reporting maunds/acre would
    be a silent 40x error that looks like a plausible number.
    """
    v = float(value)
    u = (unit or "").strip().lower().replace(" ", "")

    if not u:
        # Wheat file has no unit column; its header states kg/ha.
        return v * KG_PER_HA_TO_T_PER_HA
    if "kg" in u and ("ha" in u or "hect" in u):
        return v * KG_PER_HA_TO_T_PER_HA
    if ("tonne" in u or u.startswith("t/")) and ("ha" in u or "hect" in u):
        return v
    raise ValueError(
        f"unrecognised yield unit {unit!r} for {crop}. Add a conversion in "
        f"yield_to_t_per_ha() rather than letting it through unconverted."
    )


def load_done() -> set:
    """(district, season) pairs already written. Drives resumability."""
    if not OUT_CSV.exists():
        return set()
    with OUT_CSV.open(newline="", encoding="utf-8-sig") as fh:
        # Rows written before crop_type existed are wheat by definition.
        return {(r["district"], r["season"], r.get("crop_type") or "wheat")
                for r in csv.DictReader(fh)}


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
    # Choices come from CROP_FILES, not CROPS: CROPS is the model's feature
    # vector (what it can predict), while CROP_FILES is what has both yield
    # data and an observation window (what can be fetched). Fetching has to
    # come first -- a crop cannot enter the model until its rows exist.
    ap.add_argument("--crop", choices=sorted(CROP_FILES), default="wheat")
    ap.add_argument("--all-crops", action="store_true",
                    help="fetch every crop in CROP_FILES, in turn")
    ap.add_argument("--dry-run", action="store_true", help="plan only, no GEE calls")
    ap.add_argument("--limit", type=int, help="stop after N fetches (smoke test)")
    ap.add_argument("--only", nargs="+", metavar="DISTRICT",
                    help="restrict to these GAUL-era districts (spot checks)")
    args = ap.parse_args()

    # --all-crops runs the whole body once per crop. A loop rather than a
    # rewrite, because every crop takes the identical path: the only thing
    # that changes is which observation window season_window() returns.
    #
    # Order matters for a run that may be interrupted, and the right order
    # changes as the dataset fills.
    #
    # This was least-TOTAL-rows-first, to get the most crops represented
    # earliest from a standing start. That rule expired once most crops were
    # largely fetched: it kept sorting on total size while what is actually at
    # risk is the OUTSTANDING work, and the two diverged badly. Potato and
    # tomato read as "small" on their old totals and were scheduled last,
    # while carrying 528 of the 800 remaining rows between them -- so an
    # interruption would have cost the two biggest blocks of genuinely new
    # data and saved a handful of five-row top-ups.
    #
    # So: most-outstanding-first, counted against what is already on disk.
    # Self-correcting on every resume, because the counts are recomputed here
    # rather than written down.
    if args.all_crops:
        done = load_done()
        name_map = load_name_map()

        def _norm(s):
            return "".join(ch for ch in str(s).lower() if ch.isalnum())

        outstanding = {}
        for c in CROP_FILES:
            # Standardise here too. load_done() holds GAUL names while the
            # source prints its own, so comparing them raw would find no
            # overlap and report every crop as untouched.
            planned = set()
            for r in load_yield_rows(c):
                std = name_map.get(_norm(r["District"]))
                if std and int(r["Season"].split("-")[0]) >= SEASONS_WITH_IMAGERY_FROM:
                    planned.add((std, r["Season"]))
            outstanding[c] = sum(1 for d, s in planned if (d, s, c) not in done)
        order = sorted(CROP_FILES, key=lambda c: -outstanding[c])
        total = sum(outstanding.values())
        print(f"all-crops run, {len(order)} crops, most outstanding work first "
              f"({total} rows to go):")
        for c in order:
            print(f"    {c:10s} {outstanding[c]:>5d}")
        bar = "=" * 62
        for n, c in enumerate(order, 1):
            print("")
            print(bar)
            print(f"[{n}/{len(order)}] {c}")
            print(bar)
            args.crop = c
            args.all_crops = False
            run_one(args)
        return
    run_one(args)


def run_one(args):
    crop = args.crop
    _, yield_col, area_col, prod_col = CROP_FILES[crop]
    name_map = load_name_map()
    rows = load_yield_rows(crop)
    done = load_done()
    print(f"crop: {crop}   yield rows: {len(rows)}   already built: {len(done)}")

    def norm(s):
        return "".join(ch for ch in str(s).lower() if ch.isalnum())

    # ---- pass 1: group source rows onto GAUL-era districts ----------------
    groups, skips = {}, {"excluded_season": 0, "pre_sentinel2": 0, "unmapped": 0,
                         "no_yield": 0, "already_done": 0}

    for r in rows:
        season = (r.get("Season") or "").strip()
        raw_district = (r.get("District") or "").strip()
        yield_raw = (r.get(yield_col) or "").strip()
        unit = r.get("Yield Unit")

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

        if not yield_raw:
            # Legitimately missing combinations. Never estimated or filled.
            skips["no_yield"] += 1
            continue

        gaul_district = SPLIT_PARENTS.get(std, std)
        g = groups.setdefault((gaul_district, season),
                              {"members": [], "area": 0.0, "production": 0.0,
                               "yields": [], "statuses": []})
        g["members"].append(std)
        g["yields"].append(yield_to_t_per_ha(yield_raw, unit, crop))
        g["statuses"].append((r.get("Verification Status") or "").strip())
        try:
            g["area"] += float(r.get(area_col) or 0)
            g["production"] += float(r.get(prod_col) or 0)
        except ValueError:
            g["area"] = g["production"] = 0.0   # forces the fallback below

    # ---- pass 2: resolve each group to one training row ------------------
    plan, merged_count = [], 0

    for (district, season), g in sorted(groups.items()):
        if len(g["members"]) == 1:
            # Untouched district: keep the source's own figure rather than a
            # recomputed one, so "directly reported" stays literally true.
            yield_t = g["yields"][0]
            confidence = g["statuses"][0]
        elif g["area"] > 0:
            # Merged: production-weighted, which is what summing area and
            # production gives. A plain mean of the two yields would be wrong
            # whenever the districts differ in size, which they always do.
            # production (t) / area (ha) is ALREADY t/ha -- no x1000 here,
            # unlike the kg/ha figure the sources print.
            yield_t = g["production"] / g["area"]
            confidence = (f"Calculated: merged {' + '.join(sorted(g['members']))} "
                          f"to GAUL-2015 {district}")
            merged_count += 1
            print(f"  MERGE {district:16s} {season}  <- {', '.join(sorted(g['members']))}"
                  f"  yield {yield_t:.3f} t/ha")
        else:
            skips["no_yield"] += len(g["members"])
            print(f"  SKIP  {district:16s} {season}  merge needs area/production, none usable")
            continue

        if (district, season, crop) in done:
            skips["already_done"] += 1
            continue

        plan.append({
            "district": district, "season": season, "crop_type": crop,
            "actual_yield": round(yield_t, 4),
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
                idx, used_scale = fetch_with_backoff(geom, *season_window(crop, item["season"]))
                if used_scale != DISTRICT_SCALE:
                    coarsened.append((item["district"], item["season"], used_scale))
            except DistrictNotFound as e:
                failed += 1
                print(f"  SKIP {item['district']:18s} {item['season']}  {e}")
                continue
            except NoImagery:
                # Kharif overlaps the monsoon, so this is expected to be
                # commoner for rice than wheat: a physical limit of optical
                # imagery, not a defect. Counted separately from failures
                # so the two can never be confused in the summary.
                no_imagery += 1
                print(f"  SKIP {item['district']:18s} {item['season']}  "
                      f"no cloud-free imagery in window")
                continue
            except Exception as e:
                failed += 1
                print(f"  FAIL {item['district']:18s} {item['season']}  {type(e).__name__}: {e}")
                continue

            writer.writerow({
                "district": item["district"], "season": item["season"],
                "crop_type": crop,
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
    print(f"skip rate this run: {rate:.1f}%")
    print(f"  cloud / no imagery : {no_imagery:3d}   (physical limit, worse in kharif)")
    print(f"  hard failures      : {failed:3d}   (name resolution, GEE errors)")
    if rate > 15:
        print(f"\nSkip rate above 15%. For {crop} in the monsoon-overlapping kharif "
              f"window a high cloud count is expected; a high FAILURE count is not.")


if __name__ == "__main__":
    main()
