"""Does the crop registry contradict agriculture Punjab demonstrably practises?

    python -m scripts.check_registry

A tolerance range is a claim about where a crop can grow. PBS area records are
evidence of where it IS grown, and district_soil.csv measures the pH of that
ground. Where the two disagree, the registry is wrong -- the land is not.

This caught the seed rows' pH ceilings: potato, onion and tomato were ruled out
of all 26, 26 and 7 districts that grow them commercially, because the seed
values were FAO EcoCrop *optimum* ranges entered as *absolute* tolerances.
Punjab's soils run pH 7.26-8.11, so an optimum ceiling of 7.0 excludes the
entire province.

Exits non-zero on a contradiction, so it can go in CI.

LIMIT: one-sided. Punjab has no acidic districts, so ph_min is never exercised
here and this check can never validate it. It proves a ceiling is not too low;
it cannot prove one is not too high.

TEMPERATURE IS MEAN-REFERENCED, ON PURPOSE. temp_min_c/temp_max_c are compared
against the window MEAN of daily maxima, never the peak -- see suitability.py
where _range_class reads window_climate()["tmax_c"]. The distinction is large:
across 170 wheat district-seasons the season mean never once exceeds wheat's
30C ceiling, while the peak exceeds it in 114 of them. Re-pointing this check
at the peak would therefore condemn two thirds of Punjab's wheat land and look
like it had found a bug.

That is not a claim that peaks are harmless -- a spike during grain filling is
exactly what destroys a wheat crop, and March 2022 hit 40.6C. It is a claim
that a static suitability CLASS is the wrong place to handle them: suitability
asks "can this land grow this crop in a normal year", which is a question about
central tendency. Transient heat is handled on two other paths -- hot_days_35c
as a model feature, and app/weather.py's stage-aware forecast alerts.
"""
import csv
import sys
from collections import defaultdict
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"

# One district-season at this area is proof the crop grows there. Below it the
# row may be a kitchen-garden total or a reporting artefact.
MIN_HA = 500


def load(name, key=None):
    rows = list(csv.DictReader(open(DATA / name, encoding="utf-8-sig")))
    return {r[key]: r for r in rows} if key else rows


def check_temperature(registry):
    """Season-mean tmax against each crop's range, where weather exists.

    Advisory only: it prints and never fails the run. Unlike pH, the weather
    file is built per crop by scripts.fetch_district_land, so a crop missing
    here means "not fetched yet", not "contradiction".
    """
    path = DATA / "district_season_weather.csv"
    if not path.exists():
        return
    rows = load(path.name)
    by_crop = defaultdict(list)
    for r in rows:
        if r.get("tmax_mean_c"):
            by_crop[r["crop_type"]].append((float(r["tmax_mean_c"]),
                                            float(r["tmax_peak_c"])))

    print(f"\nseason-mean tmax vs registry range ({len(rows)} district-seasons)")
    print(f"{'crop':10s} {'registry':>12s} {'mean tmax':>14s} {'over':>6s}  "
          f"{'peak tmax':>14s} {'over':>6s}")
    print("-" * 70)
    for crop, vals in sorted(by_crop.items()):
        reg = registry.get(crop)
        if not reg:
            continue
        lo, hi = float(reg["temp_min_c"]), float(reg["temp_max_c"])
        means = sorted(v[0] for v in vals)
        peaks = sorted(v[1] for v in vals)
        n_m = sum(1 for v in means if not lo <= v <= hi)
        n_p = sum(1 for v in peaks if v > hi)
        print(f"{crop:10s} {lo:5.0f}-{hi:<6.0f} {means[0]:6.1f}-{means[-1]:<7.1f} "
              f"{n_m:>3d}/{len(means):<3d} {peaks[0]:6.1f}-{peaks[-1]:<7.1f} "
              f"{n_p:>3d}/{len(peaks):<3d}")
    missing = sorted(set(registry) - set(by_crop))
    if missing:
        print(f"\nno weather yet (run scripts.fetch_district_land): "
              f"{', '.join(missing)}")


def main():
    soil = {r["district"]: float(r["ph"])
            for r in load("district_soil.csv") if r.get("ph")}
    registry = load("crops.csv", key="crop")

    # Largest area ever recorded per district-crop: one good season is enough.
    area = defaultdict(float)
    for r in load("PBS_all_crops.csv"):
        k = (r["Crop"], r["District"])
        area[k] = max(area[k], float(r["Area (ha)"]))

    print(f"soil districts {len(soil)}   pH {min(soil.values()):.2f}-{max(soil.values()):.2f}")
    print(f"{'crop':10s} {'registry pH':>12s} {'grown at pH':>16s} {'n':>4s}  verdict")
    print("-" * 62)

    bad = []
    for crop, reg in registry.items():
        pts = sorted(p for (c, d), a in area.items()
                     if c == crop and a >= MIN_HA and (p := soil.get(d)) is not None)
        if not pts:
            print(f"{crop:10s} {'':>12s} {'no PBS area':>16s}")
            continue
        lo, hi = float(reg["ph_min"]), float(reg["ph_max"])
        out = [p for p in pts if not lo <= p <= hi]
        note = "OK" if not out else f"RULES OUT {len(out)}/{len(pts)} proven districts"
        print(f"{crop:10s} {lo:5.1f}-{hi:<6.1f} {pts[0]:7.2f}-{pts[-1]:<8.2f} "
              f"{len(pts):>4d}  {note}")
        if out:
            bad.append((crop, len(out), len(pts), min(out), max(out)))

    check_temperature(registry)

    if bad:
        print("\nCONTRADICTIONS -- the registry excludes ground that grows the crop:")
        for crop, n, tot, plo, phi in bad:
            print(f"  {crop}: {n}/{tot} districts, measured pH {plo:.2f}-{phi:.2f}")
        sys.exit(1)

    print("\nno contradictions.")


if __name__ == "__main__":
    main()
