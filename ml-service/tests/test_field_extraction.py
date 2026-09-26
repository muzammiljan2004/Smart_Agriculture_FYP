"""Live check that field-level extraction works end to end.

    python -m tests.test_field_extraction

NEEDS GEE AUTH AND NETWORK. Unlike the other tests here, this one really
calls Earth Engine -- that is the point, because everything it is guarding
against (a renamed band, an expired credential, a collection that returns
empty over Pakistan) is invisible offline.

It reduces over ONE 1-hectare test field for ONE season. No Punjab-wide
fetch: this is a smoke test, and the district pipeline is what does volume.

The coordinate is a pixel Dynamic World classifies as cropland in
Sheikhupura, chosen by sampling rather than by eye -- an earlier hand-picked
point turned out to be built-up and read NDVI 0.11, which looked exactly like
a broken index computation.
"""
import time
from datetime import date

from app.field import (MIN_SENSIBLE_HA, field_geometry, field_series,
                       season_bounds, sentinel1_series, sentinel2_series)
from app.gee import (GEE_TIMEOUT_SECONDS, NoImagery, _call_with_deadline,
                     with_retry)

FIELD = {"lat": 31.47921334375833, "lng": 74.15188428528796, "area_hectares": 1.0}
START, END = "2024-11-01", "2025-05-15"      # rabi 2024-25, wheat


def check_1_connection_and_geometry():
    """GEE answers, and the geometry really is the requested area."""
    g = field_geometry(**FIELD)
    area = g.area(maxError=1).getInfo()
    assert abs(area - 10_000) / 10_000 < 0.02, f"1 ha circle measured {area:.0f} m2"
    assert MIN_SENSIBLE_HA < 1.0


def check_2_sentinel2_returns_observations():
    rows = sentinel2_series(FIELD["lat"], FIELD["lng"], FIELD["area_hectares"],
                            START, END)
    assert len(rows) >= 20, f"only {len(rows)} S2 observations in a whole rabi season"
    globals()["_S2"] = rows


def check_3_indices_are_non_null_and_plausible():
    rows = globals()["_S2"]
    for k in ("ndvi", "evi", "ndwi", "savi", "nbr"):
        vals = [r[k] for r in rows if r[k] is not None]
        assert len(vals) >= len(rows) * 0.8, f"{k} null in over 20% of rows"
        assert all(-1.01 <= v <= 1.01 for v in vals), f"{k} out of range: {vals[:3]}"

    ndvi = [r["ndvi"] for r in rows if r["ndvi"] is not None]
    # Cropland over a season must both green up and come back down. A field
    # that never moves is a parking lot, or the reduction is hitting the wrong
    # place -- which is the failure this test exists to catch.
    assert max(ndvi) > 0.45, f"peak NDVI {max(ndvi):.3f} is too low for cropland"
    assert max(ndvi) - min(ndvi) > 0.25, "NDVI barely moves across the season"

    # Gao's NDWI, not McFeeters'. McFeeters reads about -0.5 over any crop.
    ndwi = [r["ndwi"] for r in rows if r["ndwi"] is not None]
    assert max(ndwi) > 0, "NDWI never positive -> this is McFeeters, not Gao"

    assert all(r["valid_px"] > 0 for r in rows), "a row survived with zero pixels"


def check_4_sentinel1_returns_observations():
    rows = sentinel1_series(FIELD["lat"], FIELD["lng"], FIELD["area_hectares"],
                            START, END)
    assert len(rows) >= 10, f"only {len(rows)} S1 observations over six months"
    vv = [r["vv"] for r in rows if r["vv"] is not None]
    vh = [r["vh"] for r in rows if r["vh"] is not None]
    assert vv and vh, "S1 returned rows with neither polarisation"
    # Backscatter over land sits well inside this; anything outside means the
    # values are linear power rather than the dB the detector's threshold assumes.
    assert all(-40 < v < 10 for v in vv + vh), f"dB out of range: {(vv + vh)[:4]}"
    globals()["_S1"] = rows


def check_5_series_is_ordered_and_merged():
    rows = field_series(FIELD["lat"], FIELD["lng"], FIELD["area_hectares"], START, END)
    dates = [r["date"] for r in rows]
    assert dates == sorted(dates), "series is not ordered by date"
    assert len(dates) == len(set(dates)), "duplicate dates in the merged series"

    keys = {"ndvi", "evi", "ndwi", "savi", "nbr", "vv", "vh", "cloud_pct", "valid_px"}
    assert all(keys <= set(r) for r in rows), "a row is missing keys"
    assert any(r["ndvi"] is not None for r in rows)
    assert any(r["vh"] is not None for r in rows), "radar missing from merged series"
    globals()["_MERGED"] = rows


def check_6_empty_and_cloudy_periods_do_not_crash():
    """A window with no imagery must raise NoImagery, not return garbage."""
    # Before Sentinel-2 existed. The collection is genuinely empty here, which
    # is the same shape as a fully-clouded window and must behave the same.
    try:
        field_series(FIELD["lat"], FIELD["lng"], 1.0, "2015-01-01", "2015-02-01")
    except NoImagery:
        pass
    else:
        raise AssertionError("an empty window must raise NoImagery")

    # A single cloudy week returns few or no rows, and that is not an error --
    # the caller gets a short list and the detector reports insufficient_data.
    rows = sentinel2_series(FIELD["lat"], FIELD["lng"], 1.0, "2025-01-05", "2025-01-12")
    assert isinstance(rows, list), rows

    # A tiny field is still answerable, just poorly observed. It must not throw.
    tiny = sentinel2_series(FIELD["lat"], FIELD["lng"], 0.05, "2025-03-01", "2025-03-31")
    assert isinstance(tiny, list)


def check_7_retry_and_deadline_are_wired():
    """The extraction must go through app.gee's deadline, not raw getInfo."""
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 2:
            raise ConnectionError("simulated dead socket")
        return "ok"

    assert with_retry(flaky, what="field self-check") == "ok"
    assert len(calls) == 2, calls

    # A short explicit deadline, not GEE_TIMEOUT_SECONDS. Exercising the real
    # 300s value costs five minutes of wall clock to prove a mechanism that a
    # 2s deadline proves identically -- and a smoke test nobody runs because
    # it is slow guards nothing.
    t = time.time()
    try:
        _call_with_deadline(lambda: time.sleep(60), seconds=2)
    except TimeoutError:
        pass
    else:
        raise AssertionError("a blocking call must not outlive its deadline")
    assert time.time() - t < 10, "deadline did not fire promptly"
    assert GEE_TIMEOUT_SECONDS >= 60, "the real deadline must still be generous"

    import inspect
    from app import field
    src = inspect.getsource(field)
    assert src.count("with_retry(") >= 2, \
        "a getInfo bypassed with_retry -- that is how the district fetch hung twice"


def check_8_season_bounds_never_ask_for_the_future():
    a, b = season_bounds("wheat", date(2024, 11, 15), today=date(2025, 2, 1))
    assert a == "2024-11-01", a          # 14 days before sowing
    assert b == "2025-02-01", b          # capped at today, not sowing+195
    a, b = season_bounds("wheat", date(2024, 11, 15), today=date(2026, 1, 1))
    assert b == "2025-05-29", b          # 15 Nov + 150 duration + 45 grace


if __name__ == "__main__":
    checks = [v for k, v in sorted(globals().items()) if k.startswith("check_")]
    t0 = time.time()
    for fn in checks:
        t = time.time()
        fn()
        print(f"  OK  {fn.__name__}  ({time.time() - t:.1f}s)")
    print(f"\nfield-extraction self-check OK ({len(checks)} checks, "
          f"{time.time() - t0:.0f}s total)")
