"""Scenario tests for lifecycle stages 3 (growth), 6 (fallow) and 7 (emergence).

    python -m tests.test_lifecycle

No pytest, no network, no database.

EVERY CURVE IS SYNTHETIC. These test what the algorithm does with shapes we
constructed. They are not validation and they measure no accuracy: no field
state produced by this module has ever been checked against someone standing
in the field.
"""
from datetime import date, timedelta

from app.lifecycle import (EMERGENCE_NDVI, FALLOW_NDVI, PHASES, field_state,
                           observed_phase)
from app.harvest import _smooth, _usable, find_cycles

SOWN = date(2024, 11, 15)
GROW = [0.21, 0.25, 0.29, 0.34, 0.40, 0.47, 0.54, 0.60, 0.64, 0.66]
FALL = [0.52, 0.22, 0.17, 0.15, 0.14]
REGROW = [0.19, 0.33, 0.42, 0.55]


def rows(start, vals, step=13, valid_px=120):
    d0 = date.fromisoformat(start)
    return [{"date": (d0 + timedelta(days=i * step)).isoformat(), "ndvi": v,
             "valid_px": valid_px, "vh": None} for i, v in enumerate(vals)]


def phase_of(series):
    u = _usable(series)
    return observed_phase(_smooth(u), find_cycles(u))[0]


# ----------------------------------------------------------------- stage 3

def check_3a_rising_canopy_is_growing():
    s = field_state(rows("2024-11-20", GROW), "wheat", SOWN, today=date(2025, 3, 1))
    assert s["observed_phase"] in ("vegetative", "peak"), s["observed_phase"]
    assert s["ndvi_trend_per_month"] > 0
    assert s["current_ndvi"] is not None


def check_3b_calendar_still_names_the_stage():
    """NDVI cannot say 'Jointing'. The calendar must keep doing that."""
    s = field_state(rows("2024-11-20", GROW), "wheat", SOWN, today=date(2025, 3, 1))
    assert isinstance(s["calendar_stage"], str) and s["calendar_stage"]
    # The coarse observed phase is a DIFFERENT field, not a replacement name.
    assert s["observed_phase"] in PHASES
    assert s["calendar_phase"] in PHASES


def check_3c_agreement_when_dates_are_right():
    s = field_state(rows("2024-11-20", GROW), "wheat", SOWN, today=date(2025, 3, 1))
    assert s["agreement"] == "consistent", (s["agreement"], s["agreement_note"])


def check_3d_disagreement_is_surfaced():
    """A green field under a calendar that says the season ended.

    This is the ce990651 failure mode seen from the other side: the sowing
    date is wrong, and the curve is what reveals it.
    """
    s = field_state(rows("2024-11-20", GROW), "wheat", date(2024, 7, 1),
                    today=date(2025, 3, 1))
    assert s["calendar_phase"] == "cleared"
    assert s["agreement"] == "behind_calendar", s["agreement"]
    assert "sown after the recorded date" in s["agreement_note"]


def check_3e_phase_is_calendar_free():
    """Observed phase must not move when only the sowing date changes."""
    s = rows("2024-11-20", GROW)
    a = field_state(s, "wheat", SOWN, today=date(2025, 3, 1))
    b = field_state(s, "wheat", date(2024, 7, 1), today=date(2025, 3, 1))
    assert a["observed_phase"] == b["observed_phase"], \
        (a["observed_phase"], b["observed_phase"])
    assert a["current_ndvi"] == b["current_ndvi"]


# ----------------------------------------------------------------- stage 6

def check_6a_cleared_field_is_fallow():
    s = field_state(rows("2024-11-20", GROW + FALL), "wheat", SOWN,
                    today=date(2025, 6, 20))
    assert s["observed_phase"] == "cleared", s["observed_phase"]
    assert s["fallow"]["is_fallow"] is True
    assert s["fallow"]["fallow_since"] is not None
    assert s["fallow"]["fallow_days"] > 0
    assert s["fallow"]["ready_for_next_crop"] is True


def check_6b_standing_crop_is_not_fallow():
    s = field_state(rows("2024-11-20", GROW), "wheat", SOWN, today=date(2025, 3, 1))
    assert s["fallow"]["is_fallow"] is False, s["fallow"]
    assert s["fallow"]["fallow_days"] is None


def check_6c_fallow_duration_grows_with_time():
    s = rows("2024-11-20", GROW + FALL)
    early = field_state(s, "wheat", SOWN, today=date(2025, 6, 1))
    late = field_state(s, "wheat", SOWN, today=date(2025, 8, 1))
    assert late["fallow"]["fallow_days"] > early["fallow"]["fallow_days"]
    assert late["fallow"]["fallow_since"] == early["fallow"]["fallow_since"]


# ----------------------------------------------------------------- stage 7

def check_7a_new_crop_detected():
    s = field_state(rows("2024-11-20", GROW + FALL + REGROW), "wheat", SOWN,
                    today=date(2025, 9, 1))
    assert s["emergence"]["detected"] is True, s["emergence"]
    assert s["emergence"]["emerged_on"] is not None
    assert s["emergence"]["days_since"] >= 0


def check_7b_emergence_ends_fallow():
    """The two states are mutually exclusive -- the loop has moved on."""
    s = field_state(rows("2024-11-20", GROW + FALL + REGROW), "wheat", SOWN,
                    today=date(2025, 9, 1))
    assert s["emergence"]["detected"] is True
    assert s["fallow"]["is_fallow"] is False, s["fallow"]


def check_7c_single_green_reading_is_not_a_crop():
    s = field_state(rows("2024-11-20", GROW + FALL + [0.15, 0.40, 0.14, 0.15]),
                    "wheat", SOWN, today=date(2025, 9, 1))
    assert s["emergence"]["detected"] is False, s["emergence"]
    assert s["fallow"]["is_fallow"] is True


def check_7d_first_crop_emerges_but_is_not_loop_reentry():
    """A first crop rising from bare soil IS an emergence, but not the loop.

    Only an emergence following a completed cycle means the loop has come
    back round, which is what `after_clearance` separates.
    """
    first = field_state(rows("2024-11-20", GROW), "wheat", SOWN,
                        today=date(2025, 3, 1))
    assert first["emergence"]["detected"] is True, first["emergence"]
    assert first["emergence"]["after_clearance"] is False, first["emergence"]

    reentry = field_state(rows("2024-11-20", GROW + FALL + REGROW), "wheat",
                          SOWN, today=date(2025, 9, 1))
    assert reentry["emergence"]["after_clearance"] is True, reentry["emergence"]


def check_7f_mid_season_series_reports_no_emergence():
    """A series that starts with the crop already up never went bare."""
    s = field_state(rows("2025-01-01", [0.45, 0.52, 0.58, 0.63, 0.66, 0.68]),
                    "wheat", SOWN, today=date(2025, 3, 20))
    assert s["emergence"]["detected"] is False, s["emergence"]


def check_7e_detected_before_find_cycles_would_see_it():
    """Emergence must fire while the new crop is still below MIN_PEAK_NDVI.

    find_cycles only returns a cycle once its peak clears 0.40. A field that
    has just come up sits well under that, so relying on find_cycles alone
    would report emergence weeks after it happened.
    """
    young = GROW + FALL + [0.18, 0.32, 0.35]        # never reaches 0.40
    u = _usable(rows("2024-11-20", young))
    second = [c for c in find_cycles(u)
              if c["peak_date"] > date(2025, 6, 1)]
    assert not second, "fixture must not contain a second full cycle"
    s = field_state(rows("2024-11-20", young), "wheat", SOWN, today=date(2025, 9, 1))
    assert s["emergence"]["detected"] is True, s["emergence"]


# ------------------------------------------------------------- regression

def check_r1_thin_data_refuses():
    s = field_state(rows("2025-01-01", [0.3, 0.4]), "wheat", SOWN,
                    today=date(2025, 3, 1))
    assert s["observed_phase"] is None
    assert s["agreement"] == "unknown"
    # The calendar never needed imagery, so it must still answer.
    assert s["calendar_stage"]


def check_r2_none_never_zero():
    """A missing NDVI must be dropped, never read as bare ground."""
    s = rows("2024-11-20", GROW)
    s.append({"date": "2025-02-01", "ndvi": None, "valid_px": 120, "vh": None})
    st = field_state(s, "wheat", SOWN, today=date(2025, 3, 1))
    assert st["observations"] == len(GROW), st["observations"]
    assert st["observed_phase"] == phase_of(rows("2024-11-20", GROW))


def check_r3_min_valid_px():
    s = rows("2024-11-20", GROW, valid_px=1)
    assert field_state(s, "wheat", SOWN, today=date(2025, 3, 1))["observed_phase"] is None


def check_r4_thresholds_have_hysteresis():
    """Emergence must sit above fallow, or a field flips state every revisit."""
    assert EMERGENCE_NDVI > FALLOW_NDVI, (EMERGENCE_NDVI, FALLOW_NDVI)


def check_r5_response_keys():
    s = field_state(rows("2024-11-20", GROW + FALL), "wheat", SOWN,
                    today=date(2025, 6, 20))
    for k in ("observed_phase", "observed_reason", "current_ndvi",
              "ndvi_trend_per_month", "calendar_stage", "calendar_phase",
              "agreement", "agreement_note", "fallow", "emergence",
              "observations", "cycle_count"):
        assert k in s, f"missing {k}"
    for k in ("is_fallow", "fallow_since", "fallow_days"):
        assert k in s["fallow"], f"fallow missing {k}"
    for k in ("detected", "emerged_on", "days_since", "after_clearance"):
        assert k in s["emergence"], f"emergence missing {k}"


if __name__ == "__main__":
    checks = [v for k, v in sorted(globals().items()) if k.startswith("check_")]
    for fn in checks:
        fn()
        print(f"  OK  {fn.__name__}")
    print(f"\nlifecycle self-check OK ({len(checks)} checks)")
