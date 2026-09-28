"""Where a field is in its cycle, read from the curve rather than the calendar.

    python -m app.lifecycle        # self-check, offline

Three lifecycle stages live here, and they are one computation, not three:

  3  observed growth phase  -- and whether it agrees with the crop calendar
  6  fallow                 -- cleared, flat and staying down
  7  emergence              -- a new crop rising from bare ground

They share a single question ("what does the curve say the field is doing
right now?"), so they share a single pass over it. app.harvest answers a
different question -- "was this field harvested, and when" -- which is why
this is a separate module rather than more functions in that one.

WHAT NDVI CANNOT TELL YOU. It cannot name an agronomic stage. Tillering,
jointing and booting are defined by what the plant is doing internally, and
two of them can share a canopy density exactly. So this module never invents
a stage name: app.growth keeps producing those from the calendar, and what
is added here is a COARSE observed phase plus an explicit agreement check
between the two. When they disagree, that is information -- usually that the
sowing date is wrong, which is the most common bad input in the system.

Every threshold below is an INITIAL ENGINEERING PARAMETER. Nothing here has
been validated against ground observations of any field.
"""
from datetime import date, timedelta

from app.growth import growth_stage
from app.harvest import MIN_OBSERVATIONS, _smooth, _usable, find_cycles

# Bare soil in Punjab reads roughly 0.10-0.25 in the optical bands, so a
# field sitting below this with no trend is not growing anything.
FALLOW_NDVI = 0.25

# Emergence has to clear a HIGHER bar than fallow, deliberately. With one
# threshold a field hovering at the boundary would flip between "fallow" and
# "emerging" every revisit; the gap between the two is hysteresis.
EMERGENCE_NDVI = 0.30

# NDVI per day. Roughly 0.06 over a 30-day month -- enough to be a canopy
# developing rather than noise between two passes.
TREND_PER_DAY = 0.002

# Observations used to measure the current trend. Three is the fewest that
# can show a direction rather than a difference.
TREND_OBS = 3

# Within this fraction of the cycle peak, with no trend, the canopy is at
# its maximum rather than still building.
PEAK_BAND = 0.85

# Consecutive observations required before fallow or emergence is declared.
# Same reasoning as the harvest detector's SUSTAIN_N: one reading is cloud.
SUSTAIN_N = 2

# "Is the ground clear" is a question about NOW, so it is answered from the
# newest readings only. Two earlier attempts got this wrong on a real field:
# testing every observation since the harvest let the senescence tail (0.43 in
# early April) veto fallow for the rest of the record, and taking max() over a
# 45-day window let a single 0.300 reading at the window edge do the same. The
# smoothed values are already median-filtered over +/-12 days, so each one
# stands for a fortnight and a short tail is not noise-prone.

# Coarse phases, ordered. The ordering is what makes the calendar comparison
# possible -- subtracting two positions on this scale gives a direction.
PHASES = ("bare", "emerging", "vegetative", "peak", "senescing", "cleared")


def _d(s):
    return date.fromisoformat(s) if isinstance(s, str) else s


def _clear_now(sm, after):
    """Are the most recent observations after `after` all below the canopy bar?"""
    tail = [v for x, v in sm if x > after][-SUSTAIN_N:]
    return len(tail) >= SUSTAIN_N and all(v < EMERGENCE_NDVI for v in tail)


def _trend(sm, n=TREND_OBS):
    """NDVI change per day over the last `n` smoothed observations."""
    if len(sm) < 2:
        return 0.0
    tail = sm[-n:]
    days = (tail[-1][0] - tail[0][0]).days
    return (tail[-1][1] - tail[0][1]) / days if days else 0.0


def observed_phase(sm, cycles):
    """Coarse phase from the curve alone. No calendar, no crop, no sowing date.

    Returns (phase, current_ndvi, slope_per_day, reason).
    """
    if not sm:
        return "bare", None, 0.0, "no usable observations"

    cur_date, cur = sm[-1]
    slope = _trend(sm)
    rising = slope >= TREND_PER_DAY
    falling = slope <= -TREND_PER_DAY

    # A completed cycle the field has not come back from: the ground is
    # clear. This is the state stage 6 is named for. Judged on the RECENT
    # window rather than everything since the harvest, because the senescence
    # tail immediately after a transition is still high and would otherwise
    # veto the state for the rest of the record.
    done = [c for c in cycles if c["transition"] is not None]
    if done:
        last = max(done, key=lambda c: c["transition"])
        if _clear_now(sm, last["transition"]):
            return ("cleared", cur, slope,
                    f"cleared at {last['transition'].isoformat()} and still below "
                    f"{EMERGENCE_NDVI} at the latest observations")

    # An open cycle gives us its own peak to measure against, which is far
    # better than an absolute threshold -- a rice canopy and a wheat canopy
    # top out in different places.
    open_ = [c for c in cycles if c["transition"] is None]
    peak = open_[-1]["peak_ndvi"] if open_ else max(v for _, v in sm)

    if cur < FALLOW_NDVI and not rising:
        return "bare", cur, slope, f"NDVI {cur:.3f} below {FALLOW_NDVI}, not rising"
    if rising:
        if cur < peak * 0.5:
            return "emerging", cur, slope, f"rising {slope * 30:+.3f}/month from a low base"
        return "vegetative", cur, slope, f"canopy building, {slope * 30:+.3f}/month"
    if falling:
        return "senescing", cur, slope, f"falling {slope * 30:+.3f}/month from peak {peak:.3f}"
    if cur >= peak * PEAK_BAND:
        return "peak", cur, slope, f"at {cur / peak:.0%} of the cycle peak, flat"
    if cur < FALLOW_NDVI:
        return "bare", cur, slope, f"NDVI {cur:.3f} below {FALLOW_NDVI}"
    return "vegetative", cur, slope, f"NDVI {cur:.3f}, no clear trend"


def fallow_state(sm, cycles, today):
    """Stage 6. Is the ground clear, and for how long?

    Fallow is not the same as 'harvested'. A field can be cleared for a week
    between crops or lie empty for a season, and the advice a farmer needs is
    different in each case -- which is why the answer is a duration, not a
    flag.
    """
    done = [c for c in cycles if c["transition"] is not None]
    if not done or not sm:
        return {"is_fallow": False, "fallow_since": None, "fallow_days": None}

    last = max(done, key=lambda c: c["transition"])
    if not _clear_now(sm, last["transition"]):
        return {"is_fallow": False, "fallow_since": None, "fallow_days": None}

    since = last["transition"]
    return {
        "is_fallow": True,
        "fallow_since": since.isoformat(),
        "fallow_days": (today - since).days,
        # Sowing advice already exists in app.suitability; this is the trigger
        # for it, not a second copy of it.
        "ready_for_next_crop": True,
    }


def emergence(sm, cycles):
    """Stage 7. Has a crop come up out of bare ground?

    NOT find_cycles. That function only returns a cycle once it has a peak
    above MIN_PEAK_NDVI (0.40), which a three-week-old crop has not reached --
    by the time find_cycles sees it, emergence is weeks in the past. This
    watches for the rise itself.

    `after_clearance` is the distinction that matters to the lifecycle loop.
    A first crop rising from bare soil in November genuinely IS an emergence,
    and reporting it as one is correct; but only an emergence that FOLLOWS a
    completed cycle is the loop re-entering itself. Both are reported rather
    than collapsing them, because a caller tracking the loop and a caller
    asking "has anything come up" want different answers.
    """
    none = {"detected": False, "emerged_on": None, "days_since": None,
            "after_clearance": False}
    if not sm:
        return none

    done = [c for c in cycles if c["transition"] is not None]
    start = max((c["transition"] for c in done), default=None)
    window = [(x, v) for x, v in sm if start is None or x > start]

    for i, (x, v) in enumerate(window):
        if v < EMERGENCE_NDVI:
            continue
        run = window[i:i + SUSTAIN_N]
        if len(run) < SUSTAIN_N or any(vv < EMERGENCE_NDVI for _, vv in run):
            continue                      # one green reading is not a crop
        # The ground has to have been OBSERVED bare first. `not before` is
        # the important half: a series that opens mid-season, with the crop
        # already up, has no bare reading to point at -- and absence of
        # evidence is not evidence of bare ground. Without this guard such a
        # series reports emergence on its very first observation.
        before = [vv for xx, vv in window if xx < x]
        if not before or min(before) >= FALLOW_NDVI:
            return none
        return {"detected": True, "emerged_on": x.isoformat(),
                "days_since": (window[-1][0] - x).days,
                "after_clearance": start is not None}

    return none


def _calendar_phase(growth):
    """The calendar's own position, on the same coarse scale as the curve."""
    if growth["stage_index"] < 0:
        return "bare"
    p = growth["progress_pct"]
    if p >= 100:
        return "cleared"
    if p < 15:
        return "emerging"
    if p < 50:
        return "vegetative"
    if p < 80:
        return "peak"
    return "senescing"


def field_state(series, crop_type, sown, today=None):
    """Stages 3, 6 and 7 in one pass. Everything observed comes from the curve.

    The calendar is still produced -- app.growth names the agronomic stage,
    which imagery cannot -- but it is reported ALONGSIDE the observation and
    the two are compared rather than one overriding the other.
    """
    today = _d(today) or date.today()
    sown = _d(sown)
    usable = _usable(series)

    growth = growth_stage(crop_type, sown, today=today)

    if len(usable) < MIN_OBSERVATIONS:
        return {
            "observed_phase": None,
            "observed_reason": f"only {len(usable)} usable observations; "
                               f"{MIN_OBSERVATIONS} needed before the curve has a shape",
            "current_ndvi": None, "ndvi_trend_per_month": None,
            "calendar_stage": growth["stage"],
            "calendar_phase": _calendar_phase(growth),
            "agreement": "unknown",
            "agreement_note": "No curve to compare the calendar against.",
            "fallow": {"is_fallow": False, "fallow_since": None, "fallow_days": None},
            "emergence": {"detected": False, "emerged_on": None, "days_since": None},
            "observations": len(usable),
        }

    sm = _smooth(usable)
    cycles = find_cycles(usable)
    phase, cur, slope, reason = observed_phase(sm, cycles)
    cal = _calendar_phase(growth)

    # Compare positions on the ordered scale. A difference of one step is
    # ordinary slack in a self-reported sowing date; two or more means the
    # calendar and the field are describing different things.
    # Bare ground before sowing and bare ground after harvest are the same
    # picture. NDVI cannot tell "not yet sown" from "already cut", so calling
    # that a disagreement would be inventing a distinction the data does not
    # carry -- even though the two sit at opposite ends of the ordered scale.
    if {phase, cal} <= {"bare", "cleared"}:
        agreement, note = "consistent", (
            "The field is bare and the calendar agrees the season is over. "
            "Imagery cannot distinguish ground not yet sown from ground already "
            "cut, so this is agreement on what is visible.")
    elif abs(PHASES.index(phase) - PHASES.index(cal)) <= 1:
        agreement, note = "consistent", (
            f"The field looks {phase} and the calendar says {cal} -- these agree "
            f"to within one phase.")
    elif PHASES.index(phase) > PHASES.index(cal):
        agreement, note = "ahead_of_calendar", (
            f"The field is already {phase} while the calendar expects {cal}. The "
            f"crop is running early, or it was sown before the recorded date "
            f"{sown.isoformat()}.")
    else:
        agreement, note = "behind_calendar", (
            f"The field is still {phase} while the calendar expects {cal}. The "
            f"crop is running late, or it was sown after the recorded date "
            f"{sown.isoformat()}.")

    return {
        # --- stage 3: observed, and how it compares -----------------------
        "observed_phase": phase,
        "observed_reason": reason,
        "current_ndvi": round(cur, 4) if cur is not None else None,
        "ndvi_trend_per_month": round(slope * 30, 4),
        "calendar_stage": growth["stage"],          # the agronomic name
        "calendar_phase": cal,                      # the coarse comparison
        "agreement": agreement,
        "agreement_note": note,
        # --- stages 6 and 7 ----------------------------------------------
        "fallow": fallow_state(sm, cycles, today),
        "emergence": emergence(sm, cycles),
        "observations": len(usable),
        "cycle_count": len(cycles),
    }


if __name__ == "__main__":
    from datetime import timedelta as _td

    def rows(start, vals, step=13):
        d0 = date.fromisoformat(start)
        return [{"date": (d0 + _td(days=i * step)).isoformat(), "ndvi": v,
                 "valid_px": 120, "vh": None} for i, v in enumerate(vals)]

    GROW = [0.21, 0.25, 0.29, 0.34, 0.40, 0.47, 0.54, 0.60, 0.64, 0.66]
    FALL = [0.52, 0.22, 0.17, 0.15, 0.14]

    # --- stage 3: rising canopy reads as growing, not as a calendar stage --
    s = rows("2024-11-20", GROW)
    st = field_state(s, "wheat", date(2024, 11, 15), today=date(2025, 3, 1))
    assert st["observed_phase"] in ("vegetative", "peak"), st["observed_phase"]
    assert st["ndvi_trend_per_month"] > 0, st["ndvi_trend_per_month"]
    # The agronomic name still comes from the calendar -- NDVI cannot name it.
    assert st["calendar_stage"] and isinstance(st["calendar_stage"], str)

    # --- stage 3: disagreement is surfaced, not hidden --------------------
    # Same curve, but the farmer claims a sowing date 4 months too early, so
    # the calendar thinks the season is over while the field is still green.
    late = field_state(s, "wheat", date(2024, 7, 1), today=date(2025, 3, 1))
    assert late["calendar_phase"] == "cleared", late["calendar_phase"]
    assert late["agreement"] == "behind_calendar", late["agreement"]
    assert "sown after the recorded date" in late["agreement_note"]

    # --- stage 6: cleared and staying down is fallow ----------------------
    f = field_state(rows("2024-11-20", GROW + FALL), "wheat",
                    date(2024, 11, 15), today=date(2025, 6, 20))
    assert f["observed_phase"] == "cleared", f["observed_phase"]
    assert f["fallow"]["is_fallow"] is True, f["fallow"]
    assert f["fallow"]["fallow_days"] > 0
    assert f["emergence"]["detected"] is False, f["emergence"]

    # A field still carrying a crop is NOT fallow, however low the NDVI.
    g = field_state(rows("2024-11-20", GROW), "wheat", date(2024, 11, 15),
                    today=date(2025, 3, 1))
    assert g["fallow"]["is_fallow"] is False, g["fallow"]
    # ...and its emergence is real but is NOT the loop coming back round.
    assert g["emergence"]["detected"] and not g["emergence"]["after_clearance"]

    # --- stage 7: a new crop rising off bare ground -----------------------
    e = field_state(rows("2024-11-20", GROW + FALL + [0.19, 0.33, 0.42, 0.55]),
                    "wheat", date(2024, 11, 15), today=date(2025, 9, 1))
    assert e["emergence"]["detected"] is True, e["emergence"]
    assert e["emergence"]["after_clearance"] is True, e["emergence"]
    assert e["emergence"]["emerged_on"] is not None
    # Emerging again means it is no longer fallow -- the two are exclusive.
    assert e["fallow"]["is_fallow"] is False, e["fallow"]
    assert e["observed_phase"] in ("emerging", "vegetative"), e["observed_phase"]

    # ONE green reading after clearance is not a new crop.
    blip = field_state(rows("2024-11-20", GROW + FALL + [0.15, 0.40, 0.14, 0.15]),
                       "wheat", date(2024, 11, 15), today=date(2025, 9, 1))
    assert blip["emergence"]["detected"] is False, blip["emergence"]
    assert blip["fallow"]["is_fallow"] is True, blip["fallow"]

    # --- too little data refuses rather than guessing ---------------------
    thin = field_state(rows("2025-01-01", [0.3, 0.4]), "wheat",
                       date(2024, 11, 15), today=date(2025, 3, 1))
    assert thin["observed_phase"] is None and thin["agreement"] == "unknown"
    # ...but the calendar still answers, because it never needed imagery.
    assert thin["calendar_stage"]

    # --- missing NDVI must not be read as bare ground ---------------------
    holes = rows("2024-11-20", GROW)
    holes.append({"date": "2025-02-01", "ndvi": None, "valid_px": 120, "vh": None})
    h = field_state(holes, "wheat", date(2024, 11, 15), today=date(2025, 3, 1))
    assert h["observations"] == len(GROW), h["observations"]
    assert h["observed_phase"] == st["observed_phase"]

    print("lifecycle self-check OK (9 checks)")
