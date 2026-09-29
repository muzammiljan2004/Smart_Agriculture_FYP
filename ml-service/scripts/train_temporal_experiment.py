"""Step 11c: train the temporal-feature experiment and compare it, like for
like, with the current median-composite representation.

    python -m scripts.train_temporal_experiment

EXPERIMENTAL AND NON-DESTRUCTIVE. It reads
data/training_data_temporal_experiment.csv, writes nothing except
app/model_temporal_experiment.pkl, and never touches app/model.pkl,
data/training_data_real.csv, /predict or /health.

FIVE ARMS, one script, so the difference between them is the feature set and
nothing else -- same rows, same labels, same holdout, same forest
hyper-parameters as scripts.train_real:

  median    5 median-composite indices + crop one-hot   (the current design)
  temporal  the engineered temporal features + crop one-hot
  both      the two stacked
  no_px     temporal, minus valid_px_mean alone
  veg_only  temporal, minus the whole coverage/quality block

THE LAST TWO ARE NOT OPTIONAL EXTRAS. valid_px_mean is the mean number of
reduced pixels in the district, which is the district's AREA -- it takes a
different value in all 34 districts and so names the district outright. A
forest can use it as a district lookup, which is the same failure mode as the
crop one-hot one level down. Any gain that disappears when it is removed was
never a vegetation signal, so the ablation runs every time rather than being
something a reader has to think to ask for.

Missing values are imputed to the TRAINING median and flagged with a
companion _isna column, rather than dropped. Dropping would silently delete
the cloudiest seasons, which is the very thing the coverage features are
meant to expose; the flag keeps "we did not see this" a fact the forest can
split on instead of a fabricated observation.
"""
import argparse
import csv
from collections import defaultdict
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from app.crops import INDEX_FEATURES
from scripts.build_temporal_features import SEGMENTS, feature_columns

DATA = Path(__file__).resolve().parents[1] / "data"
# Every artifact this experiment produces lives OUTSIDE the ml-service tree,
# in experimental/temporal_features/. The experimental model sat in app/ for
# one run and that is one run too many: app/model.pkl is loaded by path, so a
# rename or a tab-completion slip is all that stands between a research
# artifact and the production predictor. Separate directories remove the
# possibility rather than relying on the filename.
EXPERIMENT = Path(__file__).resolve().parents[2] / "experimental" / "temporal_features"
EXP_CSV = EXPERIMENT / "training_data_temporal_experiment.csv"
OUT_MODEL = EXPERIMENT / "model_temporal_experiment.pkl"

# The same holdout as scripts.train_real, so the numbers below sit beside the
# production model's without a caveat.
TEST_SEASONS = {"2021-22", "2022-23"}

# Section 11's second design: train on everything up to a cut and test on the
# seasons after it. Nothing from the future reaches the training set, which
# the fixed holdout above does not guarantee (it trains on 2023-24 and 2024-25
# while testing on 2021-22).
TIME_AWARE_TRAIN_UNTIL = "2022-23"

# Coverage/quality columns: how well the season was SEEN, as opposed to what
# was seen. Named once, used by both the ablation and the importance split.
COVERAGE = ("valid_observation_count", "early_observation_count",
            "mid_observation_count", "late_observation_count",
            "segments_covered", "cloud_pct_mean", "valid_px_mean",
            "first_obs_doy_frac", "last_obs_doy_frac", "max_gap_days")

RF_KWARGS = dict(n_estimators=500, max_depth=25, criterion="squared_error",
                 random_state=42, n_jobs=-1)

PROD = ["prod_%s" % k for k in INDEX_FEATURES]


def load():
    if not EXP_CSV.exists():
        raise SystemExit("missing %s -- run scripts.build_temporal_features first" % EXP_CSV)
    with EXP_CSV.open(newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        r["actual_yield"] = float(r["actual_yield"])
    return rows


def crops_of(rows):
    return sorted(set(r["crop"] for r in rows))


def matrix(rows, cols, crops):
    """(X, names). Every numeric column gets a companion _isna flag."""
    names = []
    for c in cols:
        names += [c, c + "_isna"]
    names += ["crop_%s" % c for c in crops]

    X = []
    for r in rows:
        v = []
        for c in cols:
            raw = r.get(c, "")
            if raw in ("", None):
                v += [np.nan, 1.0]
            else:
                v += [float(raw), 0.0]
        v += [1.0 if r["crop"] == c else 0.0 for c in crops]
        X.append(v)
    return np.array(X, dtype=float), names


def impute(Xtr, Xte):
    """Training-set medians, applied to both halves. Fitted on train only."""
    med = np.nanmedian(Xtr, axis=0)
    med = np.where(np.isnan(med), 0.0, med)
    return np.where(np.isnan(Xtr), med, Xtr), np.where(np.isnan(Xte), med, Xte)


def metrics(y, p):
    if len(y) < 2:
        return dict(n=len(y), r2=None, rmse=None, mae=None)
    return dict(n=len(y), r2=r2_score(y, p),
                rmse=float(np.sqrt(mean_squared_error(y, p))),
                mae=mean_absolute_error(y, p))


def run_arm(train, test, cols, crops, label):
    """Fit one feature set and return (metrics, per-crop metrics, model, names)."""
    crops_tr = sorted(set(r["crop"] for r in train))
    Xtr, names = matrix(train, cols, crops_tr)
    Xte, _ = matrix(test, cols, crops_tr)
    Xtr, Xte = impute(Xtr, Xte)
    ytr = np.array([r["actual_yield"] for r in train])
    yte = np.array([r["actual_yield"] for r in test])

    m = RandomForestRegressor(**RF_KWARGS).fit(Xtr, ytr)
    pred = m.predict(Xte)

    per = {}
    for c in crops:
        idx = [i for i, r in enumerate(test) if r["crop"] == c]
        if not idx:
            per[c] = dict(n=0, r2=None, rmse=None, mae=None, base=None)
            continue
        yc, pc = yte[idx], pred[idx]
        # Crop-mean baseline: predict this crop's TRAINING mean for every
        # holdout row. Scored on the same rows as the model, so the two are
        # comparable; it goes negative whenever the crop's mean moved between
        # the training seasons and the holdout, which is information about the
        # labels rather than a failure of the baseline.
        tr_c = [r["actual_yield"] for r in train if r["crop"] == c]
        base = (r2_score(yc, np.full(len(yc), float(np.mean(tr_c))))
                if tr_c and len(yc) > 1 else None)
        per[c] = dict(base=base, **metrics(yc, pc))

    print("  %-9s overall R2 %7.4f  RMSE %7.4f  MAE %7.4f  (%d features)"
          % (label, r2_score(yte, pred),
             float(np.sqrt(mean_squared_error(yte, pred))),
             mean_absolute_error(yte, pred), Xtr.shape[1]))
    return metrics(yte, pred), per, m, names


def importance_split(model, names):
    """(crop share, satellite share, coverage share, top columns)."""
    imp = dict(zip(names, model.feature_importances_))
    # Coverage/quality columns say how well the season was SEEN; satellite
    # columns say what was seen. Counted apart so a gain cannot be credited to
    # vegetation signal when it actually came from cloud bookkeeping.
    cov_prefixes = COVERAGE
    crop = sum(v for k, v in imp.items() if k.startswith("crop_"))
    cov = sum(v for k, v in imp.items() if k.startswith(cov_prefixes))
    sat = sum(imp.values()) - crop - cov
    top = sorted(imp.items(), key=lambda kv: -kv[1])[:15]
    return crop, sat, cov, top


def table(per, title):
    print("\n  %s" % title)
    print("    %-10s %5s %9s %8s %8s %9s %10s"
          % ("crop", "rows", "R2", "RMSE", "MAE", "baseR2", "improve"))
    for c in sorted(per):
        d = per[c]
        imp = (None if d["r2"] is None or d["base"] is None else d["r2"] - d["base"])
        print("    %-10s %5d %9s %8s %8s %9s %10s"
              % (c, d["n"], _f(d["r2"]), _f(d["rmse"]), _f(d["mae"]),
                 _f(d["base"]), _f(imp)))


def _f(v, p=4):
    return "n/a" if v is None else ("%.*f" % (p, v))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-save", action="store_true")
    args = ap.parse_args()

    rows = load()
    cols = feature_columns()
    crops = crops_of(rows)
    seasons = sorted(set(r["season"] for r in rows))

    print("rows %d   crops %d   seasons %s" % (len(rows), len(crops), seasons))
    print("columns: %d temporal, %d median-composite" % (len(cols), len(PROD)))

    train = [r for r in rows if r["season"] not in TEST_SEASONS]
    test = [r for r in rows if r["season"] in TEST_SEASONS]
    print("\n=== fixed holdout %s  (train %d / test %d) ==="
          % (sorted(TEST_SEASONS), len(train), len(test)))

    sets = (("median", PROD), ("temporal", cols), ("both", PROD + cols),
            ("no_px", [c for c in cols if c != "valid_px_mean"]),
            ("veg_only", [c for c in cols if c not in COVERAGE]))
    arms = {}
    for label, use in sets:
        arms[label] = run_arm(train, test, use, crops, label)

    for label in ("median", "temporal", "no_px", "veg_only", "both"):
        table(arms[label][1], "per crop -- %s" % label)

    print("\n=== feature-importance split ===")
    for label in ("median", "temporal", "no_px", "veg_only", "both"):
        crop_s, sat_s, cov_s, top = importance_split(arms[label][2], arms[label][3])
        print("  %-9s crop one-hot %6.2f%%   satellite %6.2f%%   coverage/quality %6.2f%%"
              % (label, 100 * crop_s, 100 * sat_s, 100 * cov_s))
    print("\n  temporal arm, 15 highest-importance columns:")
    for k, v in arms["temporal"][3] and importance_split(*arms["temporal"][2:4])[3]:
        print("    %-34s %.4f" % (k, v))

    # ---- time-aware validation ----------------------------------------
    later = [s for s in seasons if s > TIME_AWARE_TRAIN_UNTIL]
    print("\n=== time-aware validation: train <= %s, test %s ==="
          % (TIME_AWARE_TRAIN_UNTIL, later))
    ta_train = [r for r in rows if r["season"] <= TIME_AWARE_TRAIN_UNTIL]
    ta_test = [r for r in rows if r["season"] > TIME_AWARE_TRAIN_UNTIL]
    print("  train %d / test %d" % (len(ta_train), len(ta_test)))
    ta = {}
    for label, use in sets:
        ta[label] = run_arm(ta_train, ta_test, use, crops, label)
    for label in ("median", "temporal", "veg_only", "both"):
        table(ta[label][1], "per crop -- %s, time-aware" % label)

    if not args.no_save:
        m, names = arms["temporal"][2], arms["temporal"][3]
        joblib.dump({"model": m, "feature_names": names,
                     "note": "EXPERIMENTAL -- Step 11. Not the production model."},
                    OUT_MODEL)
        print("\nsaved experimental bundle -> %s" % OUT_MODEL)
    print("app/model.pkl and data/training_data_real.csv untouched by this script.")


if __name__ == "__main__":
    main()
