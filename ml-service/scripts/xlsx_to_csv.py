"""Extract the sheets the pipeline reads out of the supplied workbook.

    python -m scripts.xlsx_to_csv

The dataset arrives as one .xlsx with five sheets. The join scripts read CSVs
so the inputs stay diffable and greppable -- an .xlsx is a zip, so git cannot
show what changed between two versions of the data.

Only two sheets are extracted. Source_Verification, Missing_Unverified and
Summary are provenance for humans, not join inputs.
"""
import csv
import sys
from pathlib import Path

import openpyxl

DATA = Path(__file__).resolve().parents[1] / "data"
SHEETS = {"Wheat_Yield_Data": "Wheat_Yield_Data.csv",
          "District_Name_Map": "District_Name_Map.csv"}


def main():
    books = sorted(DATA.glob("*.xlsx"))
    if not books:
        sys.exit(f"no .xlsx found in {DATA}")
    if len(books) > 1:
        print(f"several workbooks found; using the newest: {books[-1].name}")
    book = max(books, key=lambda p: p.stat().st_mtime)
    print(f"reading {book.name}")

    wb = openpyxl.load_workbook(book, read_only=True, data_only=True)
    for sheet, out_name in SHEETS.items():
        if sheet not in wb.sheetnames:
            sys.exit(f"{book.name} has no sheet {sheet!r} (has: {wb.sheetnames})")

        ws = wb[sheet]
        out = DATA / out_name
        written = 0
        with out.open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            for row in ws.iter_rows(values_only=True):
                # Trailing blank rows are common in hand-built workbooks and
                # would become empty CSV rows that the DictReader yields as
                # all-None dicts.
                if all(c is None or str(c).strip() == "" for c in row):
                    continue
                w.writerow(["" if c is None else c for c in row])
                written += 1
        print(f"  {sheet:20s} -> {out_name}  ({written - 1} data row(s))")


if __name__ == "__main__":
    main()
