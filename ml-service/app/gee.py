"""Sentinel-2 vegetation indices from Google Earth Engine.

Auth (one-time, per machine):  earthengine authenticate
"""
import os
from datetime import datetime, timezone
from functools import lru_cache

import ee
from dotenv import load_dotenv

from app.districts import DISTRICTS

load_dotenv()

# Bounding boxes now live in app/districts.py so the scripts, the migration
# and the frontend cannot drift apart. GEE takes lng first; getting that
# backwards silently samples Central Asia rather than erroring.
SHEIKHUPURA_BBOX = DISTRICTS["Sheikhupura"]

# Scene Classification Layer classes worth keeping. 4=vegetation, 5=bare soil,
# 6=water, 7=unclassified. Dropped: 3=cloud shadow, 8/9=cloud medium+high
# probability, 10=cirrus, 11=snow.
_SCL_KEEP = [4, 5, 6, 7]


@lru_cache(maxsize=1)
def init():
    ee.Initialize(project=os.environ["GEE_PROJECT"])


def _mask_clouds(img):
    """Per-pixel cloud mask.

    CLOUDY_PIXEL_PERCENTAGE < 20 is a SCENE-level filter: it only says the tile
    is mostly clear. The remaining 19% of cloud can sit directly over
    Sheikhupura, and a cloud reflects high in red -> NDVI collapses toward 0 ->
    the model reports a crop failure that never happened. So we mask per pixel
    as well, and the median composite below fills the holes from other dates.
    """
    scl = img.select("SCL")
    keep = scl.eq(_SCL_KEEP[0])
    for c in _SCL_KEEP[1:]:
        keep = keep.Or(scl.eq(c))
    return img.updateMask(keep)


def fetch_indices(bbox=SHEIKHUPURA_BBOX, start="2025-01-01", end="2025-03-31", scale=20):
    """Mean NDVI/EVI/NDWI/SAVI/NBR over `bbox` for the date window.

    Returns {"date": "YYYY-MM-DD", "ndvi": float, ...}; `date` is the most
    recent scene contributing to the composite.
    """
    init()
    region = ee.Geometry.Rectangle(list(bbox))

    col = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
        .map(_mask_clouds)
    )

    if col.size().getInfo() == 0:
        raise RuntimeError(
            f"no Sentinel-2 scenes for {bbox} in {start}..{end} under 20% cloud. "
            "Widen the date range -- Punjab's winter fog makes Dec-Jan sparse."
        )

    # Median over the window, not a single scene: it throws out whatever haze
    # survived the mask, and every pixel ends up with a value even where one
    # date was masked out.
    #
    # /10000 converts Sentinel-2's packed integers to true 0-1 reflectance.
    # NDVI and NBR are ratios and wouldn't care, but EVI and SAVI have bare
    # constants (+1, +0.5) that only make sense against 0-1 values -- feeding
    # them raw DNs returns numbers near zero that look plausible and are wrong.
    img = col.median().divide(10000)

    b2, b4, b8, b11, b12 = (img.select(b) for b in ("B2", "B4", "B8", "B11", "B12"))

    ndvi = b8.subtract(b4).divide(b8.add(b4))
    savi = b8.subtract(b4).multiply(1.5).divide(b8.add(b4).add(0.5))
    nbr = b8.subtract(b12).divide(b8.add(b12))
    evi = (
        b8.subtract(b4)
        .multiply(2.5)
        .divide(b8.add(b4.multiply(6)).subtract(b2.multiply(7.5)).add(1))
    )
    # Gao's NDWI (NIR vs SWIR) = canopy water content, positive (~0.1-0.4) over
    # healthy wheat. NOT McFeeters' (B3 vs B8), which detects open water and
    # reads about -0.5 over any crop -- that is the version most tutorials show,
    # and it would feed the model a value far outside anything it trained on.
    ndwi = b8.subtract(b11).divide(b8.add(b11))

    stack = ee.Image.cat([ndvi, evi, ndwi, savi, nbr]).rename(
        ["ndvi", "evi", "ndwi", "savi", "nbr"]
    )

    stats = stack.reduceRegion(
        reducer=ee.Reducer.mean(),
        geometry=region,
        scale=scale,        # 20m: B11/B12 are native 20m, so finer just resamples
        maxPixels=int(1e9),
        bestEffort=True,
    )

    # One getInfo round trip for the values and the scene date together.
    out = stats.set("t", col.aggregate_max("system:time_start")).getInfo()

    ts = out.pop("t")
    result = {"date": datetime.fromtimestamp(ts / 1000, timezone.utc).date().isoformat()}
    for k in ("ndvi", "evi", "ndwi", "savi", "nbr"):
        v = out.get(k)
        result[k] = None if v is None else round(v, 4)
    return result


if __name__ == "__main__":
    # Self-check: needs GEE auth. Rabi wheat, peak vegetative growth.
    r = fetch_indices(start="2025-01-15", end="2025-03-15")
    print(r)
    assert r["ndvi"] is not None, "NDVI came back empty -- region or dates are wrong"
    assert 0.1 < r["ndvi"] < 0.95, f"NDVI {r['ndvi']} implausible over cropland"
    assert r["ndwi"] > -0.2, "NDWI negative -> you are computing McFeeters, not Gao"
    print("self-check OK")
