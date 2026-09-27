"""Harvest detection from a field-level time series. Deterministic, not learned.

    python -m app.harvest        # self-check, offline

WHAT THIS IS. A rule over the SHAPE of the NDVI curve. It finds every
growth -> peak -> sustained-decline cycle in the series, scores each one, and
returns the most relevant plus all the others. That is all.

WHAT THIS IS NOT. It is not a trained model, and the `confidence` it returns
is NOT a calibrated probability -- it is a weighted count of how many pieces
of evidence lined up, on a scale someone chose. Two fields at 0.8 are not
"80% likely harvested"; they are "as much evidence as this rule can find".

IT HAS NOT BEEN VALIDATED. No real harvest dates have been scored against it.
Every threshold below is an INITIAL ENGINEERING PARAMETER chosen from a
handful of development fields that are NOT ground truth.
scripts/validate_harvest.py exists to score this the moment real dates
arrive; until it has been run, the output of this module is a hypothesis.

WHY THE CALENDAR NO LONGER PICKS THE PEAK. The previous version chose one
global maximum from observations on or before `expected + 30d`. On a real
two-crop field (Okara, dev farm ce990651) that cutoff landed on the SECOND
crop's peak, so the first crop's December-to-January decline -- the one with
the strongest radar corroboration measured anywhere, +4.7 dB -- was never
considered at all. A wrong sowing date did not degrade the answer, it deleted
it. Sowing dates are self-reported and frequently absent, so the input humans
get wrong must never be able to do that.

The calendar still matters. It ranks candidates, explains whether one is
early or late, and picks which cycle the farmer is asking about when a field
carries two. It may rank and label; it may not filter.
"""
from datetime import date, timedelta

from app.crops import DURATION_DAYS

# ---------------------------------------------------------------------------
# INITIAL ENGINEERING PARAMETERS. None of these are validated. They were set
# from a small number of development fields and from the physics of the
# instruments, and every one of them is expected to move once real harvest
# dates exist to score against.
# ---------------------------------------------------------------------------

# Fraction of the peak NDVI a field must fall BELOW to count as declining.
# A measured Punjab wheat field went 0.618 -> 0.212, a 66% fall, so this is
# not a tight threshold -- it is set to survive a partly-cloudy observation
# part way down, not to sit just under the real drop.
MIN_DROP_FRAC = 0.35

# Consecutive declining observations required. One low reading is a cloud, a
# shadow, or a wet day; two in a row is the field. This is the single most
# important guard in the module -- without it the detector fires every
# overcast week. Unchanged from the previous version, deliberately.
SUSTAIN_N = 2

# How near the expected harvest a decline must fall to be treated as agreeing
# with the calendar. Sowing dates are self-reported and crop durations are
# district norms, so a month either side is the honest tolerance.
NEAR_WINDOW_DAYS = 30

# Radar drop, in dB, treated as supporting evidence. A measured wheat field
# fell 2.3 dB across harvest; 1.5 admits a weaker but real signal without
# firing on speckle, which runs a few tenths of a dB between passes.
RADAR_DROP_DB = 1.5

# Minimum radar observations EACH SIDE before radar may contribute anything.
# Measured on dev farm 3fefe385: with 16 radar scenes across 7 months, a
# 30-day window catches 2-3 points per side and the mean flips sign over a
# 13-day shift in the candidate date (-1.94 dB vs +1.81 dB). One outlier
# dominates. Below this count the corroboration is noise wearing a number.
RADAR_MIN_PER_SIDE = 2

# Below this many usable optical observations the curve has no shape and the
# answer is insufficient_data rather than a guess. A rabi season returns 40-50.
MIN_OBSERVATIONS = 5

# A field observed on only a handful of pixels is mostly edge.
MIN_VALID_PX = 5

# --- cycle-finding parameters ---------------------------------------------

# Median-filter half-window, in days, used ONLY to find peaks and crossings.
# Wide enough to absorb one cloudy scene, narrow enough not to flatten a real
# peak. The reported transition date never comes from smoothed values.
SMOOTH_DAYS = 12

# Two maxima closer together than this are one cycle, not two. A Punjab
# rotation is never tighter than this, so merging is safe here.
PEAK_SEP_DAYS = 45

# A peak below this is not a canopy worth calling a crop cycle.
MIN_PEAK_NDVI = 0.40

# Peak minus the surrounding trough. Development fields measured 0.60-0.76,
# so this sits well below anything real while excluding drift and noise.
MIN_AMPLITUDE = 0.25

# A decline this soon after its own peak is cloud or shadow, not senescence:
# a crop does not ripen and get cut inside a week. Initial value only.
MIN_PEAK_TO_DROP_DAYS = 10

# If NDVI climbs back above the decline floor within this many days, the
# field was disturbed, not harvested, and the cycle reopens.
RECOVERY_DAYS = 30

# Water-like signature. NDVI at or below this is water absorbing NIR; VH at
# or below this is a surface smooth enough to reflect radar away rather than
# back. Requiring BOTH means two physically unrelated instruments agree.
# This says the signature is present -- it does NOT prove flooding.
WATER_NDVI = 0.05
WATER_VH = -25.0

# Ceiling on the evidence score when the water-like signature is present.
WATER_CONFIDENCE_CAP = 0.45


def _d(s):
    return date.fromisoformat(s) if isinstance(s, str) else s


def _usable(series):
    """Rows with a real NDVI over enough pixels, oldest first.

    A missing NDVI stays missing. It is never coerced to 0.0 -- zero is a
    legitimate reading over water, so defaulting would invent an observation.
    """
    rows = [r for r in series
            if r.get("ndvi") is not None and (r.get("valid_px") or 0) >= MIN_VALID_PX]
    return sorted(rows, key=lambda r: r["date"])


def _smooth(usable):
    """[(date, median NDVI within +/- SMOOTH_DAYS)]. Peak finding only.

    Returned values are used to LOCATE peaks and crossings. They never become
    a reported figure: the transition date is always bracketed on raw
    observations, so no date this module emits is a smoothing artefact.
    """
    pts = [(_d(r["date"]), r["ndvi"]) for r in usable]
    out = []
    for di, _ in pts:
        near = sorted(v for dj, v in pts if abs((dj - di).days) <= SMOOTH_DAYS)
        out.append((di, near[len(near) // 2]))
    return out


def _peaks(sm):
    """Local maxima dominating a +/- PEAK_SEP_DAYS neighbourhood.

    NO CALENDAR REACHES THIS FUNCTION. That is the structural guarantee that
    a wrong planting date cannot hide a real cycle: there is no date here for
    it to be wrong about.
    """
    found = []
    for di, vi in sm:
        nb = [v for dj, v in sm if abs((dj - di).days) <= PEAK_SEP_DAYS]
        if vi >= max(nb) and vi >= MIN_PEAK_NDVI:
            found.append((di, vi))
    # Collapse a plateau -- consecutive near-equal maxima -- to its highest
    # point, so a flat February canopy is one cycle rather than five.
    merged = []
    for p in found:
        if merged and (p[0] - merged[-1][0]).days <= PEAK_SEP_DAYS:
            if p[1] > merged[-1][1]:
                merged[-1] = p
        else:
            merged.append(p)
    return merged


def _decline_after(peak_date, level, sm):
    """First sustained crossing below `level` after the peak, or None.

    Sustained means SUSTAIN_N consecutive observations stay down AND the
    field does not climb back above the floor within RECOVERY_DAYS. The
    second half is what separates a harvest from a hailstorm the crop grew
    out of: both dip, only one stays down.
    """
    after = [(x, v) for x, v in sm if x > peak_date]
    for i, (x, v) in enumerate(after):
        if v > level:
            continue
        if (x - peak_date).days < MIN_PEAK_TO_DROP_DAYS:
            continue                       # too soon to be senescence
        run = after[i:i + SUSTAIN_N]
        if len(run) < SUSTAIN_N or any(vv > level for _, vv in run):
            continue                       # a single dip, not a decline
        recovered = [vv for xx, vv in after
                     if 0 < (xx - x).days <= RECOVERY_DAYS and vv > level]
        if recovered:
            continue                       # disturbance, then regrowth
        return x, v
    return None


def find_cycles(usable):
    """Every growth -> peak -> sustained-decline cycle in the series.

    CALENDAR-FREE BY CONSTRUCTION: this function takes only observations. It
    cannot consult a planting date, an expected harvest or a crop duration
    because none of them are passed to it.

    A cycle whose decline has not happened yet is still returned, with
    `transition` None -- that is how an in-progress crop is represented, and
    why "peak at the final observation" yields no harvest date.
    """
    if len(usable) < MIN_OBSERVATIONS:
        return []

    sm = _smooth(usable)
    raw = [(_d(r["date"]), r["ndvi"]) for r in usable]
    cycles = []

    for pd_, pv in _peaks(sm):
        level = pv * (1 - MIN_DROP_FRAC)

        before = [(x, v) for x, v in sm if x < pd_]
        after = [(x, v) for x, v in sm if x > pd_]

        onset = next((x for x, v in reversed(before) if v <= level), None)
        trough_b = min((v for _, v in before), default=None)
        trough_a = min((v for _, v in after), default=None)
        troughs = [t for t in (trough_b, trough_a) if t is not None]
        amplitude = pv - min(troughs) if troughs else 0.0
        if amplitude < MIN_AMPLITUDE:
            continue                       # drift, not a crop cycle

        dec = _decline_after(pd_, level, sm)

        transition = bracket = None
        if dec:
            # Bracket on RAW observations. The midpoint between the last
            # reading still up and the first one down does not lean either
            # way; naming an endpoint would bias every estimate by half a
            # revisit gap.
            hi = [x for x, v in raw if pd_ <= x < dec[0] and v > level]
            lo = dec[0]
            a = hi[-1] if hi else pd_
            transition = a + timedelta(days=(lo - a).days // 2)
            bracket = (a, lo)

        cycles.append({
            "peak_date": pd_, "peak_ndvi": round(pv, 4),
            "onset_date": onset, "amplitude": round(amplitude, 4),
            "decline_date": dec[0] if dec else None,
            "decline_ndvi": round(dec[1], 4) if dec else None,
            "transition": transition, "bracket": bracket,
        })

    return sorted(cycles, key=lambda c: c["peak_date"])


def _radar_drop(series, around, span=30):
    """(dB fallen, n_before, n_after) around a date, or (None, n, n).

    Positive dB means backscatter FELL, the direction a harvest moves it:
    standing crop scatters the signal back, bare soil reflects it away.

    Returns None for the drop unless RADAR_MIN_PER_SIDE observations exist on
    BOTH sides. Measured on a dev field, a mean over 2-3 scenes flips sign
    across a 13-day shift in the candidate date -- one outlier is enough. A
    number that unstable must not buy confidence.
    """
    before = [r["vh"] for r in series if r.get("vh") is not None
              and 0 < (around - _d(r["date"])).days <= span]
    after = [r["vh"] for r in series if r.get("vh") is not None
             and 0 < (_d(r["date"]) - around).days <= span]
    if len(before) < RADAR_MIN_PER_SIDE or len(after) < RADAR_MIN_PER_SIDE:
        return None, len(before), len(after)
    return sum(before) / len(before) - sum(after) / len(after), len(before), len(after)


def _water_signature(series, around, span=30):
    """Is there a water-like optical AND radar signature near this date?

    NDVI at or below WATER_NDVI means little or no vegetation reflectance;
    VH at or below WATER_VH means a surface smooth enough to scatter radar
    away. Requiring both means two unrelated instruments agree.

    This reports that the SIGNATURE is present. It does not establish the
    cause: a flooded paddy, a waterlogged field and a newly irrigated basin
    all look like this, and so, briefly, does a very wet bare field.
    """
    if around is None:
        return None
    near = [r for r in series if abs((_d(r["date"]) - around).days) <= span]
    wet_o = [r["ndvi"] for r in near
             if r.get("ndvi") is not None and r["ndvi"] <= WATER_NDVI]
    wet_r = [r["vh"] for r in near
             if r.get("vh") is not None and r["vh"] <= WATER_VH]
    if not wet_o or not wet_r:
        return None
    return {"ndvi_min": round(min(wet_o), 4), "vh_min": round(min(wet_r), 2),
            "n_optical": len(wet_o), "n_radar": len(wet_r)}


def score_cycle(cycle, series, expected, n_obs):
    """Evidence score and human-readable reasons for ONE cycle.

    A weighted tally, never a probability. Each term is one INDEPENDENT
    reason to believe the break is a harvest rather than an artefact, and
    the terms are the same ones the previous version used -- now computed
    per cycle instead of once for the whole series.
    """
    ev = [f"Peak NDVI {cycle['peak_ndvi']:.3f} on {cycle['peak_date'].isoformat()}"
          f"{' (onset ' + cycle['onset_date'].isoformat() + ')' if cycle['onset_date'] else ''}"
          f", amplitude {cycle['amplitude']:.3f}."]

    t = cycle["transition"]
    if t is None:
        ev.append("No sustained decline after this peak -- still growing, or "
                  "at maturity and not yet cut.")
        return 0.0, ev, None

    lo, hi = cycle["bracket"]
    fall = (cycle["peak_ndvi"] - cycle["decline_ndvi"]) / cycle["peak_ndvi"]
    conf = 0.40
    ev.append(f"NDVI fell {fall:.0%} from peak to {cycle['decline_ndvi']:.3f} by "
              f"{cycle['decline_date'].isoformat()}, sustained over "
              f"{SUSTAIN_N}+ observations with no recovery within "
              f"{RECOVERY_DAYS} days.")
    ev.append(f"Transition bracketed between {lo.isoformat()} and {hi.isoformat()} "
              f"({(hi - lo).days} days); midpoint reported.")

    # --- calendar: evidence, never a gate --------------------------------
    near = abs((t - expected).days)
    if near <= NEAR_WINDOW_DAYS:
        conf += 0.25
        ev.append(f"Transition is {near} days from the expected harvest date "
                  f"{expected.isoformat()} -- consistent with the crop calendar.")
    else:
        ev.append(f"Transition is {near} days from the expected harvest date "
                  f"{expected.isoformat()} -- further out than the crop calendar "
                  f"predicts, so this may be a different cycle or a wrong "
                  f"sowing date. It is reported either way.")

    # --- radar: supporting only, and only when there is enough of it -----
    drop, nb, na = _radar_drop(series, t)
    radar_ev = None
    if drop is None:
        ev.append(f"Insufficient radar to corroborate: {nb} observation(s) before "
                  f"and {na} after, {RADAR_MIN_PER_SIDE} needed each side. The "
                  f"optical evidence stands on its own.")
    elif drop >= RADAR_DROP_DB:
        conf += 0.20
        radar_ev = round(drop, 2)
        ev.append(f"Sentinel-1 VH fell {drop:.1f} dB across the same date "
                  f"({nb} before / {na} after) -- radar agrees, and it is not "
                  f"affected by cloud.")
    else:
        radar_ev = round(drop, 2)
        ev.append(f"Sentinel-1 VH moved only {drop:.1f} dB across the break, below "
                  f"the {RADAR_DROP_DB} dB treated as corroboration. This does not "
                  f"count against the optical evidence.")

    if (hi - lo).days <= 7:
        conf += 0.15
        ev.append(f"Revisit gap around the break is only {(hi - lo).days} days, "
                  f"so the date is tightly bracketed.")

    # --- water-like signature: caps, never rejects ------------------------
    water = _water_signature(series, t)
    if water:
        conf = min(conf, WATER_CONFIDENCE_CAP)
        ev.append(f"A water-like spectral and radar signature is present near this "
                  f"date (NDVI down to {water['ndvi_min']}, VH down to "
                  f"{water['vh_min']} dB). Flooding, waterlogging and irrigation "
                  f"all look like this, so the cause is not established and the "
                  f"score is capped at {WATER_CONFIDENCE_CAP}.")

    cycle["radar_db"] = radar_ev
    cycle["water_signature"] = water
    cycle["calendar_offset_days"] = (t - expected).days
    return round(min(conf, 0.95), 2), ev, t


def rank_cycles(cycles, expected):
    """Order completed cycles by relevance. Ranking NEVER deletes a cycle.

    Keys, in order:
      1. no water-like signature first -- a clean candidate outranks an
         ambiguous one, which is the whole requirement for the water screen;
      2. nearest the expected harvest date -- this is the calendar's proper
         job, choosing WHICH cycle the farmer means when a field has two;
      3. higher evidence score;
      4. more recent.
    """
    return sorted(
        cycles,
        key=lambda c: (c.get("water_signature") is not None,
                       abs((c["transition"] - expected).days),
                       -c["confidence"],
                       -c["transition"].toordinal()),
    )


def _public(c):
    """One cycle, JSON-safe, with every field a caller needs to judge it."""
    def iso(x):
        return x.isoformat() if x else None
    return {
        "onset_date": iso(c["onset_date"]),
        "peak_date": iso(c["peak_date"]),
        "peak_ndvi": c["peak_ndvi"],
        "amplitude": c["amplitude"],
        "decline_date": iso(c["decline_date"]),
        "decline_ndvi": c["decline_ndvi"],
        "estimated_transition_date": iso(c["transition"]),
        "bracket_days": (c["bracket"][1] - c["bracket"][0]).days if c["bracket"] else None,
        "radar_db": c.get("radar_db"),
        "calendar_offset_days": c.get("calendar_offset_days"),
        "water_signature": c.get("water_signature"),
        "confidence": c.get("confidence", 0.0),
        "evidence": c.get("evidence", []),
        "is_primary": c.get("is_primary", False),
    }


def detect(series, crop_type, sown, today=None, confirmed_date=None):
    """Assess whether this field has been harvested.

    series           rows from app.field.field_series -- date + indices + radar
    crop_type        key into the crop calendar
    sown             sowing date (real or the calendar's estimate)
    confirmed_date   the farmer's own answer; short-circuits everything

    Every response key the previous version returned is still returned.
    `cycles` and `cycle_count` are added: `cycles` holds EVERY discovered
    cycle, primary first, each flagged with `is_primary`. There is one list,
    not a primary plus a separate leftovers list.
    """
    sown = _d(sown)
    today = _d(today) or date.today()
    expected = sown + timedelta(days=DURATION_DAYS[crop_type])

    def out(status, **kw):
        base = {
            "status": status,
            "estimated_harvest_date": None,
            "expected_harvest_date": expected.isoformat(),
            "harvest_window": [
                (expected - timedelta(days=NEAR_WINDOW_DAYS)).isoformat(),
                (expected + timedelta(days=NEAR_WINDOW_DAYS)).isoformat(),
            ],
            "days_to_expected_harvest": (expected - today).days,
            "confidence": 0.0,
            # Named so nobody downstream reads `confidence` as a probability.
            "confidence_basis": "rule-based evidence count, NOT a calibrated "
                                "probability; detector is not yet validated",
            "evidence": [],
            "observations": 0,
            "cycles": [],
            "cycle_count": 0,
        }
        base.update(kw)
        return base

    # The farmer's answer outranks every satellite. This is ground truth, and
    # the whole point of collecting it is that it settles the question. It is
    # checked before any cycle analysis so nothing can override it.
    if confirmed_date:
        return out("harvest_confirmed",
                   estimated_harvest_date=_d(confirmed_date).isoformat(),
                   confidence=1.0,
                   confidence_basis="farmer-confirmed, not inferred",
                   evidence=["Harvest date confirmed by the farmer."])

    usable = _usable(series)
    if len(usable) < MIN_OBSERVATIONS:
        return out("insufficient_data", observations=len(usable), evidence=[
            f"Only {len(usable)} usable optical observations; "
            f"{MIN_OBSERVATIONS} are needed before the curve has a shape."])

    cycles = find_cycles(usable)
    for c in cycles:
        c["confidence"], c["evidence"], _ = score_cycle(c, series, expected, len(usable))

    done = [c for c in cycles if c["transition"] is not None]
    open_ = [c for c in cycles if c["transition"] is None]

    # --- nothing completed: describe where the calendar says we are -------
    if not done:
        days_left = (expected - today).days
        ev = []
        if open_:
            ev += open_[-1]["evidence"]
        else:
            ev.append(f"No vegetation cycle above NDVI {MIN_PEAK_NDVI} with "
                      f"amplitude {MIN_AMPLITUDE} was found in "
                      f"{len(usable)} observations.")
        if days_left <= 0:
            status = "harvest_watch"
            ev.append("Past the expected harvest date with no sustained NDVI "
                      "decline observed yet.")
        elif days_left <= 14:
            status = "harvest_watch"
            ev.append(f"Expected harvest in {days_left} days; watching for decline.")
        elif days_left <= 30:
            status = "approaching_maturity"
        else:
            status = "growing"
        return out(status, observations=len(usable), evidence=ev,
                   cycles=[_public(c) for c in cycles], cycle_count=len(cycles))

    # --- rank, and keep every candidate visible ---------------------------
    ordered = rank_cycles(done, expected)
    primary = ordered[0]
    primary["is_primary"] = True
    rest = ordered[1:] + open_

    t = primary["transition"]
    evidence = list(primary["evidence"])
    if rest:
        evidence.append(
            f"{len(cycles)} vegetation cycles were found in this series. The one "
            f"reported is nearest the expected harvest date; the others remain in "
            f"`cycles` and were not discarded.")

    # A break seen long ago, with the field staying down, is history rather
    # than news -- and it is what tells the lifecycle loop the field is fallow.
    status = "post_harvest" if (today - t).days > 30 else "possible_harvest"

    return out(status,
               estimated_harvest_date=t.isoformat(),
               # The score is the PRIMARY cycle's own. Finding more cycles is
               # not more evidence that any one of them is a harvest.
               confidence=primary["confidence"],
               evidence=evidence,
               observations=len(usable),
               cycles=[_public(c) for c in [primary] + rest],
               cycle_count=len(cycles))


if __name__ == "__main__":
    SOWN = date(2024, 11, 15)          # wheat, duration 150d -> expect 2025-04-14

    def series(points, radar=()):
        rows = [{"date": d, "ndvi": n, "valid_px": 120, "vh": None} for d, n in points]
        rows += [{"date": d, "ndvi": None, "valid_px": 0, "vh": v} for d, v in radar]
        return sorted(rows, key=lambda r: r["date"])

    # A denser version of the measured Punjab curve. The previous self-check
    # used 9 widely-spaced points; smoothing needs neighbours within
    # SMOOTH_DAYS to do anything, so the fixture now samples roughly
    # fortnightly the way a real season does.
    REAL = [
        ("2024-11-20", 0.210), ("2024-12-02", 0.250), ("2024-12-15", 0.288),
        ("2024-12-28", 0.320), ("2025-01-14", 0.365), ("2025-01-28", 0.410),
        ("2025-02-12", 0.454), ("2025-02-26", 0.510), ("2025-03-14", 0.570),
        ("2025-03-26", 0.600), ("2025-04-08", 0.618), ("2025-04-20", 0.508),
        ("2025-05-06", 0.212), ("2025-05-18", 0.190), ("2025-05-30", 0.185),
    ]
    real = series(REAL)
    r = detect(real, "wheat", SOWN, today=date(2025, 6, 10))
    assert r["status"] == "post_harvest", r["status"]
    # This date is UNCHANGED from the pre-redesign self-check, and that was
    # not arranged: the bracket is still 04-20..05-06 because smoothing moves
    # where the peak is FOUND but the transition is still bracketed on raw
    # observations, which the smoothing never touches. Verified by running
    # the new algorithm, not by tuning until the old number came back.
    assert r["estimated_harvest_date"] == "2025-04-28", r["estimated_harvest_date"]
    assert r["cycle_count"] == 1, r["cycle_count"]
    assert r["cycles"][0]["is_primary"] is True
    assert 0.6 <= r["confidence"] < 0.95, r["confidence"]

    # Radar agreeing must RAISE confidence, and be the only difference.
    rr = detect(series(REAL, radar=[("2025-04-04", -17.3), ("2025-04-10", -17.4),
                                    ("2025-05-08", -19.6), ("2025-05-20", -19.7)]),
                "wheat", SOWN, today=date(2025, 6, 10))
    assert rr["confidence"] > r["confidence"], (rr["confidence"], r["confidence"])
    assert any("radar agrees" in e for e in rr["evidence"]), rr["evidence"]

    # Radar present but too sparse must NOT contribute, and must say so.
    sparse = detect(series(REAL, radar=[("2025-04-10", -17.4), ("2025-05-08", -19.6)]),
                    "wheat", SOWN, today=date(2025, 6, 10))
    assert sparse["confidence"] == r["confidence"], sparse["confidence"]
    assert any("Insufficient radar" in e for e in sparse["evidence"])

    # ONE low reading is a cloud, not a harvest. The guard that stops the
    # detector firing every overcast week -- if it regresses, all of this
    # becomes noise.
    blip = detect(series(REAL[:11] + [("2025-04-20", 0.150), ("2025-05-06", 0.600),
                                      ("2025-05-18", 0.610), ("2025-05-30", 0.615)]),
                  "wheat", SOWN, today=date(2025, 6, 10))
    assert blip["estimated_harvest_date"] is None, blip["estimated_harvest_date"]
    assert blip["status"] != "post_harvest", blip["status"]

    # Mid-season: growing, then watch as the date nears. No date invented.
    mid = series(REAL[:8])
    g = detect(mid, "wheat", SOWN, today=date(2025, 2, 28))
    assert g["status"] == "growing" and g["estimated_harvest_date"] is None, g["status"]
    assert g["confidence"] == 0.0
    assert detect(mid, "wheat", SOWN, today=date(2025, 4, 8))["status"] == "harvest_watch"
    assert detect(mid, "wheat", SOWN,
                  today=date(2025, 3, 25))["status"] == "approaching_maturity"

    # Too few points must refuse rather than guess from three dots.
    few = detect(series(REAL[:2]), "wheat", SOWN, today=date(2025, 6, 10))
    assert few["status"] == "insufficient_data" and few["confidence"] == 0.0

    # Pixel-starved rows must not count toward the observation minimum.
    starved = [{"date": d, "ndvi": n, "valid_px": 2, "vh": None} for d, n in REAL]
    assert detect(starved, "wheat", SOWN,
                  today=date(2025, 6, 10))["status"] == "insufficient_data"

    # A farmer's confirmation outranks the imagery, even a contradicting curve.
    c = detect(real, "wheat", SOWN, today=date(2025, 6, 10), confirmed_date="2025-04-16")
    assert c["status"] == "harvest_confirmed" and c["confidence"] == 1.0
    assert c["estimated_harvest_date"] == "2025-04-16"

    # THE REGRESSION THIS REDESIGN EXISTS FOR: a badly wrong sowing date must
    # not hide a real cycle. Same curve, sowing claimed 120 days early.
    wrong = detect(real, "wheat", date(2024, 7, 18), today=date(2025, 6, 10))
    assert wrong["estimated_harvest_date"] == "2025-04-28", wrong["estimated_harvest_date"]
    assert wrong["cycle_count"] == 1
    assert any("further out than the crop calendar" in e for e in wrong["evidence"])

    assert "NOT a calibrated probability" in r["confidence_basis"]

    print("harvest self-check OK (11 checks)")
