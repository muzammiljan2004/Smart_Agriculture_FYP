"""Soil and growing-season weather for every district-season in the training set.

    python -m scripts.fetch_district_land --dry-run
    python -m scripts.fetch_district_land            # resumable

Produces two files, deliberately separate because they are different KINDS of
feature and an examiner should be able to see which is which:

    data/district_soil.csv            one row per district. STATIC.
    data/district_season_weather.csv  one row per district-season-crop. VARIES.

WHY THE SPLIT MATTERS. Soil never changes between seasons, so a model handed
district soil can score well by memorising "Sheikhupura yields about 3.4" while
learning nothing about the land. It is a district fingerprint wearing a
scientific-looking name. Ordinary cross-validation rewards exactly that,
because the same district appears in train and test; GroupKFold, which holds
whole districts out, is what exposes it. Both numbers get reported.

Season weather is the opposite: the same district reads differently in 2021-22
than in 2022-23, so it carries real information about why a yield moved. March
2022's heat is a fact about that season, not about Sheikhupura.

Weather is sampled over EACH CROP'S OWN WINDOW, via app.crops.season_window --
the same window the satellite composite used. Sampling a fixed calendar year
instead would average a wheat crop's February with a June it never experiences.
"""
import argparse
import csv
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from app.crops import season_window
from app.gee import DistrictNotFound, get_district_geometry, init
from app.land import FROST_C, SOIL_LAYERS, ROOT_ZONE_BANDS, TEXTURE_ASSET, SOIL_SCALE

DATA = Path(__file__).resolve().parents[1] / "data"
TRAIN_CSV = DATA / "training_data_real.csv"
SOIL_CSV = DATA / "district_soil.csv"
WEATHER_CSV = DATA / "district_season_weather.csv"

ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
DELAY_SECONDS = 0.4          # courtesy gap; the archive API is free and unmetered
MAX_RETRIES = 3

SOIL_FIELDS = ["district", "ph", "clay_pct", "silt_pct", "sand_pct",
               "texture_class", "bulk_dens", "water_33k", "soc_raw"]
WEATHER_FIELDS = ["district", "season", "crop_type", "start", "end",
                  "tmax_mean_c", "tmin_mean_c", "tmax_peak_c",
                  "rain_mm", "frost_days", "hot_days_35c"]

# Reported as a count of days above a fixed line rather than only a mean,
# because a mean hides the thing that actually destroys a wheat crop: a short
# spike during grain filling. March 2022 was not a warm season on average.
HOT_DAY_C = 35.0


def training_rows():
    if not TRAIN_CSV.exists():
        sys.exit(f"missing {TRAIN_CSV}. Run: python -m scripts.build_training_dataset")
    with TRAIN_CSV.open(newline="", encoding="utf-8-sig") as fh:
        return [r for r in csv.DictReader(fh) if r.get("district")]


def done_keys(path, keys):
    if not path.exists():
        return set()
    with path.open(newline="", encoding="utf-8-sig") as fh:
        return {tuple(r[k] for k in keys) for r in csv.DictReader(fh) if r.get(keys[0])}


def append(path, fields, row):
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        if new:
            w.writeheader()
        w.writerow(row)


# ------------------------------------------------------------------ soil
def district_soil(district):
    """Mean soil properties over the whole district polygon.

    Reduced over the district rather than a centroid point, to match the scale
    the satellite features were built at. A centroid could land on the one
    saline patch or the one town in the district and speak for none of it.
    """
    import ee

    geom = get_district_geometry(district)
    img = ee.Image.cat([
        ee.Image(asset).select(ROOT_ZONE_BANDS).reduce(ee.Reducer.mean()).rename(name)
        for name, asset in SOIL_LAYERS.items()
    ])
    raw = img.reduceRegion(ee.Reducer.mean(), geom, SOIL_SCALE, maxPixels=1e9).getInfo()
    # Categorical, so modal class -- never a mean. See app/land.py.
    tex = (ee.Image(TEXTURE_ASSET).select("b10").rename("texture_class")
           .reduceRegion(ee.Reducer.mode(), geom, SOIL_SCALE, maxPixels=1e9)
           .getInfo().get("texture_class"))

    if raw.get("ph") is None:
        raise LookupError(f"no soil coverage over {district}")

    ph = raw["ph"] * 0.1
    clay, sand = raw["clay_pct"], raw["sand_pct"]
    return {
        "district": district,
        "ph": round(ph, 3),
        "clay_pct": round(clay, 3),
        "sand_pct": round(sand, 3),
        "silt_pct": round(100.0 - clay - sand, 3),
        "texture_class": int(round(tex)) if tex is not None else "",
        "bulk_dens": round(raw["bulk_dens"] * 0.01, 4),
        "water_33k": round(raw["water_33k"], 3),
        "soc_raw": round(raw["soc"], 4),      # RAW: scale direction unverified
    }


# --------------------------------------------------------------- weather
def _get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "smart-agriculture-fyp/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def window_weather(lat, lng, start, end):
    url = (f"{ARCHIVE}?latitude={lat}&longitude={lng}"
           f"&start_date={start}&end_date={end}"
           "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum"
           "&timezone=Asia%2FKarachi")
    for attempt in range(MAX_RETRIES):
        try:
            d = _get(url)["daily"]
            break
        except (urllib.error.URLError, TimeoutError, KeyError, OSError):
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(2 ** attempt)

    tmax = [v for v in d["temperature_2m_max"] if v is not None]
    tmin = [v for v in d["temperature_2m_min"] if v is not None]
    rain = [v for v in d["precipitation_sum"] if v is not None]
    if not tmax:
        raise LookupError(f"no weather for {start}..{end}")
    return {
        "tmax_mean_c": round(sum(tmax) / len(tmax), 3),
        "tmin_mean_c": round(sum(tmin) / len(tmin), 3),
        "tmax_peak_c": round(max(tmax), 2),
        "rain_mm": round(sum(rain), 1),
        "frost_days": sum(1 for v in tmin if v < FROST_C),
        "hot_days_35c": sum(1 for v in tmax if v > HOT_DAY_C),
    }


def district_centroid(district):
    import ee
    c = get_district_geometry(district).centroid(maxError=1000).coordinates().getInfo()
    return c[1], c[0]          # ee gives [lng, lat]; everything else wants lat first


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()

    rows = training_rows()
    districts = sorted({r["district"] for r in rows})
    pairs = sorted({(r["district"], r["season"], (r.get("crop_type") or "wheat"))
                    for r in rows})

    soil_done = {k[0] for k in done_keys(SOIL_CSV, ["district"])}
    weather_done = done_keys(WEATHER_CSV, ["district", "season", "crop_type"])

    todo_soil = [d for d in districts if d not in soil_done]
    todo_weather = [p for p in pairs if p not in weather_done]

    print(f"training rows      : {len(rows)}")
    print(f"districts          : {len(districts)}  ({len(todo_soil)} to fetch)")
    print(f"district-seasons   : {len(pairs)}  ({len(todo_weather)} to fetch)")
    if a.dry_run:
        for d, s, c in todo_weather[:5]:
            st, en = season_window(c, s)
            print(f"   e.g. {d} {s} {c} -> {st}..{en}")
        print("\n--dry-run: nothing fetched")
        return

    if todo_soil:
        init()
        centroids = {}
        for i, d in enumerate(todo_soil[: a.limit] if a.limit else todo_soil, 1):
            try:
                append(SOIL_CSV, SOIL_FIELDS, district_soil(d))
                print(f"  soil [{i}/{len(todo_soil)}] {d}")
            except (DistrictNotFound, LookupError) as e:
                print(f"  soil [{i}/{len(todo_soil)}] {d}: SKIP {e}")
            time.sleep(DELAY_SECONDS)

    if todo_weather:
        init()
        centroids = {}
        todo = todo_weather[: a.limit] if a.limit else todo_weather
        for i, (d, s, c) in enumerate(todo, 1):
            try:
                if d not in centroids:
                    centroids[d] = district_centroid(d)
                lat, lng = centroids[d]
                st, en = season_window(c, s)
                w = window_weather(lat, lng, st, en)
                append(WEATHER_CSV, WEATHER_FIELDS,
                       {"district": d, "season": s, "crop_type": c,
                        "start": st, "end": en, **w})
                print(f"  wx [{i}/{len(todo)}] {d} {s} {c}  "
                      f"tmax {w['tmax_mean_c']:.1f}C peak {w['tmax_peak_c']:.0f}C "
                      f"rain {w['rain_mm']:.0f}mm hot {w['hot_days_35c']}d")
            except (DistrictNotFound, LookupError, urllib.error.URLError, OSError) as e:
                print(f"  wx [{i}/{len(todo)}] {d} {s} {c}: SKIP {e}")
            time.sleep(DELAY_SECONDS)

    print("\ndone.")


if __name__ == "__main__":
    main()
