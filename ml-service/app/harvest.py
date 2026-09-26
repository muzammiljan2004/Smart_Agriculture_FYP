"""Harvest detection from a field-level time series. Deterministic, not learned.

    python -m app.harvest        # self-check, offline

WHAT THIS IS. A rule over the shape of the NDVI curve: find the peak, find a
sustained decline after it, check the decline lands near the crop calendar's
expected harvest, and corroborate with radar where radar exists. That is all.

WHAT THIS IS NOT. It is not a trained model, and the `confidence` it returns
is NOT a calibrated probability -- it is a weighted count of how many pieces
of evidence lined up, on a scale someone chose. Two fields at 0.8 are not
"80% likely harvested"; they are "as much evidence as this rule can find".

IT HAS NOT BEEN VALIDATED. No real harvest dates have been scored against it
yet. scripts/validate_harvest.py exists to do that the moment they arrive,
and until it has been run the output of this module is a hypothesis.

The evidence it looks for is real, though. A 1 ha Punjab wheat field over
rabi 2024-25, measured:

    Nov 0.210   Dec 0.288   Jan 0.365   Feb 0.454
    Mar 0.570   Apr 0.508 (peak 0.618)  May 0.212   <- the break

and Sentinel-1 VH over the same field moves -17.33 dB in April to -19.63 in
May, independently.
"""
from datetime import date, timedelta

from app.crops import DURATION_DAYS

# Fraction of the peak NDVI a field must fall BELOW to count as declining.
# Wheat above goes 0.618 -> 0.212, a 66% fall, so 0.35 is not a tight
# threshold -- it is set to survive a partly-cloudy observation part way
# down, not to sit just under the real drop.
MIN_DROP_FRAC = 0.35

# Consecutive declining observations required. One low reading is a cloud, a
# shadow, or a wet day; two in a row is the field. This is the single most
# important guard here -- a detector without it fires every overcast week.
SUSTAIN_N = 2

# How near the expected harvest date a decline has to fall to be treated as
# corroborating the calendar rather than merely coinciding with it. Sowing
# dates are self-reported and crop durations are district norms, so a month
# either side is the honest tolerance.
NEAR_WINDOW_DAYS = 30

# Radar drop, in dB, treated as supporting evidence. The measured wheat field
# fell 2.3 dB across harvest; 1.5 admits a weaker but real signal without
# firing on speckle, which runs a few tenths of a dB between passes.
RADAR_DROP_DB = 1.5

# Below this many usable optical observations, the curve has too few points
# for "sustained" to mean anything and the answer is insufficient_data rather
# than a guess. A normal rabi season returns 40-50.
MIN_OBSERVATIONS = 5

# A field observed on only a handful of pixels is mostly edge. Rows below
# this are dropped before any shape analysis.
MIN_VALID_PX = 5


def _d(s):
    return date.fromisoformat(s) if isinstance(s, str) else s


def detect(series, crop_type, sown, today=None, confirmed_date=None):
    """Assess whether this field has been harvested.

    series           rows from app.field.field_series -- date + indices + radar
    crop_type        key into the crop calendar
    sown             sowing date (real or the calendar's estimate)
    confirmed_date   the farmer's own answer; short-circuits everything

    Returns {status, estimated_harvest_date, expected_harvest_date,
             harvest_window, confidence, evidence, observations}.
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
        }
        base.update(kw)
        return base

    # The farmer's answer outranks every satellite. This is ground truth, and
    # the whole point of collecting it is that it settles the question.
    if confirmed_date:
        return out("harvest_confirmed",
                   estimated_harvest_date=_d(confirmed_date).isoformat(),
                   confidence=1.0,
                   confidence_basis="farmer-confirmed, not inferred",
                   evidence=["Harvest date confirmed by the farmer."])

    usable = [r for r in series
              if r.get("ndvi") is not None and (r.get("valid_px") or 0) >= MIN_VALID_PX]
    usable.sort(key=lambda r: r["date"])

    if len(usable) < MIN_OBSERVATIONS:
        return out("insufficient_data", observations=len(usable), evidence=[
            f"Only {len(usable)} usable optical observations; "
            f"{MIN_OBSERVATIONS} are needed before the curve has a shape."])

    # --- the peak ---------------------------------------------------------
    # Restricted to on-or-before the expected harvest plus the tolerance
    # window. Without that bound, a field already harvested and re-sown would
    # peak on the NEXT crop and the decline search would start after it.
    cutoff = expected + timedelta(days=NEAR_WINDOW_DAYS)
    candidates = [r for r in usable if _d(r["date"]) <= cutoff] or usable
    peak = max(candidates, key=lambda r: r["ndvi"])
    peak_date, peak_ndvi = _d(peak["date"]), peak["ndvi"]

    after = [r for r in usable if _d(r["date"]) > peak_date]
    floor = peak_ndvi * (1 - MIN_DROP_FRAC)

    evidence = [
        f"Peak NDVI {peak_ndvi:.3f} on {peak_date.isoformat()} "
        f"({len(usable)} usable observations).",
    ]

    # --- sustained decline ------------------------------------------------
    drop_start = None
    run = 0
    for r in after:
        if r["ndvi"] < floor:
            run += 1
            if run == 1:
                first_low = r
            if run >= SUSTAIN_N:
                drop_start = first_low
                break
        else:
            run = 0

    if drop_start is None:
        # No decline. How the field is described depends only on where the
        # calendar says it is, and the text must not imply we saw anything.
        days_left = (expected - today).days
        if after and after[-1]["ndvi"] < floor:
            evidence.append(
                f"NDVI has fallen below {floor:.3f} once but not for "
                f"{SUSTAIN_N} consecutive observations -- treating a single "
                f"low reading as cloud, not harvest.")
        if days_left <= 0:
            status = "harvest_watch"
            evidence.append("Past the expected harvest date with no sustained "
                            "NDVI decline observed yet.")
        elif days_left <= 14:
            status = "harvest_watch"
            evidence.append(f"Expected harvest in {days_left} days; watching for decline.")
        elif days_left <= 30:
            status = "approaching_maturity"
        else:
            status = "growing"
        return out(status, observations=len(usable), evidence=evidence,
                   confidence=0.0)

    # --- date the break ---------------------------------------------------
    # Midpoint between the last observation still up and the first one down.
    # A revisit gap of 5-10 days is normal, so naming either endpoint as THE
    # harvest date would be a systematic bias of half the gap; the midpoint is
    # the estimator that does not lean.
    before_drop = [r for r in after if _d(r["date"]) < _d(drop_start["date"])]
    last_high = before_drop[-1] if before_drop else peak
    lo, hi = _d(last_high["date"]), _d(drop_start["date"])
    estimated = lo + timedelta(days=(hi - lo).days // 2)

    fall = (peak_ndvi - drop_start["ndvi"]) / peak_ndvi
    evidence.append(
        f"NDVI fell {fall:.0%} from peak to {drop_start['ndvi']:.3f} by "
        f"{hi.isoformat()}, sustained over {SUSTAIN_N}+ observations.")
    evidence.append(
        f"Harvest bracketed between {lo.isoformat()} and {hi.isoformat()} "
        f"({(hi - lo).days} days); midpoint reported.")

    # --- scoring ----------------------------------------------------------
    # A weighted tally, not a probability. Each term is one INDEPENDENT reason
    # to believe the break is a harvest rather than an artefact.
    confidence = 0.40                                   # sustained decline
    near = abs((estimated - expected).days)
    if near <= NEAR_WINDOW_DAYS:
        confidence += 0.25
        evidence.append(f"Break is {near} days from the expected harvest date "
                        f"{expected.isoformat()} -- consistent with the crop calendar.")
    else:
        evidence.append(f"Break is {near} days from the expected harvest date "
                        f"{expected.isoformat()} -- further out than the crop "
                        f"calendar predicts, so this may not be a harvest.")

    radar = _radar_drop(series, estimated)
    if radar is not None and radar >= RADAR_DROP_DB:
        confidence += 0.20
        evidence.append(f"Sentinel-1 VH fell {radar:.1f} dB across the same date "
                        f"-- radar agrees, and it is not affected by cloud.")
    elif radar is None:
        evidence.append("No Sentinel-1 coverage either side of the break, so "
                        "the decline rests on optical evidence alone.")
    else:
        evidence.append(f"Sentinel-1 VH moved only {radar:.1f} dB across the break, "
                        f"below the {RADAR_DROP_DB} dB treated as corroboration.")

    if (hi - lo).days <= 7:
        confidence += 0.15
        evidence.append(f"Revisit gap around the break is only {(hi - lo).days} days, "
                        f"so the date is tightly bracketed.")

    # A break seen long ago, with the field staying down, is history rather
    # than news -- and it is what tells the lifecycle loop the field is fallow.
    status = "post_harvest" if (today - estimated).days > 30 else "possible_harvest"

    return out(status,
               estimated_harvest_date=estimated.isoformat(),
               confidence=round(min(confidence, 0.95), 2),
               evidence=evidence,
               observations=len(usable))


def _radar_drop(series, around, span=30):
    """Mean VH before minus mean VH after `around`, in dB. None if no coverage.

    Positive means backscatter FELL, which is the direction a harvest moves
    it: standing crop scatters the signal back, bare soil reflects it away.
    """
    before = [r["vh"] for r in series if r.get("vh") is not None
              and 0 < (around - _d(r["date"])).days <= span]
    after = [r["vh"] for r in series if r.get("vh") is not None
             and 0 < (_d(r["date"]) - around).days <= span]
    if not before or not after:
        return None
    return sum(before) / len(before) - sum(after) / len(after)


if __name__ == "__main__":
    SOWN = date(2024, 11, 15)          # wheat, duration 150d -> expect 2025-04-14

    def series(points, radar=()):
        rows = [{"date": d, "ndvi": n, "valid_px": 120, "vh": None} for d, n in points]
        rows += [{"date": d, "ndvi": None, "valid_px": 0, "vh": v} for d, v in radar]
        return sorted(rows, key=lambda r: r["date"])

    # The real measured curve: rises to April, collapses in May.
    real = series([
        ("2024-11-20", 0.210), ("2024-12-15", 0.288), ("2025-01-14", 0.365),
        ("2025-02-12", 0.454), ("2025-03-14", 0.570), ("2025-04-08", 0.618),
        ("2025-04-20", 0.508), ("2025-05-06", 0.212), ("2025-05-18", 0.190),
    ])
    r = detect(real, "wheat", SOWN, today=date(2025, 5, 25))
    assert r["status"] == "possible_harvest", r
    assert r["estimated_harvest_date"] == "2025-04-28", r   # midpoint 04-20..05-06
    assert r["expected_harvest_date"] == "2025-04-14", r
    assert 0.6 <= r["confidence"] < 0.95, r["confidence"]

    # Radar agreeing must RAISE confidence, and it must be the only difference.
    with_radar = series(
        [("2024-11-20", 0.210), ("2024-12-15", 0.288), ("2025-01-14", 0.365),
         ("2025-02-12", 0.454), ("2025-03-14", 0.570), ("2025-04-08", 0.618),
         ("2025-04-20", 0.508), ("2025-05-06", 0.212), ("2025-05-18", 0.190)],
        radar=[("2025-04-10", -17.33), ("2025-04-22", -17.40),
               ("2025-05-08", -19.63), ("2025-05-20", -19.70)])
    rr = detect(with_radar, "wheat", SOWN, today=date(2025, 5, 25))
    assert rr["confidence"] > r["confidence"], (rr["confidence"], r["confidence"])
    assert any("radar agrees" in e for e in rr["evidence"]), rr["evidence"]

    # ONE low reading is a cloud, not a harvest. This is the guard that stops
    # the detector firing every overcast week -- if it ever regresses, the
    # whole thing becomes noise.
    blip = series([
        ("2024-11-20", 0.210), ("2024-12-15", 0.288), ("2025-01-14", 0.365),
        ("2025-02-12", 0.454), ("2025-03-14", 0.570), ("2025-04-08", 0.618),
        ("2025-04-20", 0.150), ("2025-05-06", 0.600), ("2025-05-18", 0.610),
    ])
    b = detect(blip, "wheat", SOWN, today=date(2025, 5, 25))
    assert b["status"] != "possible_harvest", b
    assert b["estimated_harvest_date"] is None, b

    # Mid-season: growing, then watch as the date nears. No date invented.
    mid = series([("2024-11-20", 0.21), ("2024-12-15", 0.29), ("2025-01-14", 0.37),
                  ("2025-01-28", 0.42), ("2025-02-12", 0.45)])
    g = detect(mid, "wheat", SOWN, today=date(2025, 2, 14))
    assert g["status"] == "growing" and g["estimated_harvest_date"] is None, g
    assert g["confidence"] == 0.0, g

    w = detect(mid, "wheat", SOWN, today=date(2025, 4, 8))      # 6 days out
    assert w["status"] == "harvest_watch", w
    m = detect(mid, "wheat", SOWN, today=date(2025, 3, 25))     # 20 days out
    assert m["status"] == "approaching_maturity", m

    # Long past the break -> post_harvest, which is what drives fallow detection.
    p = detect(real, "wheat", SOWN, today=date(2025, 7, 1))
    assert p["status"] == "post_harvest", p

    # Too few points must refuse rather than guess from three dots.
    few = detect(series([("2025-01-14", 0.365), ("2025-02-12", 0.454)]),
                 "wheat", SOWN, today=date(2025, 5, 25))
    assert few["status"] == "insufficient_data" and few["confidence"] == 0.0, few

    # Pixel-starved rows must not count toward the observation minimum.
    starved = [{"date": d, "ndvi": n, "valid_px": 2, "vh": None} for d, n in
               [("2025-01-14", 0.3), ("2025-02-12", 0.4), ("2025-03-14", 0.5),
                ("2025-04-08", 0.6), ("2025-05-06", 0.2), ("2025-05-18", 0.2)]]
    assert detect(starved, "wheat", SOWN, today=date(2025, 5, 25))["status"] \
        == "insufficient_data"

    # A farmer's confirmation outranks the imagery, even a contradicting curve.
    c = detect(real, "wheat", SOWN, today=date(2025, 5, 25), confirmed_date="2025-04-16")
    assert c["status"] == "harvest_confirmed" and c["confidence"] == 1.0, c
    assert c["estimated_harvest_date"] == "2025-04-16", c

    # An out-of-window break must be reported AND doubted, not silently trusted.
    early = series([
        ("2024-11-20", 0.21), ("2024-12-05", 0.60), ("2024-12-20", 0.18),
        ("2025-01-05", 0.17), ("2025-01-20", 0.16), ("2025-02-12", 0.16),
    ])
    e = detect(early, "wheat", SOWN, today=date(2025, 3, 1))
    assert e["estimated_harvest_date"] is not None, e
    assert any("further out than the crop calendar" in x for x in e["evidence"]), e
    assert e["confidence"] < 0.7, e["confidence"]

    # The confidence must never be describable as a probability.
    assert "NOT a calibrated probability" in r["confidence_basis"]

    print("harvest self-check OK (10 checks)")
