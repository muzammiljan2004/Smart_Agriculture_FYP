"""Forward-looking weather hazards, scored against the crop's growth stage.

    python -m app.weather                      # offline self-check
    python -m app.weather 31.70 73.98 wheat    # live forecast for a farm

WHY STAGE MATTERS MORE THAN WEATHER. A 41C day during tillering is something
wheat shrugs off. The same day during grain filling is the single biggest
cause of yield loss in Punjab -- it is what happened in March 2022. "It will
be hot" is a weather report; "it will be hot while your grain is filling, so
irrigate first" is advice. Only the second is worth an email.

HOW THE TABLE STAYS SMALL. Enumerating 14 crops x 6 stages x 4 hazards would
be 336 rules nobody maintains. Instead every stage maps to one of five
SENSITIVITY CLASSES, and the rules are written against those -- 17 rows in
data/hazard_rules.csv, and a crop added tomorrow is covered the moment its
stages are named.

FORECAST, NOT HISTORY. Open-Meteo gives 16 days ahead, free and without a key.
Telling a farmer last week was hot is useless; the whole value is the warning
arriving while there is still time to irrigate.
"""
import argparse
import csv
import json
import urllib.error
import urllib.request
from datetime import timedelta
from pathlib import Path

from app.crops import CROP_ROWS, STAGES, requirements

DATA = Path(__file__).resolve().parents[1] / "data"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_DAYS = 16

# Counted as days above a line rather than folded into a mean, because a mean
# hides the thing that actually destroys a wheat crop: a short spike during
# grain filling. March 2022 was not a warm season on average.
HOT_DAY_C = 35.0
FROST_C = 2.0


def summarise_daily(tmax, tmin, rain):
    """The six season-weather model features, from daily series.

    THE SINGLE DEFINITION. scripts/fetch_district_land.py builds the training
    columns through this function and app/main.py builds the inference row
    through it, so the two cannot drift. Duplicating the arithmetic would be
    the classic train/serve skew: both sides look right in isolation and the
    model quietly scores against a differently-computed feature.
    """
    tmax = [v for v in tmax if v is not None]
    tmin = [v for v in tmin if v is not None]
    rain = [v for v in rain if v is not None]
    if not tmax:
        raise LookupError("no daily temperatures in window")
    return {
        "tmax_mean_c": round(sum(tmax) / len(tmax), 3),
        "tmin_mean_c": round(sum(tmin) / len(tmin), 3),
        "tmax_peak_c": round(max(tmax), 2),
        "rain_mm": round(sum(rain), 1),
        "frost_days": sum(1 for v in tmin if v < FROST_C),
        "hot_days_35c": sum(1 for v in tmax if v > HOT_DAY_C),
    }


def season_weather(lat, lng, start, end, timeout=60):
    """Observed weather over one growing window, for the model's input row.

    Returns the summary plus `complete`, which matters more than it looks.
    Training rows were built from finished seasons; a farmer asking in
    February has a window that runs to April, and the archive can only answer
    to today. The partial answer is not wrong so much as differently scaled --
    rain_mm and hot_days_35c are cumulative, so a half-finished season reports
    roughly half of each and the model reads it as a dry, mild year.

    So the shortfall is reported rather than hidden, and the caller decides.
    """
    from datetime import date

    today = date.today()
    end_d = date.fromisoformat(end)
    # The archive lags real time by about five days; asking past it returns
    # nulls, which summarise_daily would then average over a shorter series
    # without saying so.
    capped = min(end_d, today - timedelta(days=5))
    if capped < date.fromisoformat(start):
        raise LookupError(f"window {start}..{end} has not started yet")

    url = (f"{ARCHIVE_URL}?latitude={lat}&longitude={lng}"
           f"&start_date={start}&end_date={capped.isoformat()}"
           "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum"
           "&timezone=Asia%2FKarachi")
    req = urllib.request.Request(url, headers={"User-Agent": "smart-agriculture-fyp/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read().decode())["daily"]

    out = summarise_daily(d["temperature_2m_max"], d["temperature_2m_min"],
                          d["precipitation_sum"])
    total = (end_d - date.fromisoformat(start)).days + 1
    have = (capped - date.fromisoformat(start)).days + 1
    out["complete"] = capped >= end_d
    out["days_covered"] = have
    out["days_in_window"] = total
    return out

# Every stage name in data/crop_stages.csv, mapped to how the crop responds to
# stress while it is in that stage. Exact names rather than keyword matching:
# the self-check asserts the mapping is total, so a new stage name fails loudly
# instead of silently defaulting to "resilient".
STAGE_CLASS = {
    # the crop is not up yet
    "Sowing": "sowing", "Planting": "sowing", "Transplanting": "sowing",
    "Germination": "sowing",
    # building leaf and stem; damage here can still be grown out of
    "Emergence": "vegetative", "Establishment": "vegetative",
    "Seedling": "vegetative", "Tillering": "vegetative",
    "Vegetative": "vegetative", "Jointing": "vegetative",
    "Booting": "vegetative", "Grand growth": "vegetative",
    # setting the yield: the most stress-sensitive window in the whole season
    "Heading": "reproductive", "Panicle initiation": "reproductive",
    "Tasseling": "reproductive", "Silking": "reproductive",
    "Flowering": "reproductive", "Squaring": "reproductive",
    "Fruit set": "reproductive", "Tuber initiation": "reproductive",
    "Bulb initiation": "reproductive",
    # filling the harvestable part
    "Grain filling": "filling", "Boll development": "filling",
    "Tuber bulking": "filling", "Bulb development": "filling",
    "Maturation": "filling",
    # mature, and now vulnerable to weather in a different way
    "Harvest": "harvest", "First picking": "harvest",
}

FROST_C = 2.0            # air frost at screen height; damage starts here
RAIN_MM = 25.0           # over the lookahead window, enough to stop a harvest
WIND_GUST_KMH = 60.0     # lodging threshold for a standing cereal
LOOKAHEAD_DAYS = 7       # how far out a hazard is worth acting on

# Lodging needs a tall stem. Rather than a new column, this reads the family
# already in crops.csv: the grasses are the crops that go over in a gale.
LODGING_FAMILIES = {"poaceae"}


def _rules():
    with (DATA / "hazard_rules.csv").open(newline="", encoding="utf-8-sig") as fh:
        return {(r["hazard"], r["stage_class"]): (r["severity"], r["action"])
                for r in csv.DictReader(fh) if r.get("hazard")}


RULES = _rules()


# ---------------------------------------------------------------- forecast
def forecast(lat, lng, days=FORECAST_DAYS, timeout=60):
    """Daily forecast at one point. No API key, no quota to manage."""
    url = (f"{FORECAST_URL}?latitude={lat}&longitude={lng}"
           "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,"
           "wind_gusts_10m_max"
           f"&forecast_days={days}&timezone=Asia%2FKarachi")
    req = urllib.request.Request(url, headers={"User-Agent": "smart-agriculture-fyp/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())["daily"]


# ---------------------------------------------------------------- hazards
def detect(daily, crop, stage, lookahead=LOOKAHEAD_DAYS):
    """Hazards in the next `lookahead` days, scored for this crop and stage.

    `daily` is whatever forecast() returned, so this stays testable without a
    network call.
    """
    stage_class = STAGE_CLASS.get(stage)
    if stage_class is None:
        # Not a stage we know how to score. Saying nothing beats guessing.
        return []

    req = requirements(crop)
    frost_sensitive = CROP_ROWS[crop].get("frost_sensitive") == "yes"
    lodges = req["family"] in LODGING_FAMILIES

    n = min(lookahead, len(daily["time"]))
    days = daily["time"][:n]
    tmax = daily["temperature_2m_max"][:n]
    tmin = daily["temperature_2m_min"][:n]
    rain = daily["precipitation_sum"][:n]
    gust = daily.get("wind_gusts_10m_max", [None] * n)[:n]

    found = []

    def add(hazard, detail, when):
        hit = RULES.get((hazard, stage_class))
        if not hit:
            return                      # this hazard does not matter at this stage
        severity, action = hit
        found.append({
            "type": f"weather_{hazard}",
            "hazard": hazard,
            "severity": severity,
            "stage": stage,
            "stage_class": stage_class,
            "when": when,
            "message": f"{detail} {action}.",
        })

    # -- heat: against the crop's OWN ceiling, not one global number --------
    hot = [(d, t) for d, t in zip(days, tmax) if t is not None and t > req["temp_max_c"]]
    if hot:
        d, t = max(hot, key=lambda x: x[1])
        add("heat",
            f"{t:.0f}C forecast on {d}, above the {req['temp_max_c']:.0f}C {crop} tolerates, "
            f"while the crop is at {stage.lower()}.", d)

    # -- frost: only for the crops it actually harms -----------------------
    if frost_sensitive:
        cold = [(d, t) for d, t in zip(days, tmin) if t is not None and t < FROST_C]
        if cold:
            d, t = min(cold, key=lambda x: x[1])
            add("frost",
                f"{t:.0f}C forecast on {d}. {crop.capitalize()} is frost-sensitive and is "
                f"at {stage.lower()}.", d)

    # -- rain: total over the window, not a single wet day -----------------
    total = sum(v for v in rain if v is not None)
    if total > RAIN_MM:
        add("rain",
            f"{total:.0f} mm of rain forecast over the next {n} days while the crop is "
            f"at {stage.lower()}.", days[0] if days else None)

    # -- wind: lodging, for standing cereals only --------------------------
    if lodges:
        windy = [(d, g) for d, g in zip(days, gust) if g is not None and g > WIND_GUST_KMH]
        if windy:
            d, g = max(windy, key=lambda x: x[1])
            add("wind", f"Gusts to {g:.0f} km/h forecast on {d}, enough to lodge a "
                        f"standing {crop} crop.", d)

    return found


def for_farm(lat, lng, crop, stage, lookahead=LOOKAHEAD_DAYS):
    """Live hazards for one farm. Returns [] rather than raising if the API is down.

    A weather outage must not take the dashboard down with it -- the rest of
    the page is still useful, and a missing alert is better than a 500.
    """
    try:
        daily = forecast(lat, lng)
    except (urllib.error.URLError, TimeoutError, KeyError, OSError, ValueError):
        return []
    return detect(daily, crop, stage, lookahead)


# ---------------------------------------------------------------- checks
def _fixture(tmax, tmin, rain, gust=None, n=7):
    days = [f"2026-03-{d:02d}" for d in range(1, n + 1)]
    return {"time": days,
            "temperature_2m_max": [tmax] * n,
            "temperature_2m_min": [tmin] * n,
            "precipitation_sum": [rain] * n,
            "wind_gusts_10m_max": [gust if gust is not None else 10.0] * n}


def _self_check():
    # every stage in the registry must be classifiable, or a crop added later
    # silently stops being scored
    unmapped = {s for stages in STAGES.values() for s, _ in stages} - set(STAGE_CLASS)
    assert not unmapped, f"stages with no sensitivity class: {sorted(unmapped)}"
    # and every class must have at least one rule, or the mapping is decorative
    classes = set(STAGE_CLASS.values())
    covered = {sc for _h, sc in RULES}
    assert classes <= covered, f"classes with no rules: {sorted(classes - covered)}"

    heat = _fixture(tmax=41.0, tmin=20.0, rain=0.0)

    # THE point of this module: same weather, same crop, different stage.
    tiller = detect(heat, "wheat", "Tillering")
    filling = detect(heat, "wheat", "Grain filling")
    assert tiller[0]["severity"] == "info", tiller
    assert filling[0]["severity"] == "critical", filling
    assert "irrigate" in filling[0]["message"].lower()

    # Heat is judged against the crop's OWN ceiling, not one global number.
    # 35C ruins wheat (ceiling 30) and is an ordinary day for cotton (40).
    warm = _fixture(tmax=35.0, tmin=20.0, rain=0.0)
    assert any(h["hazard"] == "heat" for h in detect(warm, "wheat", "Grain filling")), \
        "35C must exceed wheat's 30C ceiling"
    assert not any(h["hazard"] == "heat" for h in detect(warm, "cotton", "Boll development")), \
        "35C is well within cotton's 40C ceiling"

    # frost only fires for the crops it harms
    cold = _fixture(tmax=18.0, tmin=-1.0, rain=0.0)
    assert any(h["hazard"] == "frost" for h in detect(cold, "potato", "Tuber bulking"))
    assert not any(h["hazard"] == "frost" for h in detect(cold, "wheat", "Grain filling")), \
        "wheat is frost-tolerant and must not be alerted"

    # rain at harvest is critical; the same rain while growing is not
    wet = _fixture(tmax=30.0, tmin=18.0, rain=8.0)      # 56 mm over 7 days
    at_harvest = [h for h in detect(wet, "wheat", "Harvest") if h["hazard"] == "rain"]
    at_veg = [h for h in detect(wet, "wheat", "Tillering") if h["hazard"] == "rain"]
    assert at_harvest[0]["severity"] == "critical", at_harvest
    assert at_veg[0]["severity"] == "info", at_veg

    # lodging is for grasses; a tomato does not lodge
    gale = _fixture(tmax=30.0, tmin=18.0, rain=0.0, gust=75.0)
    assert any(h["hazard"] == "wind" for h in detect(gale, "wheat", "Harvest"))
    assert not any(h["hazard"] == "wind" for h in detect(gale, "tomato", "First picking"))

    # quiet weather must stay quiet, or the farmer learns to ignore the feature
    calm = _fixture(tmax=24.0, tmin=12.0, rain=1.0)
    assert detect(calm, "wheat", "Grain filling") == []

    print("weather self-check OK")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("lat", type=float, nargs="?")
    ap.add_argument("lng", type=float, nargs="?")
    ap.add_argument("crop", nargs="?")
    ap.add_argument("--stage", default=None, help="default: every stage of the crop")
    a = ap.parse_args()

    if a.lat is None:
        _self_check()
        return

    daily = forecast(a.lat, a.lng)
    print(f"{a.crop} at {a.lat},{a.lng} -- next {LOOKAHEAD_DAYS} days")
    print(f"  tmax {max(t for t in daily['temperature_2m_max'][:7] if t is not None):.0f}C  "
          f"tmin {min(t for t in daily['temperature_2m_min'][:7] if t is not None):.0f}C  "
          f"rain {sum(v for v in daily['precipitation_sum'][:7] if v is not None):.0f} mm")
    stages = [a.stage] if a.stage else [s for s, _ in STAGES[a.crop]]
    for st in stages:
        hits = detect(daily, a.crop, st)
        if not hits:
            print(f"  {st:20s} clear")
        for h in hits:
            print(f"  {st:20s} [{h['severity']:8s}] {h['message']}")


if __name__ == "__main__":
    main()
