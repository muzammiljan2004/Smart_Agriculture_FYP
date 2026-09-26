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

    print("field geometry/merge self-check OK")
