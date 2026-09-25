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

    if bad:
        print("\nCONTRADICTIONS -- the registry excludes ground that grows the crop:")
        for crop, n, tot, plo, phi in bad:
            print(f"  {crop}: {n}/{tot} districts, measured pH {plo:.2f}-{phi:.2f}")
        sys.exit(1)

    print("\nno contradictions.")


if __name__ == "__main__":
    main()
