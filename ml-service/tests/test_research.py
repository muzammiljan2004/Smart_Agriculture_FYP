"""Offline checks for the researcher portal's dataset validator and matrix build.

    python -m tests.test_research

NO NETWORK, NO DATABASE, NO GEE. Everything here runs against strings built in
this file plus the committed training CSV, so it works on a fresh clone.

What it guards, and why each one is worth a test:

  * A malformed upload must be REJECTED WITH A REASON. The brief asks for "a
    clear UI error, never a silent failure or crash", and the failure mode that
    matters is the quiet one -- a file that half-registers and then blows up at
    training time, hours later, with a traceback nobody can map back to the
    upload. Each case below asserts the message names what is wrong.

  * A blank optional cell must become NaN, NEVER 0. Zero NDVI is a real
    reading that means bare ground. Imputing a missing observation as zero
    teaches the model that an absent measurement looks like a dead field --
    the same class of bug as `mean()` averaging nulls as zeros on the
    government side, which a selfcheck caught there.

  * The split must be deterministic. A dataset_version is pinned so a run is
    reproducible; a reshuffle on every call would make the same config on the
    same data report different numbers.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from app.research import (  # noqa: E402
    BUCKETS, INDEX_COLUMNS, DatasetInvalid, _bucket, _load_matrix, _report, _split, validate_csv,
)

FAILS = []


def check(cond, label):
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        FAILS.append(label)


def rejects(text, must_mention, label):
    """A bad upload must raise DatasetInvalid AND say what is wrong."""
    try:
        validate_csv(text)
    except DatasetInvalid as e:
        msg = str(e)
        ok = all(m.lower() in msg.lower() for m in must_mention)
        print(("  ok   " if ok else "  FAIL ") + f"{label}: {msg[:88]}")
        if not ok:
            FAILS.append(f"{label} (message did not mention {must_mention})")
    else:
        print(f"  FAIL {label}: accepted a file it should have rejected")
        FAILS.append(label)


HEADER = "date,district,crop_type,ndvi,evi,ndwi,savi,nbr,actual_yield"
GOOD = (
    HEADER + "\n"
    "2021-03-01,Okara,wheat,0.42,0.31,0.08,0.29,0.11,3.1\n"
    "2021-03-11,Okara,wheat,0.55,0.40,0.09,0.37,0.12,3.4\n"
    "2021-03-21,Okara,wheat,0.61,0.45,0.10,0.41,0.13,3.9\n"
)

print("\nrejects malformed uploads")
rejects("", ["empty"], "an empty file")
rejects("   \n  ", ["empty"], "whitespace only")
rejects("date,ndvi,actual_yield\n2021-01-01,0.4,3.0\n",
        ["evi", "ndwi", "savi", "nbr"], "missing four index columns")
rejects("date,ndvi,evi,ndwi,savi,nbr\n2021-01-01,0.4,0.3,0.1,0.3,0.1\n",
        ["actual_yield"], "missing the target column")
rejects("ndvi,evi,ndwi,savi,nbr,actual_yield\n0.4,0.3,0.1,0.3,0.1,3.0\n",
        ["date", "season"], "no temporal column")
rejects(HEADER + "\n2021-03-01,Okara,wheat,0.4,0.3,0.1,0.3,0.1,\n",
        ["no usable rows", "blank"], "every target blank")
rejects(HEADER + "\n2021-03-01,Okara,wheat,abc,0.3,0.1,0.3,0.1,3.0\n",
        ["no usable rows"], "non-numeric index value")

print("\naccepts a well-formed upload")
count, notes = validate_csv(GOOD)
check(count == 3, f"counts 3 usable rows (got {count})")
# GOOD carries a crop_type column, so the crop one-hot IS an optional block
# present. It is reported, because a researcher reading the version list needs
# to know whether crop identity was a feature -- without it this dataset trains
# to R2 0.12 instead of 0.90.
check(any("crop one-hot" in n for n in notes),
      "reports the crop one-hot as present")
check(not any("weather" in n or "soil" in n for n in notes),
      "does not claim a weather or soil block this file has not got")

# A season column instead of a date is equally valid -- the production
# training data is keyed that way, so rejecting it would reject the project's
# own dataset.
season_csv = ("season,ndvi,evi,ndwi,savi,nbr,actual_yield\n"
              "2021-22,0.42,0.31,0.08,0.29,0.11,3.1\n")
count2, _ = validate_csv(season_csv)
check(count2 == 1, "accepts `season` in place of `date`")

print("\npartial rows are counted, not silently dropped")
mixed = GOOD + "2021-04-01,Okara,wheat,0.6,0.4,0.1,0.4,0.1,\n"
c3, n3 = validate_csv(mixed)
check(c3 == 3, f"3 usable of 4 rows (got {c3})")
check(any("1 skipped" in n for n in n3), "says one row was skipped, and why")

print("\nweather and soil blocks are detected")
wide = ("date,ndvi,evi,ndwi,savi,nbr,tmax_mean_c,ph,actual_yield\n"
        "2021-03-01,0.4,0.3,0.1,0.3,0.1,31.2,7.8,3.1\n")
_, n4 = validate_csv(wide)
check(any("weather" in n and "soil" in n for n in n4),
      "names both optional blocks when present")

print("\nthe committed production dataset validates")
real = Path(__file__).resolve().parents[1] / "data" / "training_data_real.csv"
if real.exists():
    n_real, notes_real = validate_csv(real.read_text(encoding="utf-8-sig"))
    check(n_real == 2378, f"training_data_real.csv -> 2378 usable rows (got {n_real})")
else:
    print("  --   skipped, data/training_data_real.csv not present")

print("\nmissing values become NaN, never zero")
tmp = Path(__file__).parent / "_research_tmp.csv"
tmp.write_text(
    "date,ndvi,evi,ndwi,savi,nbr,ph,actual_yield\n"
    "2021-03-01,0.40,0.30,0.10,0.30,0.10,7.0,3.0\n"
    "2021-03-11,0.50,0.40,0.10,0.40,0.10,,3.5\n"   # blank ph
    "2021-03-21,0.60,0.50,0.10,0.50,0.10,9.0,4.0\n",
    encoding="utf-8",
)
try:
    X, y, feats = _load_matrix(tmp)
    ph = X[:, feats.index("ph")]
    # Median of [7.0, 9.0] is 8.0. A zero-fill would have put 0.0 here, which
    # is outside the physical range of soil pH entirely -- the tell that the
    # bug is present.
    check(abs(ph[1] - 8.0) < 1e-9,
          f"blank ph imputed to the column median 8.0, not 0.0 (got {ph[1]})")
    check(ph[1] != 0.0, "blank cell did not become zero")
    check(list(y) == [3.0, 3.5, 4.0], "targets read in file order")
    check("ph" in feats and "tmax_mean_c" not in feats,
          "feature list includes present optional columns only")
finally:
    tmp.unlink(missing_ok=True)

print("\nthis project's own column headings are accepted")
# experimental/temporal_features/training_data_temporal_experiment.csv names its
# season-median composites prod_ndvi..prod_nbr and its crop column `crop`.
# Rejecting that file for its headings would mean the researcher portal cannot
# read the project's own experimental dataset.
aliased = ("season,crop,prod_ndvi,prod_evi,prod_ndwi,prod_savi,prod_nbr,actual_yield\n"
           "2021-22,wheat,0.42,0.31,0.08,0.29,0.11,3.1\n"
           "2021-22,rice,0.51,0.38,0.09,0.33,0.12,2.6\n")
n_a, notes_a = validate_csv(aliased)
check(n_a == 2, f"prod_* headings accepted ({n_a} rows)")
check(any("resolved by alias" in n for n in notes_a),
      "the notes say which headings were resolved by alias")
tmp4 = Path(__file__).parent / "_research_alias.csv"
tmp4.write_text(aliased, encoding="utf-8")
try:
    Xa, ya, fa = _load_matrix(tmp4)
    check(fa[:5] == list(INDEX_COLUMNS), "aliased columns land under canonical names")
    check("crop_wheat" in fa and "crop_rice" in fa, "`crop` is read as crop_type")
    # The values must come FROM the prod_* columns, not be left NaN and imputed.
    check(abs(Xa[0][0] - 0.42) < 1e-9, f"ndvi read through prod_ndvi (got {Xa[0][0]})")
    check(not np.isnan(Xa).any(), "no NaN left behind by the alias lookup")
finally:
    tmp4.unlink(missing_ok=True)

# A canonical column always beats its alias.
both = ("season,ndvi,prod_ndvi,evi,ndwi,savi,nbr,actual_yield\n"
        "2021-22,0.90,0.10,0.3,0.1,0.3,0.1,3.0\n")
tmp5 = Path(__file__).parent / "_research_both.csv"
tmp5.write_text(both, encoding="utf-8")
try:
    Xb, _, fb = _load_matrix(tmp5)
    check(abs(Xb[0][fb.index("ndvi")] - 0.90) < 1e-9,
          "with both ndvi and prod_ndvi present, ndvi wins")
finally:
    tmp5.unlink(missing_ok=True)

# Raw per-date observations carry the indices but no label. That file must be
# refused with a reason naming the join, not accepted and trained on nothing.
rejects("crop,season,district,date,ndvi,evi,ndwi,savi,nbr\n"
        "wheat,2021-22,Okara,2021-03-01,0.4,0.3,0.1,0.3,0.1\n",
        ["actual_yield", "joined"], "raw observations with no label")

print("\ncrop_type becomes a one-hot block")
tmp2 = Path(__file__).parent / "_research_crop.csv"
tmp2.write_text(
    "season,crop_type,ndvi,evi,ndwi,savi,nbr,actual_yield\n"
    "2021-22,wheat,0.40,0.30,0.10,0.30,0.10,3.0\n"
    "2021-22,rice,0.50,0.40,0.10,0.40,0.10,2.5\n"
    "2021-22,sugarcane,0.60,0.50,0.10,0.50,0.10,60.0\n",
    encoding="utf-8",
)
try:
    Xc, yc, fc = _load_matrix(tmp2)
    # THE BUG THIS GUARDS. Without the one-hot the matrix is 5 columns wide and
    # the model cannot tell sugarcane (60 t/ha) from wheat (3 t/ha). A real
    # training on the production CSV scored R2 0.1168 that way, against 0.9207
    # for the shipped model on the same rows.
    check(fc[:5] == list(INDEX_COLUMNS), "the five indices come first, in order")
    onehot = [f for f in fc if f.startswith("crop_")]
    check(onehot == ["crop_rice", "crop_sugarcane", "crop_wheat"],
          f"one column per crop PRESENT in the file, sorted (got {onehot})")
    check(Xc.shape[1] == 8, f"matrix is 5 indices + 3 crops wide (got {Xc.shape[1]})")
    wheat_col = fc.index("crop_wheat")
    rice_col = fc.index("crop_rice")
    check(Xc[0][wheat_col] == 1.0 and Xc[0][rice_col] == 0.0,
          "the wheat row is hot on crop_wheat only")
    check(Xc[1][rice_col] == 1.0 and Xc[1][wheat_col] == 0.0,
          "the rice row is hot on crop_rice only")
    # A one-hot must never be NaN-imputed: the median of a 0/1 column is a
    # meaningless fraction of a crop.
    check(not np.isnan(Xc).any(), "no NaN anywhere in a one-hot block")
    check(set(Xc[:, wheat_col]) == {0.0, 1.0}, "the one-hot column holds only 0 and 1")
finally:
    tmp2.unlink(missing_ok=True)

# A file with no crop_type gets no one-hot and must still work -- a
# single-crop dataset is a legitimate upload.
tmp3 = Path(__file__).parent / "_research_nocrop.csv"
tmp3.write_text(
    "season,ndvi,evi,ndwi,savi,nbr,actual_yield\n"
    "2021-22,0.40,0.30,0.10,0.30,0.10,3.0\n",
    encoding="utf-8",
)
try:
    Xn, yn, fn = _load_matrix(tmp3)
    check(fn == list(INDEX_COLUMNS), "no crop_type column -> indices only, no one-hot")
finally:
    tmp3.unlink(missing_ok=True)

print("\nsplit is deterministic and disjoint")
X = np.arange(100, dtype=float).reshape(50, 2)
y = np.arange(50, dtype=float)
a1, b1, c1, d1 = _split(X, y, 0.8)
a2, b2, c2, d2 = _split(X, y, 0.8)
check(np.array_equal(c1, c2) and np.array_equal(d1, d2),
      "same inputs give the same split twice")
check(len(c1) == 40 and len(d1) == 10, f"80/20 of 50 rows (got {len(c1)}/{len(d1)})")
check(len(set(c1.tolist()) & set(d1.tolist())) == 0, "train and test are disjoint")
check(sorted(c1.tolist() + d1.tolist()) == y.tolist(), "every row lands in exactly one side")

# A dataset so small that the ratio would round the test side to zero must
# still hold a row back -- scoring on the training rows would report a
# meaningless result as if it were a holdout.
_, _, ctiny, dtiny = _split(X[:2], y[:2], 0.95)
check(len(dtiny) >= 1, "a 2-row dataset still keeps at least one test row")

print("\na crop/district/season scope actually filters the rows")
# THE BUG THIS CATCHES: _load_matrix used to take only a path, so crop_id on the
# run row was recorded and never applied. Two runs scoped to different crops
# read the whole file and returned byte-identical metrics, which the comparison
# screen then presented as a per-crop difference.
scoped = ("district,season,crop_type,ndvi,evi,ndwi,savi,nbr,actual_yield\n"
          "Lahore,2021-22,wheat,0.42,0.31,0.08,0.29,0.11,3.1\n"
          "Lahore,2021-22,wheat,0.44,0.33,0.08,0.30,0.11,3.3\n"
          "Multan,2021-22,rice,0.51,0.38,0.09,0.33,0.12,2.6\n"
          "Multan,2022-23,cotton,0.61,0.48,0.10,0.43,0.13,1.9\n")
tmp6 = Path(__file__).parent / "_research_scope.csv"
tmp6.write_text(scoped, encoding="utf-8")
try:
    Xall, yall, fall = _load_matrix(tmp6)
    check(len(yall) == 4, f"unscoped reads every row ({len(yall)})")

    Xw, yw, fw = _load_matrix(tmp6, {"crop_type": "wheat"})
    check(len(yw) == 2, f"crop scope keeps only wheat ({len(yw)} rows)")
    check(sorted(yw) == [3.1, 3.3], f"and the right two targets ({sorted(yw)})")
    # The one-hot is rebuilt from the SCOPED rows: encoding rice and cotton
    # columns a wheat-only run can never set would hand the forest two
    # constant-zero features and make the model demand columns a wheat-only
    # evaluation file cannot supply.
    check(fw == list(INDEX_COLUMNS) + ["crop_wheat"],
          f"one-hot covers only the crops left after scoping ({fw[5:]})")
    check(not np.array_equal(Xall, Xw), "the scoped matrix differs from the full one")

    Xd, yd, _ = _load_matrix(tmp6, {"district": "multan"})
    check(len(yd) == 2, f"district scope keeps only Multan ({len(yd)} rows)")

    # Two filters are ANDed, not ORed.
    Xb, yb, _ = _load_matrix(tmp6, {"district": "multan", "season": "2022-23"})
    check(list(yb) == [1.9], f"district AND season both apply ({list(yb)})")

    # A scope that matches nothing must refuse, not silently widen.
    try:
        _load_matrix(tmp6, {"crop_type": "sugarcane"})
        check(False, "a scope matching no rows is refused")
    except DatasetInvalid as e:
        check("sugarcane" in str(e), f"refusal names the empty scope ({e})")

    # A scope on a column the file lacks must refuse too -- ignoring it would
    # record a crop-scoped run whose numbers came from every crop.
    nocrop = Path(__file__).parent / "_research_nocrop.csv"
    nocrop.write_text("ndvi,evi,ndwi,savi,nbr,actual_yield\n"
                      "0.4,0.3,0.1,0.3,0.1,3.0\n", encoding="utf-8")
    try:
        _load_matrix(nocrop, {"crop_type": "wheat"})
        check(False, "a scope the file cannot support is refused")
    except DatasetInvalid as e:
        check("no `crop_type` column" in str(e), f"refusal says why ({e})")
    finally:
        nocrop.unlink(missing_ok=True)
finally:
    tmp6.unlink(missing_ok=True)

print("\nthe report explains its own R2")
import time as _t
_rep = _report([3.0, 3.1, 2.9, 3.2], [5.0, 5.1, 4.9, 5.2],
               feats=["ndvi"], n_train=0, n_test=4, started=_t.time(),
               scope={"crop_type": "wheat"})
# std_actual is the yardstick R2 is measured against. Without it on the page a
# negative R2 reads as a broken run: an RMSE of 2.0 against a spread of 0.11 is
# R2 ~= -330, which is arithmetic, not a failure.
check(_rep["std_actual"] is not None and _rep["std_actual"] > 0,
      f"the report records the spread of the target (sigma {_rep['std_actual']})")
check(abs(_rep["std_actual"] - float(np.std([3.0, 3.1, 2.9, 3.2]))) < 1e-6,
      "and it is the standard deviation of the actuals, not of the errors")
# REGRESSION GUARD: the evaluation path once wrote a sentence over this key, so
# a wheat-only run reported its scope as "whole dataset".
check(_rep["scope"] == {"crop_type": "wheat"},
      f"the scope survives as the filter it was, not prose ({_rep['scope']})")
check(_report([1.0, 2.0], [1.0, 2.0], feats=["ndvi"], n_train=0, n_test=2,
              started=_t.time())["scope"] is None,
      "an unscoped run records scope as null rather than omitting it")

print("\nhyper-parameters are bounded server-side, not just in the browser")
# The model_runs row is inserted by the CLIENT. run_config is free-form JSON, so
# the portal's min/max attributes are a typing aid and nothing more -- anything
# that reaches PostgREST can ask this service to fit any forest it likes.
# Unbounded, n_estimators: 50000000 is a thread that never returns.
from app.research import _bounded_int

check(_bounded_int({}, "n_estimators", 500, 10, 2000) == 500,
      "an absent value falls back to the default")
check(_bounded_int({"n_estimators": ""}, "n_estimators", 500, 10, 2000) == 500,
      "an empty string falls back too, rather than raising")
check(_bounded_int({"n_estimators": "250"}, "n_estimators", 500, 10, 2000) == 250,
      "a numeric string is accepted (JSON from the browser is often a string)")
check(_bounded_int({"n_estimators": 250.0}, "n_estimators", 500, 10, 2000) == 250,
      "a float is coerced rather than refused")

for bad, why in [(50_000_000, "a forest that would never finish"),
                 (0, "below the floor"),
                 (-5, "negative")]:
    try:
        _bounded_int({"n_estimators": bad}, "n_estimators", 500, 10, 2000)
        check(False, f"{bad} is refused ({why})")
    except DatasetInvalid as e:
        check("between 10 and 2000" in str(e), f"{bad} is refused, with the range stated")

try:
    _bounded_int({"max_depth": "deep"}, "max_depth", 25, 2, 60)
    check(False, "a non-numeric hyper-parameter is refused")
except DatasetInvalid as e:
    check("whole number" in str(e) and "max_depth" in str(e),
          f"a non-numeric value names the field ({e})")

# The bounds must match what the portal offers, or a legitimate user meets them.
src = (Path(__file__).resolve().parents[1] / "app" / "research.py").read_text(encoding="utf-8")
check('_bounded_int(config, "n_estimators", 500, 10, 2000)' in src,
      "estimators bound matches the portal input (10-2000)")
check('_bounded_int(config, "max_depth", 25, 2, 60)' in src,
      "depth bound matches the portal input (2-60)")

ui = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "research"
      / "pages" / "OperationsPage.jsx").read_text(encoding="utf-8")
check('min="10" max="2000"' in ui, "the browser offers the same estimator range")
check('min="2" max="60"' in ui, "the browser offers the same depth range")
check('min="0.1" max="0.95"' in ui, "the browser offers the same split range")

print("\nyield buckets")
check(_bucket(0.9) == "low" and _bucket(2.0) == "moderate"
      and _bucket(3.6) == "good" and _bucket(9.0) == "high",
      "boundaries map as documented")
check(_bucket(1.5) == "moderate", "an edge value falls in the upper bucket")
check(len({n for _, n in BUCKETS}) == 4, "four distinct bucket names")

print(f"\n{'ALL CHECKS PASSED' if not FAILS else str(len(FAILS)) + ' CHECK(S) FAILED'}")
sys.exit(1 if FAILS else 0)
