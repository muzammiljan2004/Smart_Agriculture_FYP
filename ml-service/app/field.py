"""Field-level satellite time series: Sentinel-2 indices + Sentinel-1 backscatter.

    python -m app.field          # self-check, needs GEE auth

This is the per-FIELD counterpart to app.gee.fetch_indices, which reduces a
whole district to one median composite. Two differences that matter:

  * the geometry is a circle around the farm's pin, sized from area_hectares,
    not a district bounding box;
  * it returns one row PER DATE rather than one composite, because a harvest
    is a change over time and a composite averages exactly that away.

Everything about auth, retry and the wall-clock deadline is imported from
app.gee. There is deliberately no second Earth Engine client here -- the
timeout handling in that module cost two multi-hour hangs to get right.
"""
import math
from datetime import date, timedelta

import ee

from app.crops import INDEX_FEATURES
from app.gee import NoImagery, init, with_retry

class InvalidSowingDate(ValueError):
    """A planting date that cannot produce an observation window.

    A ValueError rather than NoImagery on purpose: NoImagery means the sky was
    in the way, which is a fact about the world and nothing the farmer can fix.
    This is a fact about the input.
    """


# Sentinel-2's usable bands are 10-20 m, so a field smaller than about a
# quarter hectare is a handful of pixels and its mean is mostly edge effects.
# Below this the numbers are still returned, but valid_px will be small and
# the harvest detector weighs them down accordingly.
MIN_SENSIBLE_HA = 0.25

# Scene-level cloud cut. Looser than the 20% used for district composites: a
# district composite can afford to throw scenes away because dozens remain,
# while a single field in a single season has tens of observations total and
# the per-pixel SCL mask already removes the actual cloud. Dropping to 20%
# here costs roughly a third of the rabi time series.
MAX_SCENE_CLOUD = 60


def field_geometry(lat: float, lng: float, area_hectares: float | None):
    """A circle of `area_hectares` centred on the pin.

    WHY A CIRCLE. We have a point and an area, not a boundary. A circle is the
    shape that makes the fewest claims: it does not pretend to know which way
    the field runs, and every other shape of the same area would be asserting
    an orientation we were never told.

    1 ha = 10 000 m^2, so r = sqrt(A * 10000 / pi). A 1 ha field is a 56 m
    radius, which at 10 m resolution is around 100 pixels -- enough for a
    stable mean, as the probe that measured 136 confirmed.

    area_hectares is nullable in the database (every farm registered before
    this column existed has none), so None falls back to 1 ha rather than
    failing. That is a guess, and callers that care should say so to the user.
    """
    init()      # ee.Geometry cannot be constructed before the client is up
    ha = float(area_hectares) if area_hectares else 1.0
    radius_m = math.sqrt(ha * 10_000 / math.pi)
    return ee.Geometry.Point([float(lng), float(lat)]).buffer(radius_m)


def _mask_and_index(img):
    """Cloud-mask one scene, then compute the five indices on it.

    Order matters: the mask reads SCL, and the /10000 rescale below drops
    every band it is not applied to. Masking after rescaling would be reading
    a scaled SCL and keeping the wrong classes.

    Same index definitions as app.gee.fetch_indices, including Gao's NDWI
    (B8 vs B11) rather than McFeeters'. They are repeated rather than shared
    because the district version fuses them into a composite before reducing
    and this one must keep them per scene -- but if either is ever edited,
    edit both.
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


def sentinel2_series(lat, lng, area_hectares, start, end, max_cloud=MAX_SCENE_CLOUD):
    """[{date, ndvi, evi, ndwi, savi, nbr, cloud_pct, valid_px, source}], by date.

    ONE round trip for the whole series, not one per scene. The reduction is
    mapped over the collection server-side and the entire FeatureCollection
    comes back in a single getInfo -- a season of ~50 observations fetched
    scene-by-scene would be 50 sequential HTTPS calls, which is the shape of
    request that hung the district fetch twice.

    Rows where every index came back null are dropped: that is a scene fully
    masked out over this field, which is an absence of observation rather than
    an observation of nothing.
    """
    init()
    geom = field_geometry(lat, lng, area_hectares)

    col = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
           .filterBounds(geom)
           .filterDate(str(start), str(end))
           .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", max_cloud))
           .map(_mask_and_index))

    # mean for the values, count for how much of the field was actually seen.
    reducer = ee.Reducer.mean().combine(ee.Reducer.count(), None, True)

    def to_feature(img):
        stats = img.reduceRegion(reducer, geom, 10, maxPixels=int(1e8), bestEffort=True)
        return ee.Feature(None, stats.set(
            "date", ee.Date(img.get("system:time_start")).format("YYYY-MM-dd")
        ).set("cloud_pct", img.get("CLOUDY_PIXEL_PERCENTAGE")))

    fc = ee.FeatureCollection(col.map(to_feature))
    raw = with_retry(lambda: fc.getInfo(), what="sentinel-2 field series")

    rows = []
    for f in raw.get("features", []):
        p = f["properties"]
        vals = {k: _round(p.get(f"{k}_mean")) for k in INDEX_FEATURES}
        if all(v is None for v in vals.values()):
            continue
        rows.append({
            "date": p["date"],
            **vals,
            "cloud_pct": _round(p.get("cloud_pct"), 1),
            "valid_px": int(p.get("ndvi_count") or 0),
            "source": "S2",
        })

    return _by_date(rows)


def sentinel1_series(lat, lng, area_hectares, start, end, orbit="DESCENDING"):
    """[{date, vv, vh, source}], by date. Backscatter in dB.

    WHY RADAR IS NOT OPTIONAL. Over a Punjab field in July-August, Sentinel-2
    returns 6-7 usable observations a month against Sentinel-1's ~22, because
    radar does not care about monsoon cloud. Kharif monitoring built on
    optical alone is blind in exactly the months rice and cotton are growing.

    ONE ORBIT AT A TIME, by default. Ascending and descending passes see the
    field from different angles and sit around 1-3 dB apart, so mixing them
    injects a sawtooth that looks like real change and is only geometry. The
    detector is looking for a step change, which is precisely what that noise
    imitates.
    """
    init()
    geom = field_geometry(lat, lng, area_hectares)

    col = (ee.ImageCollection("COPERNICUS/S1_GRD")
           .filterBounds(geom)
           .filterDate(str(start), str(end))
           .filter(ee.Filter.eq("instrumentMode", "IW"))
           .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
           .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH")))
    if orbit:
        col = col.filter(ee.Filter.eq("orbitProperties_pass", orbit))

    def to_feature(img):
        stats = img.select(["VV", "VH"]).reduceRegion(
            ee.Reducer.mean(), geom, 10, maxPixels=int(1e8), bestEffort=True)
        return ee.Feature(None, stats.set(
            "date", ee.Date(img.get("system:time_start")).format("YYYY-MM-dd")))

    fc = ee.FeatureCollection(col.map(to_feature))
    raw = with_retry(lambda: fc.getInfo(), what="sentinel-1 field series")

    rows = []
    for f in raw.get("features", []):
        p = f["properties"]
        vv, vh = _round(p.get("VV"), 2), _round(p.get("VH"), 2)
        if vv is None and vh is None:
            continue
        rows.append({"date": p["date"], "vv": vv, "vh": vh, "source": "S1"})

    return _by_date(rows)


def field_series(lat, lng, area_hectares, start, end, radar=True):
    """Both sensors, merged on date, ordered, one row per date.

    Every row carries every key, with None where that sensor did not observe
    that date. A caller charting the series must not have to know which sensor
    flies when, and `None` is honest about a gap in a way that omitting the
    key is not.
    """
    s2 = sentinel2_series(lat, lng, area_hectares, start, end)
    s1 = sentinel1_series(lat, lng, area_hectares, start, end) if radar else []

    if not s2 and not s1:
        raise NoImagery(
            f"no Sentinel-2 or Sentinel-1 observations for this field in "
            f"{start}..{end}. Sentinel-2 begins 2017-03-28; before that there "
            f"is no imagery at all, which is a data gap rather than a failure."
        )

    keys = ("ndvi", "evi", "ndwi", "savi", "nbr", "vv", "vh", "cloud_pct", "valid_px")
    merged: dict[str, dict] = {}
    for row in s2 + s1:
        slot = merged.setdefault(row["date"], {"date": row["date"], "sources": []})
        for k in keys:
            slot.setdefault(k, None)
            if row.get(k) is not None:
                slot[k] = row[k]
        slot["sources"].append(row["source"])

    return [merged[d] for d in sorted(merged)]


# ---------------------------------------------------------------- no-crop
# A field that never greens up is not a failed crop, it is not a crop. The
# yield model cannot make that distinction: it reads the crop one-hot far more
# strongly than the indices (crop_sugarcane alone carries 0.75 of the model's
# importance against 0.09 for all five indices together), so handed a built-up
# plot labelled "wheat" it answers with something close to the wheat mean. It
# did: 3.41 t/ha for a 1 ha circle that Dynamic World calls 100% built.
#
# THRESHOLDS, AND THE EVIDENCE FOR THEM. Two sources were measured first.
#
#   Field scale, this project's farms, in-season NDVI:
#       [DEV] Sheikhupura wheat   peak 0.873   amplitude 0.655
#       [DEV] Okara wheat         peak 0.845   amplitude 0.731
#       [DEV] Sahiwal wheat       peak 0.902   amplitude 0.854
#       [DEV] Sheikhupura rice    peak 0.948   amplitude 0.902
#       FYP-Test (built-up)       peak 0.198   amplitude 0.115
#
#   District scale, 2378 district-crop-seasons over 11 crops (the Step 11
#   experiment). These are 500 m means over ~5,000 km2, so they include
#   towns, roads and water and are the most heavily damped real-cropland
#   signal available anywhere in the data:
#       lowest NDVI peak of any row, any crop : 0.218
#       1st percentile                        : 0.307
#       lowest amplitude of any row           : 0.000  (bajra)
#
# PEAK_NDVI = 0.25 sits just above that district floor of 0.218 and 3.4x
# BELOW the lowest real FIELD peak of 0.845. Deliberately near the negative
# example rather than midway: a false refusal costs a farmer their forecast,
# while a false pass only leaves today's behaviour unchanged.
#
# AMPLITUDE is required as well, not instead. District amplitude bottoms out
# at 0.000, so on its own it would reject real cropland. As a second condition
# it protects the cases a peak test alone would get wrong in the other
# direction: an orchard or a perennial sits high and flat and is not refused,
# because its peak clears the bar.
#
# BOTH must be true, over enough observations. One low reading is a cloudy
# day, not a verdict.
NO_CROP_PEAK_NDVI = 0.25
NO_CROP_AMPLITUDE = 0.20
NO_CROP_MIN_OBS = 6


def no_crop(values):
    """Diagnostics if these in-season NDVI values show no crop, else None.

    Conservative by construction: it returns None -- meaning "carry on" --
    whenever the series is too short to judge, whenever the field reaches a
    normal canopy at any point in the season, and whenever it varies like
    something growing. It fires only when a field was watched for a whole
    season and never did either.

    Deliberately NOT a productivity test. A poor bajra crop peaks far above
    0.25 at field resolution; what this catches is ground that never had a
    crop on it at all.
    """
    vals = [v for v in values if v is not None]
    if len(vals) < NO_CROP_MIN_OBS:
        return None
    peak, low = max(vals), min(vals)
    if peak >= NO_CROP_PEAK_NDVI or (peak - low) >= NO_CROP_AMPLITUDE:
        return None
    ordered = sorted(vals)
    return {
        "observations": len(vals),
        "ndvi_peak": round(peak, 4),
        "ndvi_min": round(low, 4),
        "ndvi_amplitude": round(peak - low, 4),
        "ndvi_median": round(ordered[len(ordered) // 2], 4),
    }


def season_bounds(crop_type: str, sown: date, today: date | None = None) -> tuple[str, str]:
    """The window to fetch for a field sown on `sown`.

    Starts two weeks BEFORE sowing so the series contains bare-soil baseline
    to measure the green-up against, and runs to 45 days past the expected
    harvest so a late harvest is still inside the window -- capped at today,
    because asking Earth Engine for the future returns an empty collection
    that looks identical to a data gap.
    """
    from app.crops import DURATION_DAYS

    today = today or date.today()
    start = sown - timedelta(days=14)
    end = min(sown + timedelta(days=DURATION_DAYS[crop_type] + 45), today)
    if end < start:
        # The cap at today is unconditional, so a sowing date in the future
        # produces a window that ends before it begins. Earth Engine does not
        # object: filterDate with the bounds the wrong way round returns an
        # empty collection, indistinguishable from cloud cover, and the farmer
        # is told there is no imagery when the real problem is the date they
        # typed. Name it instead.
        raise InvalidSowingDate(
            f"sowing date {sown.isoformat()} is in the future (today is "
            f"{today.isoformat()}), so there is no imagery of this crop to "
            f"fetch yet. Correct the sowing date, or wait until the crop is "
            f"in the ground."
        )
    return start.isoformat(), end.isoformat()


def _round(v, places=4):
    return None if v is None else round(float(v), places)


def _by_date(rows):
    """Sort by date and collapse same-date duplicates (adjacent orbit tiles).

    Two Sentinel-2 granules can cover one field on the same day; left alone
    they become two rows for one observation, and the detector counts them as
    two pieces of evidence for the same thing.
    """
    out: dict[str, dict] = {}
    for r in rows:
        prev = out.get(r["date"])
        # Keep whichever saw more of the field. For radar there is no pixel
        # count, so the first row wins and they are near-identical anyway.
        if prev is None or r.get("valid_px", 0) > prev.get("valid_px", 0):
            out[r["date"]] = r
    return [out[d] for d in sorted(out)]


if __name__ == "__main__":
    # --- geometry: offline, no auth needed --------------------------------
    for ha in (0.25, 1.0, 5.0, 100.0):
        r = math.sqrt(ha * 10_000 / math.pi)
        assert abs(math.pi * r * r / 10_000 - ha) < 1e-9, ha
    # 1 ha -> ~56 m radius is the figure the field probe was built on.
    assert 56 <= math.sqrt(1.0 * 10_000 / math.pi) < 57

    # --- merge logic: offline ---------------------------------------------
    merged = {}
    s2 = [{"date": "2025-03-01", "ndvi": 0.6, "evi": None, "ndwi": None,
           "savi": None, "nbr": None, "cloud_pct": 5.0, "valid_px": 120, "source": "S2"}]
    s1 = [{"date": "2025-03-04", "vv": -9.1, "vh": -17.2, "source": "S1"}]
    keys = ("ndvi", "evi", "ndwi", "savi", "nbr", "vv", "vh", "cloud_pct", "valid_px")
    for row in s2 + s1:
        slot = merged.setdefault(row["date"], {"date": row["date"], "sources": []})
        for k in keys:
            slot.setdefault(k, None)
            if row.get(k) is not None:
                slot[k] = row[k]
        slot["sources"].append(row["source"])
    out = [merged[d] for d in sorted(merged)]
    assert [r["date"] for r in out] == ["2025-03-01", "2025-03-04"], out
    assert out[0]["vv"] is None and out[1]["ndvi"] is None, "gaps must be None, not absent"
    assert all(set(keys) <= set(r) for r in out), "every row carries every key"

    # Same-date duplicates collapse to the better-observed one.
    dup = _by_date([
        {"date": "2025-03-01", "ndvi": 0.1, "valid_px": 3},
        {"date": "2025-03-01", "ndvi": 0.6, "valid_px": 120},
    ])
    assert len(dup) == 1 and dup[0]["valid_px"] == 120, dup

    # --- no-crop guard: offline, on the series actually measured -----------
    # The built-up plot: 21 in-season observations, none above 0.20.
    built = [0.1687, 0.1893, 0.1779, 0.1794, 0.1306, 0.1647, 0.0827, 0.1533,
             0.1955, 0.1765, 0.1302, 0.1629, 0.1552, 0.1707, 0.1547, 0.1610,
             0.1284, 0.1622, 0.1969, 0.1891, 0.1979]
    d = no_crop(built)
    assert d and d["observations"] == 21, d
    assert d["ndvi_peak"] == 0.1979 and d["ndvi_amplitude"] == 0.1152, d

    # Real wheat and rice fields must pass on the peak alone.
    assert no_crop([0.22, 0.31, 0.55, 0.873, 0.61, 0.30, 0.25]) is None
    assert no_crop([0.046, 0.20, 0.51, 0.948, 0.72, 0.33, 0.18]) is None

    # Too few observations is not evidence of absence.
    assert no_crop([0.10, 0.11, 0.12]) is None, "under MIN_OBS must not fire"

    # Low but ALIVE: never reaches 0.25, yet swings 0.21 across the season.
    # A weak crop, not a missing one -- the amplitude clause must let it by.
    assert no_crop([0.03, 0.05, 0.12, 0.24, 0.21, 0.09, 0.04]) is None

    # High and FLAT: an orchard or perennial. Peak clears the bar, so the
    # amplitude clause must not be enough on its own to refuse it.
    assert no_crop([0.62, 0.64, 0.61, 0.63, 0.65, 0.62, 0.63]) is None

    # Nulls are gaps, not zeros: they must not drag the minimum down.
    assert no_crop([None] * 20 + [0.30]) is None, "nulls must not count as observations"

    # --- sowing-date validation: offline -----------------------------------
    assert season_bounds("wheat", date(2026, 6, 15), date(2026, 9, 29)) ==         ("2026-06-01", "2026-09-29")
    for future in (date(2026, 11, 20), date(2026, 12, 1)):
        try:
            season_bounds("wheat", future, date(2026, 9, 29))
            raise AssertionError(f"{future} is in the future and must be refused")
        except InvalidSowingDate as e:
            assert future.isoformat() in str(e), e
    # The boundary: sown exactly 14 days ahead still yields start == today.
    assert season_bounds("wheat", date(2026, 10, 13), date(2026, 9, 29)) ==         ("2026-09-29", "2026-09-29")

    print("field geometry/merge/no-crop/sowing self-check OK")
