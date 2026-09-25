"""Land profile: what one farm's parcel offers, from free global rasters.

    python -m app.land 31.70 73.98        # LAT first, then LNG

Soil comes from OpenLandMap and climate from Open-Meteo. Both are free and
global; neither needs a key beyond the Earth Engine credentials already set up.

WHY NOT SOILGRIDS. SoilGrids is the better-known dataset and was the first
choice, but both its REST service and the community Earth Engine mirror return
null across Pakistan and Indian Punjab while returning values for Europe and
North America -- a coverage gap over exactly the region this project needs.
Verified at four Punjab points on both routes before switching. OpenLandMap is
in the official Earth Engine catalog, is global at 250 m, and returns sensible
values here: pH 7.7-8.2 alkaline, and the sand fraction rising toward Bhakkar
and Rahim Yar Khan as the Thal and Cholistan sands begin.

WHAT IS MISSING. Salinity. No free global raster carries ECe, and in southern
Punjab salinity is often what actually decides whether a crop is growable. The
farmer is asked instead -- they know their own problem patches better than a
250 m raster would anyway. See SALINITY_SOURCE below.
"""
import argparse
import json
import statistics
import urllib.error
import urllib.request

import ee

from app.gee import init as _ensure_init

# OpenLandMap soil layers. Band names are depths in cm; b0/b10/b30 together
# cover the 0-30 cm root zone that annual crops actually occupy.
SOIL_LAYERS = {
    "ph":        "OpenLandMap/SOL/SOL_PH-H2O_USDA-4C1A2A_M/v02",
    "clay_pct":  "OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02",
    "sand_pct":  "OpenLandMap/SOL/SOL_SAND-WFRACTION_USDA-3A1A1A_M/v02",
    "soc":       "OpenLandMap/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02",
    "bulk_dens": "OpenLandMap/SOL/SOL_BULKDENS-FINEEARTH_USDA-4A1H_M/v02",
    "water_33k": "OpenLandMap/SOL/SOL_WATERCONTENT-33KPA_USDA-4B1C_M/v02",
}
ROOT_ZONE_BANDS = ["b0", "b10", "b30"]
TEXTURE_ASSET = "OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02"

# USDA texture triangle classes, as OpenLandMap codes them.
TEXTURE_CLASSES = {
    1: "clay", 2: "silty clay", 3: "sandy clay", 4: "clay loam",
    5: "silty clay loam", 6: "sandy clay loam", 7: "loam", 8: "silt loam",
    9: "sandy loam", 10: "silt", 11: "loamy sand", 12: "sand",
}

# Stored value -> physical value. Getting one of these backwards is the classic
# way to poison a whole dataset, so each is named rather than inlined.
SCALING = {
    "ph":        (0.1,  "pH"),        # stored as pH*10
    "clay_pct":  (1.0,  "%"),
    "sand_pct":  (1.0,  "%"),
    "bulk_dens": (0.01, "g/cm3"),     # stored as g/cm3 * 100
    "water_33k": (1.0,  "vol%"),      # water held at field capacity
}
# soc is deliberately absent from SCALING: see SOC_UNIT_UNVERIFIED.
SOC_UNIT_UNVERIFIED = (
    "OpenLandMap organic carbon carries a scale factor of 5 and the direction "
    "is not documented unambiguously. Raw values over Punjab are 1-2, which is "
    "1-2 g/kg if divided and 5-10 g/kg if multiplied; typical Punjab topsoil is "
    "3-8 g/kg, so multiplication is the likelier reading. Reported RAW and left "
    "out of every threshold until someone checks it against a soil report."
)

SALINITY_SOURCE = "farmer-declared"   # no free raster carries ECe -- see docstring

BUFFER_M = 500          # a farm-sized footprint, not a single 250 m pixel
SOIL_SCALE = 250        # native resolution of every layer above

OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
CLIMATE_YEARS = 10      # WMO normals want 30; 10 is what the archive covers well
FROST_C = 2.0           # tmin below this damages potato and the solanaceous crops


# --------------------------------------------------------------- soil
def check_coords(lat, lng):
    """Reject a swapped lat/lng pair with a message that says so.

    Earth Engine takes longitude FIRST and almost everything else takes
    latitude first, so the two get transposed constantly. Punjab at (73.98,
    31.70) lands in the Arctic Ocean, where the rasters are empty -- which
    surfaces as "no soil coverage" and sends you hunting a data problem that
    does not exist. Caught here instead.
    """
    lat, lng = float(lat), float(lng)
    if not (-90 <= lat <= 90):
        raise ValueError(f"latitude {lat} is out of range; arguments are (lat, lng)")
    if not (-180 <= lng <= 180):
        raise ValueError(f"longitude {lng} is out of range; arguments are (lat, lng)")
    if not (23 <= lat <= 38 and 60 <= lng <= 78) and (23 <= lng <= 38 and 60 <= lat <= 78):
        raise ValueError(
            f"({lat}, {lng}) is outside Pakistan but ({lng}, {lat}) is inside it -- "
            f"the arguments look swapped. This function takes (lat, lng)."
        )
    return lat, lng


def soil_profile(lat, lng):
    """Root-zone soil properties at one point, averaged over 0-30 cm."""
    lat, lng = check_coords(lat, lng)
    _ensure_init()
    pt = ee.Geometry.Point(float(lng), float(lat)).buffer(BUFFER_M)

    # Two reductions, not one. Texture is a CATEGORICAL class code, so it takes
    # the modal class -- averaging class numbers would be nonsense (the mean of
    # clay=1 and loam=7 is 4, "silty clay loam", a texture neither pixel has).
    # Folding it into the continuous stack also made the whole reduceRegion
    # return nulls, because the categorical layer does not share the others'
    # projection.
    img = ee.Image.cat([
        ee.Image(asset).select(ROOT_ZONE_BANDS).reduce(ee.Reducer.mean()).rename(name)
        for name, asset in SOIL_LAYERS.items()
    ])
    raw = img.reduceRegion(ee.Reducer.mean(), pt, SOIL_SCALE).getInfo()
    if all(v is None for v in raw.values()):
        raise LookupError(f"no soil coverage at {lat},{lng}")

    raw["texture_class"] = (
        ee.Image(TEXTURE_ASSET).select("b10").rename("texture_class")
        .reduceRegion(ee.Reducer.mode(), pt, SOIL_SCALE).getInfo().get("texture_class")
    )

    out = {}
    for name, (factor, _unit) in SCALING.items():
        v = raw.get(name)
        out[name] = round(v * factor, 3) if v is not None else None

    out["soc_raw"] = round(raw["soc"], 3) if raw.get("soc") is not None else None
    out["soc_note"] = SOC_UNIT_UNVERIFIED

    cls = raw.get("texture_class")
    out["texture_class"] = int(round(cls)) if cls is not None else None
    out["texture"] = TEXTURE_CLASSES.get(out["texture_class"])
    # silt is the remainder: the three fractions are defined to sum to 100.
    if out["clay_pct"] is not None and out["sand_pct"] is not None:
        out["silt_pct"] = round(100.0 - out["clay_pct"] - out["sand_pct"], 3)
    return out


# --------------------------------------------------------------- climate
def _get_json(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": "smart-agriculture-fyp/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def climate_normals(lat, lng, years=CLIMATE_YEARS, end_year=None):
    """Long-run temperature and rainfall at one point.

    Fetched a year at a time. A single multi-year request for three daily
    variables reliably times out against the archive API, and one slow year is
    cheaper to retry than the whole decade.
    """
    from datetime import date
    end_year = end_year or (date.today().year - 1)
    start_year = end_year - years + 1

    tmax, tmin, rain_by_year, frost_by_year = [], [], [], []
    # Per-month buckets. A crop's temperature tolerance applies during ITS
    # window, not across the year: wheat never meets Punjab's June heat, and
    # judging it against an annual mean would blame it for weather it misses.
    by_month = {m: {"tmax": [], "tmin": [], "rain": []} for m in range(1, 13)}
    got = 0
    for y in range(start_year, end_year + 1):
        url = (f"{OPEN_METEO_ARCHIVE}?latitude={lat}&longitude={lng}"
               f"&start_date={y}-01-01&end_date={y}-12-31"
               "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum"
               "&timezone=Asia%2FKarachi")
        try:
            d = _get_json(url)["daily"]
        except (urllib.error.URLError, TimeoutError, KeyError, OSError):
            continue   # a missing year weakens the normal; it does not break it
        yr_max = [v for v in d["temperature_2m_max"] if v is not None]
        yr_min = [v for v in d["temperature_2m_min"] if v is not None]
        yr_rain = [v for v in d["precipitation_sum"] if v is not None]
        if not yr_max:
            continue
        got += 1
        tmax += yr_max
        tmin += yr_min
        rain_by_year.append(sum(yr_rain))
        frost_by_year.append(sum(1 for v in yr_min if v < FROST_C))
        for iso, vmax, vmin, vrain in zip(d["time"], d["temperature_2m_max"],
                                          d["temperature_2m_min"], d["precipitation_sum"]):
            m = int(iso[5:7])
            if vmax is not None:
                by_month[m]["tmax"].append(vmax)
            if vmin is not None:
                by_month[m]["tmin"].append(vmin)
            if vrain is not None:
                by_month[m]["rain"].append(vrain)

    if not got:
        raise LookupError(f"no climate data returned for {lat},{lng}")

    monthly = {}
    for m in range(1, 13):
        b = by_month[m]
        if not b["tmax"]:
            continue
        monthly[m] = {
            "tmax_c": round(statistics.mean(b["tmax"]), 2),
            "tmin_c": round(statistics.mean(b["tmin"]), 2),
            # total for the month, not a daily mean
            "rain_mm": round(sum(b["rain"]) / got, 1),
            "frost_days": round(sum(1 for v in b["tmin"] if v < FROST_C) / got, 2),
        }

    return {
        "years_used": got,
        "years_requested": years,
        "monthly": monthly,
        "tmax_mean_c": round(statistics.mean(tmax), 2),
        "tmin_mean_c": round(statistics.mean(tmin), 2),
        "tmax_hottest_c": round(max(tmax), 2),
        "tmin_coldest_c": round(min(tmin), 2),
        "annual_rain_mm": round(statistics.mean(rain_by_year), 1),
        "frost_days_per_year": round(statistics.mean(frost_by_year), 1),
    }


def window_climate(monthly, start_md, end_md):
    """Climate over one crop's observation window, from monthly normals.

    start_md/end_md are (month, day). A window whose end month precedes its
    start month has wrapped into the next year (wheat: Dec -> Mar), so the
    month list wraps with it.
    """
    sm, em = start_md[0], end_md[0]
    months = list(range(sm, em + 1)) if sm <= em else         list(range(sm, 13)) + list(range(1, em + 1))
    have = [monthly[m] for m in months if m in monthly]
    if not have:
        return None
    return {
        "months": months,
        "tmax_c": round(statistics.mean(x["tmax_c"] for x in have), 2),
        "tmin_c": round(statistics.mean(x["tmin_c"] for x in have), 2),
        "tmax_peak_c": round(max(x["tmax_c"] for x in have), 2),
        "rain_mm": round(sum(x["rain_mm"] for x in have), 1),
        "frost_days": round(sum(x["frost_days"] for x in have), 2),
    }


# --------------------------------------------------------------- profile
def build_profile(lat, lng, water_source=None, salinity_flag=None, last_crop=None,
                  years=CLIMATE_YEARS):
    """Everything the suitability engine needs to know about one parcel.

    The three farmer-declared fields are passed through rather than guessed.
    water_source and salinity_flag have no free raster equivalent, and last_crop
    is simply unknowable from space.
    """
    lat, lng = check_coords(lat, lng)
    profile = {
        "lat": lat, "lng": lng,
        "soil": soil_profile(lat, lng),
        "climate": climate_normals(lat, lng, years=years),
        "water_source": water_source,
        "salinity_flag": salinity_flag,
        "salinity_source": SALINITY_SOURCE,
        "last_crop": last_crop,
    }
    return profile


# Contrasting Punjab points: the rice-wheat plain, the canal-irrigated centre,
# the Thal sands and the Cholistan margin. If the profile cannot tell these
# apart it is not carrying information the suitability engine can use.
DEMO_POINTS = [
    ("Sheikhupura",    31.70, 73.98),
    ("Okara",          30.81, 73.45),
    ("Bhakkar (Thal)", 31.63, 71.06),
    ("Rahim Yar Khan", 28.42, 70.30),
]


def demo():
    """Profile four contrasting points and assert the contrast is real."""
    seen = []
    for name, lat, lng in DEMO_POINTS:
        s = soil_profile(lat, lng)
        seen.append((name, s))
        print(f"  {name:16s} {str(s['texture']):11s} pH {s['ph']:5.2f}  "
              f"sand {s['sand_pct']:5.1f}%  clay {s['clay_pct']:5.1f}%  "
              f"water {s['water_33k']:5.1f} vol%")

    by = dict(seen)
    # The Thal and Cholistan margins must read sandier than the rice-wheat plain.
    assert by["Bhakkar (Thal)"]["sand_pct"] > by["Sheikhupura"]["sand_pct"],         "Thal should be sandier than the Sheikhupura rice-wheat plain"
    assert by["Rahim Yar Khan"]["sand_pct"] > by["Sheikhupura"]["sand_pct"],         "Cholistan margin should be sandier than Sheikhupura"
    # Sandier soil holds less water. If this fails the layers disagree with
    # basic soil physics and something is mis-scaled.
    assert by["Rahim Yar Khan"]["water_33k"] < by["Sheikhupura"]["water_33k"],         "sandier soil must hold less water at field capacity"
    # Punjab soils are alkaline throughout; a neutral or acid reading means the
    # pH scale factor has been applied the wrong way round.
    for name, s in seen:
        assert 7.0 <= s["ph"] <= 9.0, f"{name}: pH {s['ph']} is not a Punjab value"
    print("  land self-check OK -- profiles discriminate, soil physics consistent")


def main():
    ap = argparse.ArgumentParser(description="Profile one point.")
    ap.add_argument("--demo", action="store_true",
                    help="profile four contrasting Punjab points and self-check")
    ap.add_argument("lat", type=float, nargs="?")
    ap.add_argument("lng", type=float, nargs="?")
    ap.add_argument("--years", type=int, default=CLIMATE_YEARS)
    a = ap.parse_args()

    if a.demo:
        demo()
        return

    p = build_profile(a.lat, a.lng, years=a.years)
    s, c = p["soil"], p["climate"]
    print(f"point {a.lat}, {a.lng}")
    print(f"  texture      {s['texture']} (class {s['texture_class']})"
          f"  clay {s['clay_pct']}%  silt {s['silt_pct']}%  sand {s['sand_pct']}%")
    print(f"  pH           {s['ph']}")
    print(f"  bulk density {s['bulk_dens']} g/cm3")
    print(f"  water @33kPa {s['water_33k']} vol%")
    print(f"  organic C    {s['soc_raw']} RAW -- unit unverified, see soc_note")
    print(f"  climate      Tmax {c['tmax_mean_c']}C  Tmin {c['tmin_mean_c']}C"
          f"  rain {c['annual_rain_mm']} mm/yr  frost {c['frost_days_per_year']} d/yr"
          f"  ({c['years_used']}/{c['years_requested']} yrs)")
    print(f"  salinity     not sampled -- {SALINITY_SOURCE}")


if __name__ == "__main__":
    main()
