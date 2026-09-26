"""Why the satellite features do not predict yield. Reproduces the evidence.

    python -m scripts.diagnose_signal

Run this before believing any headline R2 from scripts.train_real. The pooled
figure there reads ~0.92 and means almost nothing: yields span 0.83 t/ha
(jowar) to 63.5 (sugarcane), so most of the variance is BETWEEN crops and a
lookup table knowing only the crop name scores about the same.

Five checks, each answering an objection to the one before:

  1  how much variance is between crops rather than within one
  2  do crops sharing a sowing window get the same features (they do)
  3  how much NDVI variation is year-to-year rather than fixed per district
  4  does signal strength rise with the crop's share of district area
  5  is the district already cropland, i.e. would masking help (it would not)

The conclusion is that district-level optical compositing cannot isolate one
crop in a mixed-crop landscape, and that no amount of further GEE fetching
changes that. See scripts.evaluate_anomaly for the modelling counterpart.
"""
import csv
from collections import defaultdict

import numpy as np

from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"


def rows():
    return list(csv.DictReader(open(DATA / "training_data_real.csv", encoding="utf-8-sig")))


def check_1_between_vs_within(rs):
    by = defaultdict(list)
    for r in rs:
        by[r["crop_type"]].append(float(r["actual_yield"]))
    allv = [x for v in by.values() for x in v]
    within = np.mean([np.var(v) for v in by.values()])
    total = np.var(allv)
    print("1. WHERE THE VARIANCE LIVES")
    for c, v in sorted(by.items(), key=lambda kv: -np.mean(kv[1])):
        print(f"     {c:10s} mean {np.mean(v):>6.2f} t/ha")
    print(f"   {1 - within / total:.1%} of all yield variance is BETWEEN crops")
    print(f"   => a crop-name lookup table scores R2 ~ {1 - within / total:.2f}\n")


def check_2_window_collisions(rs):
    sig = defaultdict(list)
    for r in rs:
        sig[(r["district"], r["season"],
             r["ndvi"], r["evi"], r["ndwi"], r["savi"], r["nbr"])].append(
                 (r["crop_type"], float(r["actual_yield"])))
    dup = {k: v for k, v in sig.items() if len(v) > 1}
    n = sum(len(v) for v in dup.values())
    print("2. CROPS SHARING A WINDOW GET IDENTICAL FEATURES")
    print(f"   {n} rows ({n / len(rs):.0%}) share a feature vector with another row")
    for k, v in list(dup.items())[:2]:
        print(f"     {k[0]} {k[1]}  ndvi={k[2]}")
        for c, y in sorted(v):
            print(f"         {c:10s} {y:>6.2f} t/ha")
    print("   identical inputs, different labels: only the crop one-hot separates them\n")


def check_3_year_to_year(rs):
    g = defaultdict(list)
    for r in rs:
        g[(r["district"], r["crop_type"])].append(float(r["ndvi"]))
    within = np.mean([np.var(v) for v in g.values() if len(v) > 1])
    between = np.var([np.mean(v) for v in g.values()])
    print("3. HOW MUCH NDVI IS ACTUALLY ABOUT THIS SEASON")
    print(f"   between district-crops {between:.5f}")
    print(f"   within  district-crop  {within:.5f}")
    print(f"   => only {within / (within + between):.1%} of NDVI variation is year-to-year,")
    print(f"      and that is all the anomaly target can use\n")


def check_4_area_share(rs):
    area, tot = defaultdict(float), defaultdict(float)
    for r in csv.DictReader(open(DATA / "PBS_all_crops.csv", encoding="utf-8-sig")):
        a = float(r["Area (ha)"])
        area[(r["District"], r["Season"], r["Crop"])] = a
        tot[(r["District"], r["Season"])] += a

    g = defaultdict(list)
    for r in rs:
        k = (r["district"], r["season"])
        t = tot.get(k, 0)
        sh = area.get((*k, r["crop_type"]), 0) / t if t else 0
        g[(r["district"], r["crop_type"])].append(
            (float(r["ndvi"]), float(r["actual_yield"]), sh))

    buckets = defaultdict(list)
    for v in g.values():
        if len(v) < 5:
            continue
        n = np.array([a for a, _, _ in v]); y = np.array([b for _, b, _ in v])
        if n.std() == 0 or y.std() == 0:
            continue
        sh = np.mean([s for _, _, s in v])
        b = ">20%" if sh > .20 else "10-20%" if sh > .10 else "2-10%" if sh > .02 else "<2%"
        buckets[b].append(np.corrcoef(n, y)[0, 1])

    print("4. SIGNAL RISES WITH THE CROP'S SHARE OF DISTRICT AREA")
    print(f"   {'share':>8s} {'groups':>7s} {'mean r':>8s} {'% positive':>11s}")
    for b in (">20%", "10-20%", "2-10%", "<2%"):
        v = np.array(buckets[b])
        if len(v):
            print(f"   {b:>8s} {len(v):>7d} {v.mean():>+8.3f} {(v > 0).mean():>10.0%}")
    print("   real, but r=0.39 is only R2~0.15 and does not survive as a model\n")


def check_5_cropland(districts=("Sheikhupura", "Okara", "Faisalabad", "Attock")):
    """Would masking to cropland help? Needs GEE; skipped if unavailable."""
    print("5. WOULD A CROPLAND MASK HELP?")
    try:
        import ee
        from app.gee import get_district_geometry, init
        init()
        wc = ee.Image("ESA/WorldCover/v200/2021").select("Map")
        for d in districts:
            h = wc.reduceRegion(ee.Reducer.frequencyHistogram(),
                                get_district_geometry(d), 100,
                                maxPixels=int(1e9)).getInfo()["Map"]
            t = sum(h.values())
            print(f"     {d:14s} cropland {h.get('40', 0) / t:>6.1%}")
        print("   central Punjab is already ~85% cropland, so masking removes")
        print("   little. The contamination is crop-vs-crop, not crop-vs-city.\n")
    except Exception as e:                      # noqa: BLE001 - diagnostic only
        print(f"   skipped (no Earth Engine: {e})\n")


if __name__ == "__main__":
    rs = rows()
    print(f"\n{len(rs)} training rows\n")
    check_1_between_vs_within(rs)
    check_2_window_collisions(rs)
    check_3_year_to_year(rs)
    check_4_area_share(rs)
    check_5_cropland()
    print("CONCLUSION: district-level optical compositing cannot isolate one")
    print("crop in a mixed-crop landscape. Further GEE fetching does not fix it.")
