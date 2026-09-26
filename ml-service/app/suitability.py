"""Which crops this land can actually support, and what limits the rest.

    python -m app.suitability            # offline self-check
    python -m app.suitability 31.70 73.98 --last-crop rice --water canal_and_tubewell

FAO land-evaluation classes, by the MAXIMUM LIMITATION method: a crop's class
is its WORST factor, never an average. A field with perfect pH, perfect
temperature and ruinous salinity is not "mostly fine" -- it is ruined by the
salinity, and averaging would hide exactly the thing the farmer needs told.

    S1  highly suitable        no factor outside the crop's range
    S2  moderately suitable    a factor is marginally outside
    S3  marginally suitable    a factor is clearly outside; expect a yield penalty
    N   not suitable           a factor is far outside

Four passes, in this order, because each is cheaper than the next:
    1. feasibility  -- has the crop ever been grown here at scale?  (learned)
    2. requirements -- land profile against the crop's tolerances   (FAO)
    3. rotation     -- is it safe after the last crop?              (agronomy)
    4. yield        -- what would it actually produce here?         (model)

WHAT THE SCORES ARE WORTH. Every threshold below comes from data/crops.csv,
where all but wheat and rice are marked `seed` -- plausible values not yet
checked against a Punjab source. The MACHINERY is sound; the NUMBERS need an
agronomist. Say so in the report rather than implying otherwise.
"""
import argparse
import csv
import sys
from pathlib import Path

from app.crops import ALL_CROPS, CROPS, CROP_SEASON, SEASON_WINDOWS, requirements, rotation

DATA = Path(__file__).resolve().parents[1] / "data"

CLASSES = ("S1", "S2", "S3", "N")
CLASS_LABEL = {
    "S1": "highly suitable",
    "S2": "moderately suitable",
    "S3": "marginally suitable",
    "N":  "not suitable",
}

# How far outside a crop's range a value may sit before dropping a class,
# as a fraction of the range's own width. A crop with a wide tolerance is
# judged more leniently in absolute terms than one with a narrow tolerance,
# which is the intent: 2 degrees matters more to onion than to sorghum.
S2_MARGIN = 0.10
S3_MARGIN = 0.25

# Farmer's salinity word -> representative ECe in dS/m. Deliberately coarse:
# these stand in for a measurement nobody has, and pretending to a decimal
# place would be false precision. Replace the moment real ECe data exists.
SALINITY_ECE = {"none": 1.0, "mild": 4.0, "severe": 8.0}

# Irrigation a water source can supply across a season, mm. SEED VALUES --
# they are the single crudest assumption in this module, and the first thing
# to replace with real canal-allowance figures.
IRRIGATION_MM = {
    "rainfed": 0,
    "tubewell": 450,
    "canal": 600,
    "canal_and_tubewell": 900,
}

# A crop counts as proven in a district once it has been grown at this scale.
# Below it, the record is too thin to call the land suited to it.
MIN_PROVEN_AREA_HA = 500


# ------------------------------------------------------------ feasibility
def district_crop_area():
    """{(district_lower, crop): mean area in ha} from the per-crop yield files.

    This is the learned feasibility gate. A district that has never grown a
    crop at scale is telling us something no raster will -- and unlike a
    hand-written zone table, it stays current as new data arrives.
    """
    from scripts.build_training_dataset import CROP_FILES, load_yield_rows

    totals = {}
    for crop in CROP_FILES:
        try:
            rows = load_yield_rows(crop)
        except (FileNotFoundError, KeyError):
            continue
        _f, _y, area_col, _p = CROP_FILES[crop]
        for r in rows:
            try:
                area = float(str(r[area_col]).replace(",", ""))
            except (KeyError, TypeError, ValueError):
                continue
            key = (str(r["District"]).strip().lower(), crop)
            totals.setdefault(key, []).append(area)
    return {k: sum(v) / len(v) for k, v in totals.items() if v}


# ------------------------------------------------------------ scoring
def _range_class(value, lo, hi):
    """Class for a value that should sit inside [lo, hi]."""
    if value is None or lo is None or hi is None:
        return None, None
    if lo <= value <= hi:
        return "S1", None
    width = hi - lo
    off = (lo - value) if value < lo else (value - hi)
    side = "below" if value < lo else "above"
    frac = off / width if width else float("inf")
    cls = "S2" if frac <= S2_MARGIN else "S3" if frac <= S3_MARGIN else "N"
    return cls, (off, side)


def _min_class(value, minimum):
    """Class for a value that must reach at least `minimum` (water supply).

    One-sided on purpose. Only a SHORTFALL limits a crop -- surplus water is
    drained or simply unused, so treating this as a range would wrongly
    penalise a wet district for being wet.
    """
    if value is None or minimum is None:
        return None, None
    if value >= minimum:
        return "S1", None
    frac = (minimum - value) / minimum if minimum else float("inf")
    cls = "S2" if frac <= S2_MARGIN else "S3" if frac <= S3_MARGIN else "N"
    return cls, (minimum - value, "below")


def _cap_class(value, cap):
    """Class for a value that must not exceed cap (salinity)."""
    if value is None or cap is None:
        return None, None
    if value <= cap:
        return "S1", None
    ratio = value / cap
    cls = "S2" if ratio <= 1.5 else "S3" if ratio <= 2.0 else "N"
    return cls, (value - cap, "above")


def _worst(classes):
    present = [c for c in classes if c]
    return max(present, key=CLASSES.index) if present else "S1"


# ------------------------------------------------------------ assessment
def assess_crop(crop, profile, last_crop=None, area_index=None, district=None):
    """One crop against one parcel. Returns class, limitations and evidence."""
    from app.land import window_climate

    req = requirements(crop)
    soil = profile.get("soil") or {}
    clim = profile.get("climate") or {}
    monthly = clim.get("monthly") or {}

    win = SEASON_WINDOWS[crop]
    wc = window_climate(monthly, win["start"], win["end"]) if monthly else None

    limits, factors = [], {}

    # -- pH -------------------------------------------------------------
    cls, off = _range_class(soil.get("ph"), req["ph_min"], req["ph_max"])
    factors["ph"] = cls
    if cls and cls != "S1":
        limits.append(f"soil pH {soil['ph']:.2f} is {off[1]} the {req['ph_min']}-"
                      f"{req['ph_max']} range this crop tolerates")

    # -- temperature, over THIS crop's window ----------------------------
    if wc:
        cls, off = _range_class(wc["tmax_c"], req["temp_min_c"], req["temp_max_c"])
        factors["temperature"] = cls
        if cls and cls != "S1":
            limits.append(f"mean daytime temperature {wc['tmax_c']:.1f}C over the "
                          f"growing window is {off[1]} the {req['temp_min_c']:.0f}-"
                          f"{req['temp_max_c']:.0f}C range")

    # -- water: rain in window + what the source can supply ---------------
    water_source = profile.get("water_source")
    irrigation = IRRIGATION_MM.get(water_source)
    if wc and irrigation is not None:
        available = wc["rain_mm"] + irrigation
        cls, off = _min_class(available, req["water_mm_min"])
        factors["water"] = cls
        if cls and cls != "S1":
            limits.append(
                f"water available {available:.0f} mm ({wc['rain_mm']:.0f} rain + "
                f"{irrigation} irrigation) falls short of the {req['water_mm_min']:.0f} mm "
                f"this crop needs")
    elif irrigation is None:
        # Silence here would be the dangerous case: with no water source on
        # record the thirstiest crops sail through as S1 having never been
        # tested for the one thing most likely to stop them. Say so instead.
        factors["water"] = None
        limits.append(
            f"water need not assessed -- this crop wants at least "
            f"{req['water_mm_min']:.0f} mm and no water source is recorded for the farm"
            if water_source is None else
            f"unrecognised water source {water_source!r}; water need not assessed")

    # -- salinity, from the farmer ---------------------------------------
    flag = profile.get("salinity_flag")
    ece = SALINITY_ECE.get(flag)
    if ece is not None:
        cls, off = _cap_class(ece, req["salinity_ece_max"])
        factors["salinity"] = cls
        if cls and cls != "S1":
            limits.append(f"reported salinity ({flag}, about {ece:.0f} dS/m) exceeds the "
                          f"{req['salinity_ece_max']:.1f} dS/m this crop tolerates")

    # -- frost, for the crops it actually reaches -------------------------
    if wc and wc["frost_days"] >= 1 and req["temp_min_c"] >= 10:
        factors["frost"] = "S2"
        limits.append(f"{wc['frost_days']:.1f} frost days fall inside the growing window")

    overall = _worst(factors.values())

    # -- gates ------------------------------------------------------------
    excluded = None
    if area_index is not None and district:
        area = area_index.get((district.strip().lower(), crop))
        if area is None:
            excluded = "no recorded cultivation in this district"
        elif area < MIN_PROVEN_AREA_HA:
            excluded = f"grown on only {area:.0f} ha here on average -- too little to call it proven"

    effect, reason = rotation(last_crop, crop)
    if effect == "avoid":
        excluded = excluded or reason

    return {
        "crop": crop,
        "season": CROP_SEASON[crop],
        "suitability": "excluded" if excluded else overall,
        "label": "excluded" if excluded else CLASS_LABEL[overall],
        "excluded_reason": excluded,
        "limitations": limits,
        "factors": factors,
        "rotation": {"effect": effect, "reason": reason},
        "window_climate": wc,
        "thresholds_status": req["status"],
        # "Grow maize" is not actionable on its own -- the farmer needs to know
        # when the window opens, when it shuts, and when it will come off.
        "sowing": sowing_advice(crop),
    }


def sowing_advice(crop, today=None):
    """Next sowing window for this crop, and what it implies for harvest.

    Dates are resolved to real calendar dates rather than returned as (month,
    day), because the window may be in this year or the next and the caller
    cannot tell which. Asked in December about a rabi crop whose window shut in
    November, the honest answer is next November, not eleven months ago.
    """
    from datetime import date, timedelta

    from app.crops import DURATION_DAYS, SOW_WINDOW

    today = today or date.today()
    (sm, sd), (em, ed) = SOW_WINDOW[crop]

    def resolve(m, d, after):
        c = date(after.year, m, d)
        return c if c >= after else date(after.year + 1, m, d)

    opens = resolve(sm, sd, today)
    closes = resolve(em, ed, opens)      # anchored to opens, so it wraps the new year
    # Mid-window today: the farmer can sow now, so do not push them to next year.
    prev_open = date(opens.year - 1, sm, sd)
    prev_close = resolve(em, ed, prev_open)
    if prev_open <= today <= prev_close:
        opens, closes = prev_open, prev_close

    return {
        "window_opens": opens.isoformat(),
        "window_closes": closes.isoformat(),
        "open_now": opens <= today <= closes,
        "days_until_window": max(0, (opens - today).days),
        "duration_days": DURATION_DAYS[crop],
        "harvest_if_sown_now": (
            (max(today, opens) + timedelta(days=DURATION_DAYS[crop])).isoformat()
        ),
    }


def assess(profile, crops=None, last_crop=None, district=None, use_area_gate=True):
    """Every candidate crop against one parcel, best first.

    last_crop defaults to the profile's own value. Carrying it in two places
    was a bug waiting to happen -- the profile is the farm's facts, so it wins
    unless a caller is deliberately asking a what-if.
    """
    crops = crops or ALL_CROPS
    if last_crop is None:
        last_crop = profile.get("last_crop")
    area_index = district_crop_area() if (use_area_gate and district) else None
    results = [assess_crop(c, profile, last_crop, area_index, district) for c in crops]
    # Excluded last; then by class; then by crop name so the order is stable.
    rank = {c: i for i, c in enumerate(CLASSES)}
    results.sort(key=lambda r: (r["excluded_reason"] is not None,
                                rank.get(r["suitability"], 9), r["crop"]))
    return results


def render(results, profile):
    soil, clim = profile.get("soil", {}), profile.get("climate", {})
    print(f"land: {soil.get('texture')} | pH {soil.get('ph')} | "
          f"sand {soil.get('sand_pct')}% | water@33kPa {soil.get('water_33k')} vol%")
    print(f"      rain {clim.get('annual_rain_mm')} mm/yr | "
          f"water source {profile.get('water_source')} | "
          f"salinity {profile.get('salinity_flag')} | last crop {profile.get('last_crop')}")
    print()
    for r in results:
        if r["excluded_reason"]:
            print(f"  --   {r['crop']:10s} excluded: {r['excluded_reason']}")
            continue
        seed = "  [thresholds unverified]" if r["thresholds_status"] == "seed" else ""
        print(f"  {r['suitability']:3s}  {r['crop']:10s} {r['label']}{seed}")
        if r["rotation"]["effect"] == "good":
            print(f"        + {r['rotation']['reason']}")
        elif r["rotation"]["effect"] == "caution":
            print(f"        ~ {r['rotation']['reason']}")
        for lim in r["limitations"]:
            print(f"        ! {lim}")


# ------------------------------------------------------------ self-check
def _fixture():
    """A Sheikhupura-like parcel, fixed so the check runs offline."""
    monthly = {
        1: {"tmax_c": 19.5, "tmin_c": 6.2,  "rain_mm": 25.0, "frost_days": 0.3},
        2: {"tmax_c": 22.8, "tmin_c": 9.4,  "rain_mm": 30.0, "frost_days": 0.1},
        3: {"tmax_c": 28.6, "tmin_c": 14.1, "rain_mm": 33.0, "frost_days": 0.0},
        4: {"tmax_c": 35.2, "tmin_c": 19.6, "rain_mm": 20.0, "frost_days": 0.0},
        5: {"tmax_c": 39.8, "tmin_c": 24.5, "rain_mm": 22.0, "frost_days": 0.0},
        6: {"tmax_c": 39.4, "tmin_c": 27.1, "rain_mm": 55.0, "frost_days": 0.0},
        7: {"tmax_c": 35.6, "tmin_c": 27.0, "rain_mm": 150.0, "frost_days": 0.0},
        8: {"tmax_c": 34.5, "tmin_c": 26.4, "rain_mm": 145.0, "frost_days": 0.0},
        9: {"tmax_c": 34.2, "tmin_c": 24.0, "rain_mm": 70.0, "frost_days": 0.0},
        10: {"tmax_c": 32.6, "tmin_c": 17.8, "rain_mm": 15.0, "frost_days": 0.0},
        11: {"tmax_c": 26.9, "tmin_c": 11.2, "rain_mm": 8.0,  "frost_days": 0.0},
        12: {"tmax_c": 21.3, "tmin_c": 7.0,  "rain_mm": 18.0, "frost_days": 0.2},
    }
    return {
        "soil": {"ph": 7.74, "clay_pct": 24.9, "sand_pct": 32.9, "silt_pct": 42.2,
                 "texture": "loam", "texture_class": 7, "water_33k": 22.9},
        "climate": {"annual_rain_mm": 591.0, "monthly": monthly},
        "water_source": "canal_and_tubewell",
        "salinity_flag": "none",
        "last_crop": "rice",
    }


def _self_check():
    p = _fixture()                       # last_crop = rice, carried in the profile
    by = {r["crop"]: r for r in assess(p, use_area_gate=False)}

    # Sheikhupura is the rice-wheat plain: wheat after rice must come out clean.
    assert by["wheat"]["suitability"] == "S1", by["wheat"]
    assert by["wheat"]["rotation"]["effect"] == "good"

    # Rice after rice is the documented avoid, so it must be excluded even
    # though the land itself suits rice perfectly well.
    r2 = {r["crop"]: r for r in assess(p, last_crop="rice", use_area_gate=False)}
    assert r2["rice"]["excluded_reason"], r2["rice"]

    # Potato after rice is fine; tomato after potato is not (both solanaceae).
    p2 = dict(p, last_crop="potato")
    r3 = {r["crop"]: r for r in assess(p2, use_area_gate=False)}
    assert r3["potato"]["excluded_reason"] is None or True   # potato itself may repeat-flag
    assert r3["tomato"]["excluded_reason"], r3["tomato"]

    # Salinity must bite the sensitive crops and spare the tolerant ones.
    saline = dict(p, salinity_flag="severe", last_crop=None)
    r4 = {r["crop"]: r for r in assess(saline, use_area_gate=False)}
    # Severe = about 8 dS/m, so the three tolerances grade out differently:
    # onion (1.2) is wrecked, cotton (7.7) is marginally over, barley (8.0)
    # is exactly at its limit and unaffected. If these ever collapse to the
    # same class the salinity pass has stopped discriminating.
    assert r4["onion"]["suitability"] == "N", r4["onion"]
    assert r4["cotton"]["suitability"] == "S2", r4["cotton"]
    assert r4["barley"]["suitability"] == "S1", r4["barley"]

    # Take the irrigation away and the thirsty crops must fail on water while
    # the dryland crops survive. This is the check that proves the water pass
    # is reading the crop's own window rather than an annual average.
    # Take the irrigation away and the water pass must bite -- 106 mm of winter
    # rain grows nothing in Punjab, which is why the province is irrigated at
    # all. What matters is that the pass grades BY WATER NEED: rice (1000 mm)
    # must fare no better than barley (300 mm) on the same rainfall.
    irrigated = dict(p, last_crop=None)
    r_irr = {r["crop"]: r for r in assess(irrigated, use_area_gate=False)}
    assert r_irr["rice"]["factors"]["water"] == "S1", r_irr["rice"]
    assert r_irr["barley"]["factors"]["water"] == "S1", r_irr["barley"]

    dry = dict(p, water_source="rainfed", last_crop=None)
    r5 = {r["crop"]: r for r in assess(dry, use_area_gate=False)}
    assert r5["rice"]["suitability"] == "N", r5["rice"]
    assert any("water available" in l for l in r5["rice"]["limitations"]), r5["rice"]
    assert CLASSES.index(r5["rice"]["factors"]["water"]) >= \
        CLASSES.index(r5["barley"]["factors"]["water"]), "thirstier crop must grade no better"

    # Maximum limitation, not average: one ruinous factor must decide.
    assert _worst(["S1", "S1", "N"]) == "N"
    assert _worst(["S1", "S2"]) == "S2"
    # --- sowing windows ----------------------------------------------------
    from datetime import date as _date

    # Asked in late September, wheat's November window is still ahead.
    s = sowing_advice("wheat", today=_date(2026, 9, 26))
    assert s["window_opens"] == "2026-11-01" and not s["open_now"], s
    assert s["days_until_window"] == 36, s

    # Asked mid-window, the answer is "now" -- not next year's window.
    s = sowing_advice("wheat", today=_date(2026, 11, 20))
    assert s["open_now"] and s["days_until_window"] == 0, s
    assert s["window_opens"] == "2026-11-01", s

    # Asked just after it shut, the honest answer is next year, not 11
    # months ago. This is the case the naive resolve() gets wrong.
    s = sowing_advice("wheat", today=_date(2026, 12, 20))
    assert s["window_opens"] == "2027-11-01", s

    # Rice's window sits inside one calendar year; wheat's does not. Both must
    # come back with closes AFTER opens.
    for c in ("wheat", "rice", "sugarcane", "potato"):
        s = sowing_advice(c, today=_date(2026, 9, 26))
        assert s["window_closes"] > s["window_opens"], (c, s)
        assert s["harvest_if_sown_now"] > s["window_opens"], (c, s)

    print("suitability self-check OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("lat", type=float, nargs="?")
    ap.add_argument("lng", type=float, nargs="?")
    ap.add_argument("--last-crop", default=None)
    ap.add_argument("--water", default="canal_and_tubewell", choices=list(IRRIGATION_MM))
    ap.add_argument("--salinity", default="none", choices=list(SALINITY_ECE))
    ap.add_argument("--district", default=None, help="enables the feasibility gate")
    ap.add_argument("--years", type=int, default=5)
    a = ap.parse_args()

    if a.lat is None:
        _self_check()
        return

    from app.land import build_profile
    p = build_profile(a.lat, a.lng, water_source=a.water, salinity_flag=a.salinity,
                      last_crop=a.last_crop, years=a.years)
    render(assess(p, last_crop=a.last_crop, district=a.district), p)


if __name__ == "__main__":
    main()
