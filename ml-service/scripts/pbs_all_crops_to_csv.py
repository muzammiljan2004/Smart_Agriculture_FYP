"""Normalise the all-Pakistan PBS workbook into the join pipeline's CSV format.

    python -m scripts.pbs_all_crops_to_csv
    python -m scripts.pbs_all_crops_to_csv --province PUNJAB --min-season 2017-18

Input   data/all_crops_2015_2025.xlsx
        year · crop · pv · ds · production · area · yield   (13,752 rows,
        21 crops, 120 districts, 2015-16 to 2024-25)

Output  data/PBS_all_crops.csv
        District, Season, Crop, Area (ha), Production (tonnes), Yield,
        Yield Unit, Source

UNITS. The workbook reports area in thousand hectares, production in thousand
tonnes and yield already in t/ha -- verified by reproducing the yield column
from production*1000/area for all 21 crops, which matches to the decimal. Area
and production are scaled to absolute units here; yield is passed through with
an explicit "t/ha" unit label so yield_to_t_per_ha() reads it rather than
assuming. Assuming kg/ha would be a silent 1000x error that still looks like a
plausible number.

DISTRICT NAMES. The workbook prints "LAHORE DISTRICT"; the rest of the project
uses "Lahore". Converted here so one naming convention reaches the join, and
so check_district_names validates what the join will actually request.
"""
import argparse
import csv
import sys
from pathlib import Path

import openpyxl

DATA = Path(__file__).resolve().parents[1] / "data"
BOOK = DATA / "all_crops_2015_2025.xlsx"
OUT = DATA / "PBS_all_crops.csv"

FIELDNAMES = ["District", "Season", "Crop", "Area (ha)", "Production (tonnes)",
              "Yield", "Yield Unit", "Source"]

# Sentinel-2 L2A begins 2017-03-28, so a season ending before then has no
# imagery and no amount of yield data makes it joinable.
DEFAULT_MIN_SEASON = "2017-18"
SOURCE = "PBS Crops Area and Production by Districts (all_crops_2015_2025)"

THOUSANDS = 1000.0     # workbook reports '000 ha and '000 tonnes


def clean_district(raw: str) -> str:
    s = str(raw).strip()
    if s.upper().endswith(" DISTRICT"):
        s = s[: -len(" DISTRICT")]
    # Title-case, but keep the initialisms the rest of the project uses.
    return " ".join(w.capitalize() for w in s.split())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--province", default="PUNJAB",
                    help="province filter, or ALL for every province")
    ap.add_argument("--min-season", default=DEFAULT_MIN_SEASON,
                    help="earliest crop-year to keep (Sentinel-2 floor)")
    a = ap.parse_args()

    if not BOOK.exists():
        sys.exit(f"missing {BOOK}")

    wb = openpyxl.load_workbook(BOOK, read_only=True, data_only=True)
    rows = wb[wb.sheetnames[0]].iter_rows(values_only=True)
    hdr = [str(c).strip() if c is not None else "" for c in next(rows)]
    ix = {h: n for n, h in enumerate(hdr)}
    for need in ("year", "crop", "pv", "ds", "production", "area", "yield"):
        if need not in ix:
            sys.exit(f"{BOOK.name} has no {need!r} column; got {hdr}")

    min_year = int(a.min_season.split("-")[0])
    kept, dropped = [], {"province": 0, "season": 0, "incomplete": 0}

    for r in rows:
        if r[ix["pv"]] is None:
            continue
        if a.province.upper() != "ALL" and \
                str(r[ix["pv"]]).strip().upper() != a.province.upper():
            dropped["province"] += 1
            continue

        season = str(r[ix["year"]]).strip()
        try:
            if int(season.split("-")[0]) < min_year:
                dropped["season"] += 1
                continue
        except (ValueError, IndexError):
            dropped["season"] += 1
            continue

        yld, area, prod = r[ix["yield"]], r[ix["area"]], r[ix["production"]]
        # A row with no yield cannot train anything, and a zero area means the
        # crop was not grown -- both are absences, not measurements.
        if yld is None or area in (None, 0) or prod is None:
            dropped["incomplete"] += 1
            continue

        kept.append({
            "District": clean_district(r[ix["ds"]]),
            "Season": season,
            "Crop": str(r[ix["crop"]]).strip().lower(),
            "Area (ha)": round(float(area) * THOUSANDS, 2),
            "Production (tonnes)": round(float(prod) * THOUSANDS, 2),
            "Yield": round(float(yld), 4),
            "Yield Unit": "t/ha",
            "Source": SOURCE,
        })

    kept.sort(key=lambda r: (r["Crop"], r["District"], r["Season"]))
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDNAMES)
        w.writeheader()
        w.writerows(kept)

    crops = sorted({r["Crop"] for r in kept})
    seasons = sorted({r["Season"] for r in kept})
    print(f"wrote {OUT.name}: {len(kept)} rows")
    print(f"  province : {a.province}")
    print(f"  districts: {len({r['District'] for r in kept})}")
    print(f"  seasons  : {len(seasons)}  {seasons[0]}..{seasons[-1]}")
    print(f"  crops    : {len(crops)}")
    print(f"           {', '.join(crops)}")
    print(f"  dropped  : {dropped}")


if __name__ == "__main__":
    main()
