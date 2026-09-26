"""The inference row must match the trained model's schema, column for column.

    python -m tests.test_inference_vector

No pytest, no network, no database -- matching the other tests here and
runnable while a fetch is going.

This is the one place where a silent failure is genuinely expensive. A forest
handed the right NUMBER of features in the wrong ORDER does not raise: it
returns a confident wrong yield and nothing downstream can tell. So these
checks verify the assembled vector POSITIONALLY against the bundle's declared
feature_names, not merely its length.
"""
from datetime import date

from fastapi import HTTPException

from app import main as m
from app.crops import CROPS, INDEX_FEATURES

IDX = {"ndvi": 0.61, "evi": 0.44, "ndwi": 0.28, "savi": 0.39, "nbr": 0.47}
SOIL = {"ph": 7.74, "clay_pct": 24.9, "silt_pct": 42.2, "sand_pct": 32.9,
        "bulk_dens": 1.42, "water_33k": 22.9}
WX = {"tmax_mean_c": 24.1, "tmin_mean_c": 9.8, "tmax_peak_c": 38.2,
      "rain_mm": 121.0, "frost_days": 2, "hot_days_35c": 11}

BASE = list(INDEX_FEATURES) + [f"crop_{c}" for c in CROPS]

# _bundle is loaded lazily on startup, so it is None at import time. These
# checks never call the model itself, only the vector assembly around it, so a
# stub schema is enough and model.pkl is left alone.
_real_bundle = m._bundle or {"trained_crops": list(CROPS), "feature_names": BASE}
_real_profile = m.land_profile_for


def use_schema(names):
    m._bundle = {**_real_bundle, "feature_names": names}


def restore():
    m._bundle = _real_bundle
    m.land_profile_for = _real_profile


def feats(crop="wheat"):
    return m.Features(crop_type=crop, **IDX)


def farm():
    return {"id": "x", "crop_type": "wheat", "gps_lat": 31.70, "gps_lng": 73.98}


def check_base_layout():
    use_schema(BASE)
    row = m.build_vector(feats("wheat"))
    assert len(row) == len(BASE), row
    for i, n in enumerate(BASE[:5]):
        assert row[i] == IDX[n], f"{n} in wrong column"
    assert row[BASE.index("crop_wheat")] == 1
    assert sum(row[5:]) == 1, "exactly one crop column may be hot"


def check_wide_layout():
    names = BASE + list(SOIL) + list(WX)
    use_schema(names)
    row = m.build_vector(feats("wheat"), extra={**SOIL, **WX})
    # len(names), not a literal. This asserted 19 and broke the moment CROPS
    # went from 2 crops to 11 -- failing for the wrong reason, because the
    # width changed legitimately and nothing was actually wrong. The invariant
    # is that the row matches the DECLARED schema, whatever its width.
    assert len(row) == len(names), (len(row), len(names))
    for n, v in {**IDX, **SOIL, **WX}.items():
        assert row[names.index(n)] == v, f"{n} in wrong column"


def check_order_follows_the_schema():
    """Reorder the declared schema and the row must reorder with it."""
    names = BASE + list(WX) + list(SOIL)          # weather BEFORE soil
    use_schema(names)
    row = m.build_vector(feats("wheat"), extra={**SOIL, **WX})
    assert names.index("tmax_mean_c") < names.index("ph")
    assert row[names.index("tmax_mean_c")] == WX["tmax_mean_c"]
    assert row[names.index("ph")] == SOIL["ph"]


def check_missing_refuses():
    """A zero for ph is not a neutral value, it is an impossible soil."""
    use_schema(BASE + list(SOIL))
    try:
        m.build_vector(feats("wheat"), extra={})
    except HTTPException as e:
        assert e.status_code == 503 and "ph" in e.detail, e.detail
    else:
        raise AssertionError("missing soil must refuse, not default to 0")


def check_none_is_missing():
    """A null from the land profile must not become 0.0 in the vector."""
    use_schema(BASE + list(SOIL))
    try:
        m.build_vector(feats("wheat"), extra={**SOIL, "ph": None})
    except HTTPException:
        pass
    else:
        raise AssertionError("None must be treated as missing, not cast")


def check_base_model_fetches_nothing():
    """No soil lookup and no Open-Meteo round trip per base-model prediction."""
    use_schema(BASE)

    def boom(*a, **k):
        raise AssertionError("base model must not fetch soil or weather")

    m.land_profile_for = boom
    try:
        assert m.model_extras(farm()) == {}
    finally:
        m.land_profile_for = _real_profile


def check_extras_never_raise():
    """A soil outage must not take down a prediction the indices could serve."""
    use_schema(BASE + list(SOIL))

    def gone(_row):
        raise LookupError("no coverage")

    m.land_profile_for = gone
    try:
        out = m.model_extras(farm())
        assert "ph" not in out, "absent, never zero"
    finally:
        m.land_profile_for = _real_profile


def check_season_anchoring():
    # Rabi wheat sown Nov 2025 stays in 2025-26 through the 2026 months it
    # actually grows in; anchoring to January would relabel it mid-season.
    assert m.current_season("wheat", date(2025, 11, 20)) == "2025-26"
    assert m.current_season("wheat", date(2026, 3, 10)) == "2025-26"
    # Kharif rice sown in June belongs to the year it was sown.
    assert m.current_season("rice", date(2026, 7, 5)) == "2026-27"


if __name__ == "__main__":
    checks = [v for k, v in sorted(globals().items()) if k.startswith("check_")]
    try:
        for fn in checks:
            fn()
            print(f"  OK  {fn.__name__}")
    finally:
        restore()
    print(f"\ninference-vector self-check OK ({len(checks)} checks)")
