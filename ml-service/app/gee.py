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

# COPERNICUS/S2_SR_HARMONIZED (Level-2A surface reflectance) starts here.
# Any rabi window ending before this date has no imagery at all -- that is why
# seasons before 2017-18 cannot be built from this collection.
S2_SR_START = "2017-03-28"

GAUL_L2 = "FAO/GAUL/2015/level2"


class NoImagery(RuntimeError):
    """Zero scenes for a region+window. A data gap, not a bug -- callers skip."""


class DistrictNotFound(KeyError):
    """A district name did not resolve against GAUL. Almost always a naming
    mismatch, which must surface loudly rather than silently yielding an empty
    geometry that reduces to null indices."""


@lru_cache(maxsize=1)
def gaul_district_names() -> tuple:
    """Every ADM2 (district) name GAUL has for Pakistan."""
    init()
    fc = ee.FeatureCollection(GAUL_L2).filter(ee.Filter.eq("ADM0_NAME", "Pakistan"))
    return tuple(sorted(set(fc.aggregate_array("ADM2_NAME").getInfo())))


def norm_district(s: str) -> str:
    """Comparison key for a district name.

    Lowercases, drops punctuation and spacing, and strips a trailing
    "district". GAUL 2015 suffixes every Pakistani ADM2 name ("Bahawalnagar
    District") while the PBS sources do not ("Bahawalnagar"), so without the
    suffix strip nothing matches at all. Applied to BOTH sides, so it is
    symmetric and a source name that happens to include "District" also works.
    """
    s = "".join(ch for ch in str(s).lower() if ch.isalnum())
    return s[: -len("district")] if s.endswith("district") and len(s) > len("district") else s


@lru_cache(maxsize=1)
def gaul_lookup() -> dict:
    """normalised name -> the exact ADM2_NAME string GAUL wants for filtering."""
    return {norm_district(n): n for n in gaul_district_names()}


@lru_cache(maxsize=256)
def get_district_geometry(standardized_name: str):
    """GAUL ADM2 geometry for a Pakistani district, by standardized name.

    Raises DistrictNotFound with close matches rather than returning an empty
    FeatureCollection. An empty geometry does not error in Earth Engine -- it
    reduces to null indices, which would land in the training CSV as a blank
    row and look like cloud cover instead of a spelling mismatch.
    """
    init()

    lookup = gaul_lookup()
    key = norm_district(standardized_name)

    if key not in lookup:
        # Suggest against SUFFIX-STRIPPED names. Comparing raw GAUL names here
        # was itself misleading: " District" adds 9 characters, so a short name
        # like "Attock" vs "Attock District" scores 0.57 and falls below the
        # 0.6 cutoff -- reporting "Closest: none" for names that differ only by
        # the suffix.
        import difflib
        stripped = sorted(lookup)
        close = difflib.get_close_matches(key, stripped, n=4, cutoff=0.6)
        raise DistrictNotFound(
            f"{standardized_name!r} is not a GAUL ADM2 name for Pakistan "
            f"(GAUL has {len(lookup)} districts). "
            f"Closest, suffix-stripped: {[lookup[c] for c in close] or 'none'}. "
            f"If nothing is close, the district may post-date the GAUL 2015 "
            f"vintage and need its pre-split parent instead."
        )

    fc = (
        ee.FeatureCollection(GAUL_L2)
        .filter(ee.Filter.eq("ADM0_NAME", "Pakistan"))
        .filter(ee.Filter.eq("ADM2_NAME", lookup[key]))
    )
    return fc.geometry()


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


def fetch_indices(bbox=SHEIKHUPURA_BBOX, start="2025-01-01", end="2025-03-31", scale=20,
                  geometry=None):
    """Mean NDVI/EVI/NDWI/SAVI/NBR over a region for the date window.

    `geometry` (an ee.Geometry, e.g. from get_district_geometry) takes priority
    over `bbox`. The index computation below is untouched by this addition --
    only the shape being reduced over changes.

    Returns {"date": "YYYY-MM-DD", "ndvi": float, ..., "n_images": int};
    `date` is the most recent scene contributing to the composite.
    """
    init()
    region = geometry if geometry is not None else ee.Geometry.Rectangle(list(bbox))

    col = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
        .map(_mask_clouds)
    )

    n_images = col.size().getInfo()
    if n_images == 0:
        raise NoImagery(
            f"no Sentinel-2 scenes in {start}..{end} under 20% cloud. "
            "Punjab's winter fog makes Dec-Jan sparse, and S2_SR_HARMONIZED "
            f"itself only begins {S2_SR_START}."
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
    result = {
        "date": datetime.fromtimestamp(ts / 1000, timezone.utc).date().isoformat(),
        "n_images": n_images,
    }
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
