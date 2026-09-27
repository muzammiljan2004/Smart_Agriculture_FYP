"""Scenario tests for observation-driven cycle detection.

    python -m tests.test_harvest_cycles

No pytest, no network, no database -- matching the other tests here.

EVERY CURVE BELOW IS SYNTHETIC. These test the ALGORITHM's behaviour on
shapes we constructed. They are not validation, they measure no accuracy,
and passing them says nothing about whether the detector finds real
harvests. That needs real harvest dates, which do not exist yet.

The scenarios are the ones the redesign was specified against:

  A  normal single crop            -> one candidate
  B  temporary dip then recovery   -> no candidate
  C  two crop cycles               -> two cycles discovered
  D  badly wrong planting date     -> cycle still discovered
  E  peak at the final observation -> no harvest date
  F  water-like decline            -> flagged, does not outrank a clean cycle
  G  two valid cycles + calendar   -> cycle 1 primary, cycle 2 still visible
"""
from datetime import date

from app.harvest import (MIN_VALID_PX, WATER_CONFIDENCE_CAP, detect,
                         find_cycles, _usable)

WHEAT_SOWN = date(2024, 11, 15)          # duration 150d -> expected 2025-04-14


def rows(points, radar=(), valid_px=120):
    """points: [(iso date, ndvi)]   radar: [(iso date, vh)]"""
    out = [{"date": d, "ndvi": n, "valid_px": valid_px, "vh": None}
           for d, n in points]
    out += [{"date": d, "ndvi": None, "valid_px": 0, "vh": v} for d, v in radar]
    return sorted(out, key=lambda r: r["date"])


def ramp(start_iso, vals, step=13):
    """Fortnightly samples, the cadence a real Sentinel-2 season produces."""
    from datetime import timedelta
    d0 = date.fromisoformat(start_iso)
    return [((d0 + timedelta(days=i * step)).isoformat(), v)
            for i, v in enumerate(vals)]


GROWTH = [0.21, 0.25, 0.29, 0.33, 0.39, 0.45, 0.51, 0.57, 0.60, 0.62]
FALL = [0.50, 0.21, 0.19, 0.18, 0.18]


def check_a_normal_single_crop():
    s = rows(ramp("2024-11-20", GROWTH + FALL))
    r = detect(s, "wheat", WHEAT_SOWN, today=date(2025, 7, 1))
    assert r["cycle_count"] == 1, r["cycle_count"]
    assert r["estimated_harvest_date"] is not None, r
    assert r["status"] in ("possible_harvest", "post_harvest"), r["status"]
    assert r["confidence"] > 0, r["confidence"]
    assert r["cycles"][0]["is_primary"] is True
    c = r["cycles"][0]
    assert c["onset_date"] and c["peak_date"] and c["decline_date"]
    assert c["amplitude"] >= 0.25, c["amplitude"]


def check_b_temporary_dip_recovers():
    """One sharp dip then recovery is weather, not a harvest."""
    s = rows(ramp("2024-11-20", GROWTH + [0.12, 0.60, 0.61, 0.62, 0.61]))
    r = detect(s, "wheat", WHEAT_SOWN, today=date(2025, 7, 1))
    assert r["estimated_harvest_date"] is None, r["estimated_harvest_date"]
    assert r["status"] not in ("possible_harvest", "post_harvest"), r["status"]
    assert r["confidence"] == 0.0, r["confidence"]


def check_c_two_crop_cycles():
    """cycle 1 -> decline -> regrowth -> cycle 2. Both must be discovered."""
    s = rows(ramp("2024-11-05",
                  [0.20, 0.45, 0.70, 0.82, 0.83, 0.55, 0.22, 0.18, 0.17,
                   0.30, 0.55, 0.75, 0.80, 0.81, 0.50, 0.20, 0.18]))
    cycles = find_cycles(_usable(s))
    assert len(cycles) == 2, [str(c["peak_date"]) for c in cycles]
    assert cycles[0]["peak_date"] < cycles[1]["peak_date"]
    assert all(c["transition"] is not None for c in cycles)
    r = detect(s, "wheat", WHEAT_SOWN, today=date(2026, 1, 1))
    assert r["cycle_count"] == 2, r["cycle_count"]
    # The EARLIER cycle must survive even though the later peak is comparable.
    assert len([c for c in r["cycles"] if c["estimated_transition_date"]]) == 2


def check_d_wrong_planting_date():
    """A planting date 120 days out must not hide a real cycle.

    This is the regression the whole redesign exists for. Under the previous
    calendar-gated peak selection, a wrong sowing date could move the cutoff
    so the real decline was never examined.
    """
    s = rows(ramp("2024-11-20", GROWTH + FALL))
    right = detect(s, "wheat", WHEAT_SOWN, today=date(2025, 7, 1))
    wrong = detect(s, "wheat", date(2024, 7, 18), today=date(2025, 7, 1))
    assert wrong["estimated_harvest_date"] == right["estimated_harvest_date"], \
        (wrong["estimated_harvest_date"], right["estimated_harvest_date"])
    assert wrong["cycle_count"] == right["cycle_count"] == 1
    # It is found, and the calendar disagreement is stated rather than hidden.
    assert any("further out than the crop calendar" in e for e in wrong["evidence"])
    # ...and it costs the proximity term, so the score is lower, not equal.
    assert wrong["confidence"] < right["confidence"], \
        (wrong["confidence"], right["confidence"])


def check_e_incomplete_peak_at_last_observation():
    s = rows(ramp("2025-06-25", [0.12, 0.15, 0.22, 0.38, 0.55, 0.70, 0.81]))
    r = detect(s, "rice", date(2025, 6, 25), today=date(2025, 9, 15))
    assert r["estimated_harvest_date"] is None, r["estimated_harvest_date"]
    assert r["status"] in ("growing", "approaching_maturity", "harvest_watch"), r["status"]
    assert r["confidence"] == 0.0
    # The open cycle is still reported -- absence of a transition, not of a crop.
    assert r["cycle_count"] == 1, r["cycle_count"]
    assert r["cycles"][0]["estimated_transition_date"] is None


def check_f_water_like_decline():
    """NDVI <= 0.05 with VH <= -25 dB near the break must be flagged and capped."""
    pts = ramp("2024-11-20", GROWTH + [0.50, 0.02, 0.01, 0.03, 0.04])
    wet_dates = [d for d, v in pts if v <= 0.05]
    radar = [(d, -30.0) for d in wet_dates]
    r = detect(rows(pts, radar=radar), "wheat", WHEAT_SOWN, today=date(2025, 7, 1))
    c = r["cycles"][0]
    assert c["water_signature"] is not None, c
    assert any("water-like" in e for e in r["evidence"]), r["evidence"]
    assert r["confidence"] <= WATER_CONFIDENCE_CAP, r["confidence"]
    # The wording must not assert a physical cause.
    joined = " ".join(r["evidence"])
    assert "water-like" in joined and "cause is not established" in joined


def check_f2_water_cycle_does_not_outrank_clean_one():
    """Given a clean candidate and a water-like one, the clean one leads."""
    # cycle 1 water-like decline, cycle 2 clean -- and the calendar sits
    # nearer the WATER cycle, so only the water rule can demote it.
    pts = ramp("2024-11-05",
               [0.20, 0.45, 0.70, 0.82, 0.83, 0.40, 0.02, 0.01, 0.03,
                0.30, 0.55, 0.75, 0.80, 0.81, 0.50, 0.20, 0.18])
    radar = [(d, -30.0) for d, v in pts if v <= 0.05]
    r = detect(rows(pts, radar=radar), "wheat", WHEAT_SOWN, today=date(2026, 1, 1))
    assert r["cycle_count"] == 2, r["cycle_count"]
    primary = r["cycles"][0]
    assert primary["is_primary"] is True
    assert primary["water_signature"] is None, "a water-like cycle outranked a clean one"
    # ...and the demoted one is still present, not deleted.
    assert any(c["water_signature"] is not None for c in r["cycles"])


def check_g_calendar_ranks_but_never_deletes():
    """Calendar near cycle 1 -> cycle 1 primary, cycle 2 still visible."""
    s = rows(ramp("2024-11-05",
                  [0.20, 0.45, 0.70, 0.82, 0.83, 0.55, 0.22, 0.18, 0.17,
                   0.30, 0.55, 0.75, 0.80, 0.81, 0.50, 0.20, 0.18]))
    cycles = find_cycles(_usable(s))
    t1, t2 = cycles[0]["transition"], cycles[1]["transition"]

    # Sow so the expected harvest lands on cycle 1's transition.
    from datetime import timedelta
    r1 = detect(s, "wheat", t1 - timedelta(days=150), today=date(2026, 1, 1))
    assert r1["estimated_harvest_date"] == t1.isoformat(), r1["estimated_harvest_date"]
    assert r1["cycle_count"] == 2
    assert t2.isoformat() in [c["estimated_transition_date"] for c in r1["cycles"]]

    # Move the calendar to cycle 2 and the primary must follow it -- same
    # series, same cycles, only the ranking changes.
    r2 = detect(s, "wheat", t2 - timedelta(days=150), today=date(2026, 1, 1))
    assert r2["estimated_harvest_date"] == t2.isoformat(), r2["estimated_harvest_date"]
    assert r2["cycle_count"] == 2
    assert t1.isoformat() in [c["estimated_transition_date"] for c in r2["cycles"]]


# ---------------------------------------------------------------- regression

def check_r1_confirmed_short_circuit():
    """A confirmed date is authoritative and ranking must not override it."""
    s = rows(ramp("2024-11-05",
                  [0.20, 0.45, 0.70, 0.82, 0.83, 0.55, 0.22, 0.18, 0.17,
                   0.30, 0.55, 0.75, 0.80, 0.81, 0.50, 0.20, 0.18]))
    r = detect(s, "wheat", WHEAT_SOWN, today=date(2026, 1, 1),
               confirmed_date="2025-01-09")
    assert r["status"] == "harvest_confirmed", r["status"]
    assert r["estimated_harvest_date"] == "2025-01-09"
    assert r["confidence"] == 1.0
    assert "farmer-confirmed" in r["confidence_basis"]


def check_r2_min_valid_px():
    s = rows(ramp("2024-11-20", GROWTH + FALL), valid_px=MIN_VALID_PX - 1)
    assert detect(s, "wheat", WHEAT_SOWN,
                  today=date(2025, 7, 1))["status"] == "insufficient_data"
    ok = rows(ramp("2024-11-20", GROWTH + FALL), valid_px=MIN_VALID_PX)
    assert detect(ok, "wheat", WHEAT_SOWN,
                  today=date(2025, 7, 1))["status"] != "insufficient_data"


def check_r3_none_never_zero():
    """A missing NDVI must be dropped, never read as 0.0 (a real water value)."""
    pts = ramp("2024-11-20", GROWTH + FALL)
    s = rows(pts)
    s.append({"date": "2025-02-01", "ndvi": None, "valid_px": 120, "vh": None})
    r = detect(s, "wheat", WHEAT_SOWN, today=date(2025, 7, 1))
    assert r["observations"] == len(pts), (r["observations"], len(pts))
    # A None treated as 0.0 mid-season would fabricate a crash-and-recover.
    assert r["cycle_count"] == 1, r["cycle_count"]


def check_r4_response_contract():
    """Every pre-redesign key still present; only cycles/cycle_count added."""
    s = rows(ramp("2024-11-20", GROWTH + FALL))
    r = detect(s, "wheat", WHEAT_SOWN, today=date(2025, 7, 1))
    for k in ("status", "estimated_harvest_date", "expected_harvest_date",
              "harvest_window", "days_to_expected_harvest", "confidence",
              "confidence_basis", "evidence", "observations"):
        assert k in r, f"response lost {k}"
    assert "cycles" in r and "cycle_count" in r
    assert "NOT a calibrated probability" in r["confidence_basis"]
    for c in r["cycles"]:
        for k in ("onset_date", "peak_date", "peak_ndvi", "amplitude",
                  "decline_date", "estimated_transition_date", "bracket_days",
                  "radar_db", "calendar_offset_days", "water_signature",
                  "confidence", "evidence", "is_primary"):
            assert k in c, f"cycle missing {k}"


def check_r5_more_cycles_is_not_more_confidence():
    one = detect(rows(ramp("2024-11-20", GROWTH + FALL)), "wheat", WHEAT_SOWN,
                 today=date(2025, 7, 1))
    two = rows(ramp("2024-11-05",
                    [0.20, 0.45, 0.70, 0.82, 0.83, 0.55, 0.22, 0.18, 0.17,
                     0.30, 0.55, 0.75, 0.80, 0.81, 0.50, 0.20, 0.18]))
    from datetime import timedelta
    cy = find_cycles(_usable(two))
    r = detect(two, "wheat", cy[0]["transition"] - timedelta(days=150),
               today=date(2026, 1, 1))
    assert r["confidence"] <= 0.95 and one["confidence"] <= 0.95
    # The primary's score is its own; a second cycle adds nothing to it.
    assert r["confidence"] == r["cycles"][0]["confidence"], \
        (r["confidence"], r["cycles"][0]["confidence"])


if __name__ == "__main__":
    checks = [v for k, v in sorted(globals().items()) if k.startswith("check_")]
    for fn in checks:
        fn()
        print(f"  OK  {fn.__name__}")
    print(f"\nharvest-cycles self-check OK ({len(checks)} checks)")
