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

# Extra feature blocks, kept SEPARATE so the ablation can price each one.
# soc_raw is deliberately absent: its OpenLandMap scale direction is
# unverified (see app/land.py), and an unverified unit has no business in a
# trained model.
SOIL_FEATURES = ["ph", "clay_pct", "silt_pct", "sand_pct", "bulk_dens", "water_33k"]
WEATHER_FEATURES = ["tmax_mean_c", "tmin_mean_c", "tmax_peak_c",
                    "rain_mm", "frost_days", "hot_days_35c"]


def feature_names(use_soil, use_weather):
    """Column names for the variant actually being trained.

    Mirrors load()'s assembly order exactly -- idx + one_hot + soil + weather
    -- because app/main.py builds its inference vector by looking each of
    these names up in turn. A mismatch does not raise: a forest accepts 19
    numbers in the wrong order quite happily and returns a confident wrong
    yield. The saved bundle previously recorded the base 7 names for every
    variant, so a soil+weather model would have been unpromotable.
    """
    return (list(FEATURE_NAMES)
            + (SOIL_FEATURES if use_soil else [])
            + (WEATHER_FEATURES if use_weather else []))

DATA = Path(__file__).resolve().parents[1] / "data"
REAL_CSV = DATA / "training_data_real.csv"
SOIL_CSV = DATA / "district_soil.csv"
WEATHER_CSV = DATA / "district_season_weather.csv"
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


def _index(path, keys):
    """{tuple(key values): row} for an auxiliary CSV, or {} if absent."""
    if not path.exists():
        return {}
    with path.open(newline="", encoding="utf-8-sig") as fh:
        return {tuple(r[k] for k in keys): r for r in csv.DictReader(fh) if r.get(keys[0])}


def load(use_soil=False, use_weather=False):
    if not REAL_CSV.exists():
        sys.exit(f"missing {REAL_CSV}. Run: python -m scripts.build_training_dataset")

    soil_ix = _index(SOIL_CSV, ["district"]) if use_soil else {}
    wx_ix = _index(WEATHER_CSV, ["district", "season", "crop_type"]) if use_weather else {}
    if use_soil and not soil_ix:
        sys.exit(f"missing {SOIL_CSV}. Run: python -m scripts.fetch_district_land")
    if use_weather and not wx_ix:
        sys.exit(f"missing {WEATHER_CSV}. Run: python -m scripts.fetch_district_land")

    X, y, districts, seasons, crops, skipped = [], [], [], [], [], 0
    with REAL_CSV.open(newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            # Rows predating the crop_type column are wheat by definition.
            crop = (r.get("crop_type") or "wheat").strip()
            if crop not in CROPS:
                skipped += 1
                continue
            try:
                idx = [float(r[k]) for k in INDEX_FEATURES]
                yld = float(r["actual_yield"])
            except (KeyError, TypeError, ValueError):
                skipped += 1
                continue
            # One model across both crops, with crop as a real feature, rather
            # than two separate models. The one-hot order comes from
            # FEATURE_NAMES so the layout matches what app/main.py builds at
            # inference; a mismatch here misaligns columns silently.
            extra = []
            if use_soil:
                srow = soil_ix.get((r["district"],))
                if not srow:
                    skipped += 1
                    continue
                try:
                    extra += [float(srow[k]) for k in SOIL_FEATURES]
                except (KeyError, TypeError, ValueError):
                    skipped += 1
                    continue
            if use_weather:
                wrow = wx_ix.get((r["district"], r["season"], crop))
                if not wrow:
                    skipped += 1
                    continue
                try:
                    extra += [float(wrow[k]) for k in WEATHER_FEATURES]
                except (KeyError, TypeError, ValueError):
                    skipped += 1
                    continue

            X.append(idx + one_hot(crop) + extra)
            y.append(yld)
            districts.append(r["district"])
            seasons.append(r["season"])
            crops.append(crop)

    if skipped:
        print(f"  skipped {skipped} unusable row(s)")
    return (np.array(X), np.array(y), np.array(districts),
            np.array(seasons), np.array(crops))


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


def baselines(y, districts, crops, is_test):
    """Mean yield per (district, crop), computed from TRAINING rows only.

    Training rows only is not a detail. Build the baseline from all rows and
    each holdout row is normalised partly by its own value -- the target leaks
    into the transform and the holdout score becomes meaningless.
    """
    acc = {}
    for yi, d, c, t in zip(y, districts, crops, is_test):
        if t:
            continue
        acc.setdefault((d, c), []).append(yi)
    out = {k: float(np.mean(v)) for k, v in acc.items()}
    per_crop = {}
    for (d, c), v in acc.items():
        per_crop.setdefault(c, []).extend(v)
    fallback = {c: float(np.mean(v)) for c, v in per_crop.items()}
    return out, fallback


def to_anomaly(y, districts, crops, base, fallback):
    """Yield as a ratio to its district-crop norm, so crops share one scale."""
    scale = np.array([base.get((d, c), fallback.get(c, float(np.mean(y))))
                      for d, c in zip(districts, crops)])
    return y / scale, scale


def evaluate(X, y, districts, seasons, crops, is_test, anomaly=False, label=""):
    """Train, score and return the numbers. No saving, no side effects."""
    X_tr, y_tr, d_tr = X[~is_test], y[~is_test], districts[~is_test]
    X_te, y_te = X[is_test], y[is_test]

    if anomaly:
        base, fb = baselines(y, districts, crops, is_test)
        y_tr_fit, _ = to_anomaly(y_tr, districts[~is_test], crops[~is_test], base, fb)
        _, scale_te = to_anomaly(y_te, districts[is_test], crops[is_test], base, fb)
    else:
        y_tr_fit, scale_te = y_tr, None

    scores, how = cv_scores(X_tr, y_tr_fit, d_tr)
    grouped = grouped_scores(X_tr, y_tr_fit, d_tr)

    rf = RandomForestRegressor(**RF_KWARGS)
    rf.fit(X_tr, y_tr_fit)
    pred = rf.predict(X_te)
    # Back-transform before scoring, so every variant is judged on the SAME
    # t/ha scale. Scoring an anomaly model on anomalies would not be comparable.
    if anomaly:
        pred = pred * scale_te

    return {
        "label": label,
        "anomaly": anomaly,
        "n_features": X.shape[1],
        "cv_mean": float(scores.mean()), "cv_std": float(scores.std()),
        "grouped_mean": float(grouped.mean()) if grouped is not None else None,
        "grouped_std": float(grouped.std()) if grouped is not None else None,
        "holdout_r2": r2_score(y_te, pred),
        "holdout_rmse": float(np.sqrt(mean_squared_error(y_te, pred))),
        "holdout_mae": mean_absolute_error(y_te, pred),
        "cv_method": how, "model": rf, "scores": scores, "grouped": grouped,
    }


def ablation():
    """Price each feature block separately, on the same rows and the same split.

    The ORDER of the columns is the point. cv_r2 flatters static per-district
    features because the same district sits in train and test, so the forest
    can look them up. grouped_r2 holds whole districts out, which is the only
    number that answers "would this work on a district we have never seen?".
    A variant that lifts cv and drops grouped has learned a fingerprint.
    """
    variants = [
        ("base (indices + crop)", False, False, False),
        ("PLACEBO district id",   False, False, False),   # handled below
        ("+ soil (static)",       True,  False, False),
        ("+ weather (per season)", False, True,  False),
        ("+ soil + weather",      True,  True,  False),
        ("+ both, anomaly target", True, True,  True),
    ]
    rows = []
    for label, soil, wx, anom in variants:
        try:
            X, y, districts, seasons, crops = load(use_soil=soil, use_weather=wx)
        except SystemExit as e:
            print(f"  {label:26s} SKIPPED -- {e}")
            continue
        is_test = np.isin(seasons, list(TEST_SEASONS))
        if len(y) == 0 or is_test.sum() == 0:
            print(f"  {label:26s} SKIPPED -- no usable rows")
            continue

        if label.startswith("PLACEBO"):
            # Six RANDOM numbers, constant per district. Carries no agronomic
            # information whatsoever, but is exactly as good a district
            # IDENTIFIER as the six soil columns are. Any holdout gain it shows
            # is gain that soil would also get for free, without knowing
            # anything about soil -- because the holdout splits by SEASON, so
            # every holdout district was already seen in training.
            #
            # This is the control that keeps the soil result honest. Read the
            # grouped column for it: with whole districts held out the fake ID
            # is pure noise, so it should FALL below base. If it does not, the
            # grouped split is not doing its job either.
            rng = np.random.default_rng(0)
            fake = {k: rng.normal(size=6) for k in sorted(set(districts))}
            X = np.hstack([X, np.array([fake[k] for k in districts])])

        rows.append(evaluate(X, y, districts, seasons, crops, is_test, anom, label))

    head = (f"\n{'variant':26s} {'feat':>4s} {'cv R2':>16s} "
            f"{'grouped R2':>16s} {'holdout R2':>11s} {'RMSE':>7s}")
    print(head)
    print("-" * (len(head) - 1))
    for r in rows:
        # The anomaly variant fits a DIFFERENT target (yield / district norm),
        # so its CV and grouped scores are computed on that scale and are not
        # comparable with the rows above. Only holdout is, because holdout is
        # back-transformed to t/ha before scoring. Marked rather than printed
        # as if it were the same number.
        if r["anomaly"]:
            cv = g = "n/c (anomaly)"
        else:
            cv = f"{r['cv_mean']:.3f} +/-{r['cv_std']:.3f}"
            g = (f"{r['grouped_mean']:.3f} +/-{r['grouped_std']:.3f}"
                 if r["grouped_mean"] is not None else "n/a")
        print(f"{r['label']:26s} {r['n_features']:4d} {cv:>16s} {g:>16s} "
              f"{r['holdout_r2']:11.4f} {r['holdout_rmse']:7.4f}")
    print("-" * (len(head) - 1))
    print("cv R2      : same districts in train and test -- flatters static features")
    print("grouped R2 : whole districts held out -- the generalisation number")
    print("holdout    : 2021-22 + 2022-23, never seen in any fold")
    print("n/c        : target is on the anomaly scale, so not comparable above;")
    print("             only this row's holdout (back-transformed to t/ha) compares")
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-save", action="store_true", help="evaluate only")
    ap.add_argument("--ablation", action="store_true",
                    help="compare feature blocks; never saves")
    ap.add_argument("--soil", action="store_true", help="include district soil")
    ap.add_argument("--weather", action="store_true", help="include season weather")
    args = ap.parse_args()

    if args.ablation:
        ablation()
        return

    X, y, districts, seasons, crops = load(use_soil=args.soil, use_weather=args.weather)
    is_test = np.isin(seasons, list(TEST_SEASONS))
    X_tr, y_tr, d_tr = X[~is_test], y[~is_test], districts[~is_test]
    X_te, y_te = X[is_test], y[is_test]

    print(f"rows: {len(y)}   train: {len(y_tr)}   holdout: {len(y_te)}")
    print(f"train seasons : {sorted(set(seasons[~is_test]))}")
    print(f"holdout seasons: {sorted(set(seasons[is_test]))}")
    print(f"districts: {len(set(districts))}")
    for c in sorted(set(crops)):
        n_tr = int(((crops == c) & ~is_test).sum())
        n_te = int(((crops == c) & is_test).sum())
        print(f"  {c:6s} train={n_tr:4d}  holdout={n_te:4d}")
        if n_tr == 0:
            print(f"         ^ NO training rows for {c}: the model will refuse it at /predict")
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

    names = feature_names(args.soil, args.weather)
    print("\nimportances:", dict(zip(names, rf.feature_importances_.round(3))))

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
        "feature_names": names,
        # Read off the data, not hardcoded: app/main.py refuses any crop not
        # in this list, so it must reflect what was actually trained on.
        "trained_crops": sorted({c for c, t in zip(crops, is_test) if not t}),
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
