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

# Order is load-bearing: it fixes the one-hot column order in the feature
# vector. Appending is safe; reordering silently invalidates a trained model.
CROPS = ("wheat", "rice")

CROP_SEASON = {"wheat": "rabi", "rice": "kharif"}


def season_window(crop, season):
    """Peak-vegetative date window for a crop-season, as (start, end) ISO dates.

    Rabi wheat  -- sown Nov, peak canopy Feb, harvested Apr. Season is labelled
                   across two years ("2024-25"); the window sits in the second.
    Kharif rice -- transplanted Jun/Jul, peak canopy Aug/Sep, harvested Oct.
                   Season is a single year ("2024").

    Sampling both crops in the same months would be the obvious mistake: a rice
    field in February is bare soil, so its NDVI would read as a failed wheat
    crop rather than as no crop at all.
    """
    if crop == "wheat":
        if "-" not in season:
            raise ValueError(f"rabi season must look like '2024-25', got {season!r}")
        y = int(season.split("-")[0]) + 1
        return f"{y}-01-15", f"{y}-03-15"

    if crop == "rice":
        if "-" in season:
            raise ValueError(f"kharif season must look like '2024', got {season!r}")
        y = int(season)
        return f"{y}-08-01", f"{y}-09-30"

    raise ValueError(f"unknown crop {crop!r}; expected one of {CROPS}")


def one_hot(crop):
    """Crop as fixed-width one-hot, ordered by CROPS."""
    if crop not in CROPS:
        raise ValueError(f"unknown crop {crop!r}; expected one of {CROPS}")
    return [1.0 if c == crop else 0.0 for c in CROPS]


# Column names the model sees, in order. Indices first, then the crop one-hot.
INDEX_FEATURES = ["ndvi", "evi", "ndwi", "savi", "nbr"]
FEATURE_NAMES = INDEX_FEATURES + [f"crop_{c}" for c in CROPS]


if __name__ == "__main__":
    assert season_window("wheat", "2024-25") == ("2025-01-15", "2025-03-15")
    assert season_window("rice", "2024") == ("2024-08-01", "2024-09-30")
    assert one_hot("wheat") == [1.0, 0.0] and one_hot("rice") == [0.0, 1.0]
    for name, (lng0, lat0, lng1, lat1) in DISTRICTS.items():
        assert lng0 < lng1 and lat0 < lat1, f"{name}: bbox corners are swapped"
        assert abs((lng1 - lng0) - BBOX_SPAN[0]) < 1e-9 and abs((lat1 - lat0) - BBOX_SPAN[1]) < 1e-9, \
            f"{name}: every box must be {BBOX_SPAN[0]} x {BBOX_SPAN[1]} for comparability"
        assert 72 < lng0 < 75 and 30 < lat0 < 33, f"{name}: bbox is not in Punjab"
    print("districts self-check OK")
