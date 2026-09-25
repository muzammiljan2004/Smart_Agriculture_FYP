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

# Sheets worth extracting, by name. Anything ending in _Yield_Data is a crop
# table; the rest of each workbook (Source_Verification, Missing_Unverified,
# Summary, Data_Dictionary) is provenance for humans, not a join input.
def wanted_sheets(names):
    return [n for n in names if n.endswith("_Yield_Data") or n == "District_Name_Map"]


def main():
    books = sorted(DATA.glob("*.xlsx"))
    if not books:
        sys.exit(f"no .xlsx found in {DATA}")

    # Every workbook, not just the newest: wheat and rice arrive separately and
    # each carries its own crop table.
    for book in books:
        print(f"reading {book.name}")
        wb = openpyxl.load_workbook(book, read_only=True, data_only=True)
        sheets = wanted_sheets(wb.sheetnames)
        if not sheets:
            print(f"  no *_Yield_Data or District_Name_Map sheet; skipping")
            continue
        extract(wb, sheets)


def extract(wb, sheets):
    for sheet in sheets:
        out_name = f"{sheet}.csv"
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
