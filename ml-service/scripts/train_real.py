"""Step 3: train and validate the production model on real PBS yields.

    python -m scripts.train_real
    python -m scripts.train_real --no-save     # evaluate only, leave model.pkl alone

Methodology (scope doc, with two documented deviations -- see NOTES):
  - Holdout  : 2021-22 and 2022-23 held out entirely (season-based, not random)
  - CV       : 5-fold on the training seasons, stratified by district where
               group sizes allow, reported as mean +/- std across folds
  - Model    : RandomForestRegressor, 500 trees, max_depth=25

NOTES / deviations, both forced by the data rather than chosen:

1. criterion="squared_error", NOT "Gini impurity". Gini is a CLASSIFICATION
   criterion; sklearn's RandomForestRegressor rejects it outright
   (InvalidParameterError: must be one of absolute_error, squared_error,
   poisson). Yield is continuous, so this is regression and MSE is the
   regression analogue of what the scope doc meant. Worth correcting in the
   document -- an examiner will notice "Gini" on a regressor.

2. Stratifying 5 folds by district is arithmetically impossible here: the
   training seasons give each district ~3 rows, and StratifiedKFold needs at
   least one member per class per fold. The script detects this and falls back
   to plain KFold, saying so. See GroupKFold below for why this matters more
   than it looks.
"""
import argparse
import csv
import shutil
import sys
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GroupKFold, KFold, StratifiedKFold, cross_val_score

from app.districts import CROPS, FEATURE_NAMES, INDEX_FEATURES, one_hot

DATA = Path(__file__).resolve().parents[1] / "data"
REAL_CSV = DATA / "training_data_real.csv"
MODEL_PATH = Path(__file__).resolve().parents[1] / "app" / "model.pkl"
FALLBACK_PATH = MODEL_PATH.with_name("model_synthetic.pkl")

TEST_SEASONS = {"2021-22", "2022-23"}
N_FOLDS = 5
MODEL_NAME = "RandomForest-real-v1"

RF_KWARGS = dict(
    n_estimators=500,
    max_depth=25,
    criterion="squared_error",   # see NOTE 1
    random_state=42,
    n_jobs=-1,
)


def load():
    if not REAL_CSV.exists():
        sys.exit(f"missing {REAL_CSV}. Run: python -m scripts.build_training_dataset")

    X, y, districts, seasons, skipped = [], [], [], [], 0
    with REAL_CSV.open(newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            try:
                idx = [float(r[k]) for k in INDEX_FEATURES]
                yld = float(r["actual_yield"])
            except (KeyError, TypeError, ValueError):
                skipped += 1
                continue
            # Crop one-hot kept even though every row is wheat: the production
            # model in app/main.py builds its vector from FEATURE_NAMES, so the
            # layouts must match or the swap silently misaligns columns.
            X.append(idx + one_hot("wheat"))
            y.append(yld)
            districts.append(r["district"])
            seasons.append(r["season"])

    if skipped:
        print(f"  skipped {skipped} unusable row(s)")
    return np.array(X), np.array(y), np.array(districts), np.array(seasons)


def cv_scores(X, y, districts):
    """5-fold CV R2. Stratified by district when feasible, else plain KFold."""
    counts = {d: int((districts == d).sum()) for d in set(districts)}
    smallest = min(counts.values()) if counts else 0

    if smallest >= N_FOLDS:
        splitter = StratifiedKFold(n_splits=N_FOLDS, shuffle=True, random_state=42)
        scores = cross_val_score(RandomForestRegressor(**RF_KWARGS), X, y,
                                 cv=splitter.split(X, districts), scoring="r2")
        how = f"StratifiedKFold by district (min {smallest} rows/district)"
    else:
        splitter = KFold(n_splits=N_FOLDS, shuffle=True, random_state=42)
        scores = cross_val_score(RandomForestRegressor(**RF_KWARGS), X, y,
                                 cv=splitter, scoring="r2")
        how = (f"KFold (stratification by district impossible: smallest district "
               f"has {smallest} row(s), needs >= {N_FOLDS})")
    return np.array(scores), how


def grouped_scores(X, y, districts):
    """R2 with whole districts held out.

    The honest generalisation number. With ~3 seasons per district, ordinary CV
    puts the same district in train and test, so the forest can score well by
    memorising each district's mean yield rather than learning anything from
    NDVI. If this number collapses relative to the CV number, that is what has
    happened -- and it is the question an examiner will ask.
    """
    n_groups = len(set(districts))
    k = min(N_FOLDS, n_groups)
    if k < 2:
        return None
    return np.array(cross_val_score(
        RandomForestRegressor(**RF_KWARGS), X, y,
        cv=GroupKFold(n_splits=k), groups=districts, scoring="r2"))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-save", action="store_true", help="evaluate only")
    args = ap.parse_args()

    X, y, districts, seasons = load()
    is_test = np.isin(seasons, list(TEST_SEASONS))
    X_tr, y_tr, d_tr = X[~is_test], y[~is_test], districts[~is_test]
    X_te, y_te = X[is_test], y[is_test]

    print(f"rows: {len(y)}   train: {len(y_tr)}   holdout: {len(y_te)}")
    print(f"train seasons : {sorted(set(seasons[~is_test]))}")
    print(f"holdout seasons: {sorted(set(seasons[is_test]))}")
    print(f"districts: {len(set(districts))}")
    if len(y_te) == 0:
        sys.exit("holdout is empty -- no 2021-22 / 2022-23 rows were built")

    # ---- cross-validation on the training seasons ------------------------
    scores, how = cv_scores(X_tr, y_tr, d_tr)
    print(f"\n5-fold CV ({how})")
    print(f"  fold R2: {', '.join(f'{s:.3f}' for s in scores)}")
    print(f"  R2 = {scores.mean():.3f} +/- {scores.std():.3f}")

    grouped = grouped_scores(X_tr, y_tr, d_tr)
    if grouped is not None:
        print(f"\nGroupKFold by district (districts unseen in their test fold)")
        print(f"  fold R2: {', '.join(f'{s:.3f}' for s in grouped)}")
        print(f"  R2 = {grouped.mean():.3f} +/- {grouped.std():.3f}")
        print("  ^ the generalisation number. A large gap below the CV figure means"
              "\n    the model is largely recalling district means, not reading NDVI.")

    # ---- holdout ---------------------------------------------------------
    rf = RandomForestRegressor(**RF_KWARGS)
    rf.fit(X_tr, y_tr)
    pred = rf.predict(X_te)

    r2 = r2_score(y_te, pred)
    rmse = float(np.sqrt(mean_squared_error(y_te, pred)))
    mae = mean_absolute_error(y_te, pred)

    print(f"\nHOLDOUT ({', '.join(sorted(TEST_SEASONS))}, n={len(y_te)})")
    print(f"  R2   = {r2:.4f}")
    print(f"  RMSE = {rmse:.4f} t/ha")
    print(f"  MAE  = {mae:.4f} t/ha")
    print(f"  mean actual = {y_te.mean():.3f} t/ha   mean predicted = {pred.mean():.3f} t/ha")

    if r2 < 0.78:
        print(f"\n  Below the literature-based 0.78-0.84 expectation. Reported as computed;"
              f"\n  no tuning applied to reach a target number.")

    print("\nimportances:", dict(zip(FEATURE_NAMES, rf.feature_importances_.round(3))))

    if args.no_save:
        print("\n--no-save: model.pkl untouched")
        return

    # ---- save, keeping the synthetic model as a labelled fallback --------
    if MODEL_PATH.exists():
        try:
            old = joblib.load(MODEL_PATH)
            if str(old.get("source", "")).startswith("synthetic") and not FALLBACK_PATH.exists():
                shutil.copy2(MODEL_PATH, FALLBACK_PATH)
                print(f"\nkept synthetic model as {FALLBACK_PATH.name}")
        except Exception as e:
            print(f"\ncould not inspect existing model ({e}); not overwriting fallback")

    joblib.dump({
        "model": rf,
        "feature_names": FEATURE_NAMES,
        "trained_crops": ["wheat"],       # rice still has no rows; /predict refuses it
        "source": f"real:{REAL_CSV.name}",
        "n_rows": int(len(y_tr)),
        "model_name": MODEL_NAME,
        "metrics": {
            "holdout_r2": round(r2, 4),
            "holdout_rmse": round(rmse, 4),
            "holdout_mae": round(mae, 4),
            "cv_r2_mean": round(float(scores.mean()), 4),
            "cv_r2_std": round(float(scores.std()), 4),
            "cv_method": how,
            "grouped_r2_mean": round(float(grouped.mean()), 4) if grouped is not None else None,
            "test_seasons": sorted(TEST_SEASONS),
        },
    }, MODEL_PATH)
    print(f"saved production model -> {MODEL_PATH}")
    print("Restart the API to load it.")


if __name__ == "__main__":
    main()
