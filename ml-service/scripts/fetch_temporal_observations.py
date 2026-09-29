"""Step 11a: per-SCENE district index series, the raw material for temporal features.

    python -m scripts.fetch_temporal_observations --dry-run
    python -m scripts.fetch_temporal_observations --limit 2
    python -m scripts.fetch_temporal_observations            # the full run

EXPERIMENTAL. Writes data/temporal_observations_raw.csv and touches nothing
the production pipeline reads.

WHY THIS EXISTS. app.gee.fetch_indices reduces a crop's whole observation
window to ONE median composite, so green-up rate, peak height and senescence
timing are averaged into a single number and cannot be recovered. This fetches
the same districts, windows and indices, but keeps one row PER SCENE.

WHY IT IS BATCHED BY CROP-SEASON, NOT BY ROW. Every district in a crop-season
shares the same date window, so one ImageCollection serves all of them:
reduceRegions runs the per-scene reduction over all districts at once and the
whole block returns in a single getInfo. 2378 district-crop-seasons collapse
to 85 crop-season units, which is the difference between a ~20-hour run and a
few hours.

WHY 500 m AND NOT THE 100 m THE COMPOSITE USES. The composite reduces one
image; this reduces every scene in the window -- 50-150 of them -- so the
per-request pixel budget is two orders of magnitude larger and 100 m exceeds
the free tier. A district is ~5,000 km2, which is still ~20,000 pixels at
500 m, so the district MEAN is barely affected. It is a real difference from
the baseline all the same, which is why the build script also recomputes a
median-over-scenes column at THIS scale: the temporal-vs-median comparison is
then like-for-like, and the production model stays the separate, independent
baseline.

RESUMABLE: whole (crop, season) units already in the output are never refetched.
"""
import argparse
import csv
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import ee

from app.crops import INDEX_FEATURES, season_window
from app.gee import GAUL_L2, NoImagery, gaul_lookup, init, norm_district, with_retry

DATA = Path(__file__).resolve().parents[1] / "data"
LABELS_CSV = DATA / "training_data_real.csv"          # read-only, never written
# Every artifact this experiment produces lives OUTSIDE the ml-service tree,
# in experimental/temporal_features/. The experimental model sat in app/ for
# one run and that is one run too many: app/model.pkl is loaded by path, so a
# rename or a tab-completion slip is all that stands between a research
# artifact and the production predictor. Separate directories remove the
# possibility rather than relying on the filename.
EXPERIMENT = Path(__file__).resolve().parents[2] / "experimental" / "temporal_features"
OUT_CSV = EXPERIMENT / "temporal_observations_raw.csv"

FIELDNAMES = ["crop", "season", "district", "date", *INDEX_FEATURES,
              "cloud_pct", "valid_px", "scale_m"]

# Same scene-level cloud cut as the production composite, so the two
# representations see the same scenes and any difference is the reduction,
# not the filtering.
MAX_SCENE_CLOUD = 20

SCALE_M = 500
FALLBACK_SCALES = [1000]

# Dates per request. A long window (sugarcane runs March-November) stacks
# enough bands to exceed the memory budget, so the dates are split and the
# results merged. Halving the chunk is tried before coarsening the scale,
# because a smaller chunk costs time while a coarser scale costs resolution.
DATE_CHUNKS = [48, 16, 6, 2]
TILE_SCALES = [4, 16]

DELAY_SECONDS = 1.0


def plan_units():
    """{(crop, season): [district, ...]} taken from the EXISTING label file.

    Deriving the plan from training_data_real.csv rather than re-deriving it
    from the PBS sources guarantees the experiment covers exactly the rows the
    production model was trained on -- same districts, same seasons, same
    labels -- so a difference in results cannot be a difference in coverage.
    """
    units = defaultdict(set)
    with LABELS_CSV.open(newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            units[(r["crop_type"], r["season"])].add(r["district"])
    return {k: sorted(v) for k, v in sorted(units.items())}


def done_units():
    if not OUT_CSV.exists():
        return set()
    with OUT_CSV.open(newline="", encoding="utf-8-sig") as fh:
        return {(r["crop"], r["season"]) for r in csv.DictReader(fh)}


def district_fc(names):
    """One FeatureCollection holding the GAUL polygons for these districts."""
    lookup = gaul_lookup()
    missing = [n for n in names if norm_district(n) not in lookup]
    if missing:
        raise KeyError(f"not GAUL ADM2 names: {missing}")
    gaul_names = [lookup[norm_district(n)] for n in names]
    return (ee.FeatureCollection(GAUL_L2)
            .filter(ee.Filter.eq("ADM0_NAME", "Pakistan"))
            .filter(ee.Filter.inList("ADM2_NAME", gaul_names)))


def _mask_and_index(img):
    """Cloud-mask one scene and compute the five indices on it.

    The same index definitions as app.gee.fetch_indices and
    app.field._mask_and_index, including Gao's NDWI (B8 vs B11). Any edit to
    one must be made in all three.
    """
    from app.gee import _mask_clouds

    s = _mask_clouds(img).divide(10000)
    b2, b4, b8, b11, b12 = (s.select(b) for b in ("B2", "B4", "B8", "B11", "B12"))

    ndvi = b8.subtract(b4).divide(b8.add(b4))
    savi = b8.subtract(b4).multiply(1.5).divide(b8.add(b4).add(0.5))
    nbr = b8.subtract(b12).divide(b8.add(b12))
    evi = (b8.subtract(b4).multiply(2.5)
           .divide(b8.add(b4.multiply(6)).subtract(b2.multiply(7.5)).add(1)))
    ndwi = b8.subtract(b11).divide(b8.add(b11))

    return (ee.Image.cat([ndvi, evi, ndwi, savi, nbr])
            .rename(INDEX_FEATURES)
            .copyProperties(img, ["system:time_start", "CLOUDY_PIXEL_PERCENTAGE"]))


def season_collection(fc, start, end):
    """Cloud-masked, indexed Sentinel-2 over these districts and dates."""
    return (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
            .filterBounds(fc)
            .filterDate(start, end)
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", MAX_SCENE_CLOUD))
            .map(_mask_and_index))


def observation_dates(col):
    """[(date, mean scene cloud %)] for every date the collection covers.

    ONE OBSERVATION PER DATE, not per scene. Punjab spans several Sentinel-2
    tiles, so a district is covered by 2-6 granules on a single overpass day.
    Reduced granule by granule, each one contributes a PARTIAL district mean
    and the same date arrives as several disagreeing rows -- which the feature
    engineering downstream would read as real day-to-day variation.
    """
    got = with_retry(
        lambda: ee.Dictionary({
            "t": col.aggregate_array("system:time_start"),
            "c": col.aggregate_array("CLOUDY_PIXEL_PERCENTAGE"),
        }).getInfo(),
        what="observation dates")

    by_date = defaultdict(list)
    for t, c in zip(got["t"], got["c"]):
        d = datetime.fromtimestamp(t / 1000, timezone.utc).date().isoformat()
        by_date[d].append(float(c))
    return [(d, round(sum(v) / len(v), 1)) for d, v in sorted(by_date.items())]


def fetch_block(fc, col, dates, scale, tile_scale):
    """{(district, date): {index: value, valid_px: n}} in ONE getInfo.

    WHY ONE MULTI-BAND IMAGE rather than one reduction per date. The obvious
    shape -- map a reduceRegions over a collection of daily mosaics -- makes
    Earth Engine materialise districts x dates features, and it was measured
    at 392s for a single crop-season before falling back to one district per
    request. Stacking the dates as bands of one image instead turns the same
    work into 34 features and one request: the same crop-season came back in
    15s. Band `ndvi__3` is NDVI on dates[3].
    """
    imgs = []
    for i, (d, _) in enumerate(dates):
        day = col.filterDate(d, ee.Date(d).advance(1, "day"))
        imgs.append(day.mosaic().rename([k + "__" + str(i) for k in INDEX_FEATURES]))

    reducer = ee.Reducer.mean().combine(ee.Reducer.count(), None, True)
    raw = with_retry(
        lambda: ee.Image.cat(imgs).reduceRegions(
            collection=fc, reducer=reducer, scale=scale,
            tileScale=tile_scale).getInfo(),
        what="temporal stack")

    out = {}
    for f in raw.get("features", []):
        p = f["properties"]
        district = p["ADM2_NAME"]
        for i, (d, cloud) in enumerate(dates):
            vals = {}
            for k in INDEX_FEATURES:
                v = p.get(k + "__" + str(i) + "_mean")
                vals[k] = None if v is None else round(float(v), 4)
            if all(v is None for v in vals.values()):
                # Every pixel of this district masked out on this date: an
                # absence of observation, not an observation of nothing.
                continue
            vals["cloud_pct"] = cloud
            vals["valid_px"] = int(p.get("ndvi__" + str(i) + "_count") or 0)
            out[(district, d)] = vals
    return out


def _is_limit(e):
    s = str(e).lower()
    return ("memory" in s or "too many" in s or "computation timed out" in s
            or "request payload size" in s or "accumulating over" in s)


def fetch_unit(names, start, end):
    """One crop-season: [{district, date, indices, cloud_pct, valid_px}], scale.

    Degrades date-chunk size, then tileScale, then reduction scale, rather
    than losing the unit.
    """
    init()
    fc = district_fc(names)
    # ADM2_NAME comes back in GAUL spelling ("Bahawalnagar District") while
    # every other file in the project uses the standardized name. Map it back
    # here, or the join to the yield labels silently finds nothing.
    lookup = gaul_lookup()
    to_std = {lookup[norm_district(n)]: n for n in names}

    col = season_collection(fc, start, end)
    dates = observation_dates(col)
    if not dates:
        raise NoImagery("no scenes under %d%% cloud in %s..%s"
                        % (MAX_SCENE_CLOUD, start, end))

    for scale in [SCALE_M] + FALLBACK_SCALES:
        for tile in TILE_SCALES:
            for size in DATE_CHUNKS:
                try:
                    merged = {}
                    for i in range(0, len(dates), size):
                        merged.update(fetch_block(fc, col, dates[i:i + size], scale, tile))
                        if size < len(dates):
                            time.sleep(DELAY_SECONDS)
                except Exception as e:                   # noqa: BLE001
                    if not _is_limit(e):
                        raise
                    print("      limit hit at %d dates/request, tileScale=%d, %dm"
                          % (size, tile, scale))
                    continue

                rows = []
                for (gaul, d), vals in sorted(merged.items()):
                    row = {"district": to_std.get(gaul, gaul), "date": d}
                    row.update(vals)
                    rows.append(row)
                return rows, scale, len(dates)

    raise RuntimeError("still over the limit at the coarsest scale and smallest chunk")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, help="stop after N crop-season units")
    ap.add_argument("--crop", help="one crop only")
    args = ap.parse_args()

    units = plan_units()
    if args.crop:
        units = {k: v for k, v in units.items() if k[0] == args.crop}
    done = done_units()
    todo = {k: v for k, v in units.items() if k not in done}

    print("%d crop-season unit(s), %d already fetched, %d to go (%d district-rows)"
          % (len(units), len(done), len(todo), sum(len(v) for v in todo.values())))
    if args.dry_run:
        for (c, s), names in list(todo.items())[:10]:
            print("  %-10s %s  %2d districts  %s" % (c, s, len(names), season_window(c, s)))
        return
    if not todo:
        print("nothing to do")
        return

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    new = not OUT_CSV.exists()
    with OUT_CSV.open("a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDNAMES)
        if new:
            w.writeheader()
        for n, ((crop, season), names) in enumerate(todo.items(), 1):
            if args.limit and n > args.limit:
                print("--limit %d reached" % args.limit)
                break
            start, end = season_window(crop, season)
            t0 = time.time()
            try:
                rows, scale, n_dates = fetch_unit(names, start, end)
            except NoImagery:
                print("[%d/%d] %-10s %s  no imagery" % (n, len(todo), crop, season))
                continue
            except Exception as e:                       # noqa: BLE001
                print("[%d/%d] %-10s %s  FAIL %s: %s"
                      % (n, len(todo), crop, season, type(e).__name__, e))
                continue
            for r in rows:
                out = {"crop": crop, "season": season, "scale_m": scale}
                out.update(r)
                w.writerow(out)
            fh.flush()
            got = len(set(r["district"] for r in rows))
            print("[%d/%d] %-10s %s  %5d obs  %d/%d districts  %d dates  %dm  %.0fs"
                  % (n, len(todo), crop, season, len(rows), got, len(names),
                     n_dates, scale, time.time() - t0))
            time.sleep(DELAY_SECONDS)


if __name__ == "__main__":
    main()
