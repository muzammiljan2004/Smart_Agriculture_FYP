"""Districts, crops, and the season windows that pair them.

Single source of truth: the migration's CHECK constraints, the GEE scripts and
the frontend dropdowns all have to agree with this file, or a farm gets written
that no script can ever fetch imagery for.
"""

# (lng_min, lat_min, lng_max, lat_max) -- GEE takes longitude FIRST.
#
# Verified in the GEE Code Editor before being locked in here, with the
# rabi-window NDVI and scene count each box actually returns:
#   Sheikhupura  NDVI 0.620  (87 images)
#   Okara        NDVI 0.502  (46 images)
#   Sahiwal      NDVI 0.514  (37 images)
#
# All three are 0.35 lng x 0.30 lat. Equal footprints matter more than exact
# district borders: if one box were larger it would average over more
# non-cropland, and the district-to-district differences the model learns
# would partly be an artifact of box size rather than real agronomy.
DISTRICTS = {
    "Sheikhupura": (73.80, 31.55, 74.15, 31.85),
    "Okara":       (73.30, 30.65, 73.65, 30.95),
    "Sahiwal":     (73.00, 30.50, 73.35, 30.80),
}

# Span every box must have, so a future edit cannot quietly break comparability.
BBOX_SPAN = (0.35, 0.30)

# Crops moved out to app/crops.py, which loads them from data/crops*.csv --
# adding a crop is a CSV row now, not an edit here. Re-exported so the scripts
# and the API that already import these names from this module keep working.
from app.crops import (  # noqa: E402,F401
    ALL_CROPS,
    CROP_SEASON,
    CROPS,
    FEATURE_NAMES,
    INDEX_FEATURES,
    SEASON_WINDOWS,
    one_hot,
    season_window,
)


if __name__ == "__main__":
    # Crop behaviour is checked in app/crops.py; this file only owns geometry.
    for name, (lng0, lat0, lng1, lat1) in DISTRICTS.items():
        assert lng0 < lng1 and lat0 < lat1, f"{name}: bbox corners are swapped"
        assert abs((lng1 - lng0) - BBOX_SPAN[0]) < 1e-9 and abs((lat1 - lat0) - BBOX_SPAN[1]) < 1e-9, \
            f"{name}: every box must be {BBOX_SPAN[0]} x {BBOX_SPAN[1]} for comparability"
        assert 72 < lng0 < 75 and 30 < lat0 < 33, f"{name}: bbox is not in Punjab"
    print("districts self-check OK")
