"""Train the yield model.

    python -m app.train

Prefers real data at data/training.csv (written by scripts/fetch_historical_ndvi.py
once you have filled in the PBS yield column). Falls back to a synthetic WHEAT-ONLY
set when that file has no usable rows, so the endpoint still works before any
field data exists.

The saved bundle records WHICH CROPS IT ACTUALLY SAW. app/main.py refuses to
predict for a crop that is not in that set -- with no rice rows in the CSV, a
rice request gets an error, not a wheat-shaped guess wearing a rice label.
"""
import csv
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split

from app.districts import CROPS, FEATURE_NAMES, INDEX_FEATURES, one_hot

MODEL_PATH = Path(__file__).parent / "model.pkl"
CSV_PATH = Path(__file__).resolve().parents[1] / "data" / "training.csv"
MODEL_NAME = "RandomForest-v2"

# Back-compat: main.py and the old smoke tests import FEATURES.
FEATURES = INDEX_FEATURES


def load_csv(path=CSV_PATH):
    """Rows from training.csv that have BOTH indices and a yield.

    Rows with an empty yield_t_ha are the ones still waiting on PBS numbers --
    they are skipped, not treated as zero. A zero-yield row would teach the
    model that healthy NDVI sometimes means total crop failure.
    """
    if not path.exists():
        return [], []

    X, y, skipped = [], [], 0
    with path.open(newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            crop = (row.get("crop_type") or "").strip()
            yld = (row.get("yield_t_ha") or "").strip()
            if crop not in CROPS or not yld:
                skipped += 1
                continue
            try:
                idx = [float(row[k]) for k in INDEX_FEATURES]
                y.append(float(yld))
            except (KeyError, TypeError, ValueError):
                skipped += 1
                continue
            X.append(idx + one_hot(crop))

    if skipped:
        print(f"  skipped {skipped} row(s) with no yield / unusable values")
    return X, y


def synth(n=160, seed=42):
    """Synthetic WHEAT data. See the NDVI saturation reasoning below.

    Deliberately not extended to rice: inventing a rice curve would produce
    exactly the confident-but-baseless rice predictions this pipeline is
    supposed to refuse.
    """
    rng = np.random.default_rng(seed)

    # Sentinel-2 NDVI over healthy wheat between tillering and grain fill.
    ndvi = rng.uniform(0.35, 0.85, n)

    # Saturating yield response, scaled to Punjab reality (~3 t/ha at NDVI 0.6).
    # Canopy reflectance stops responding once the canopy closes, so a linear
    # fit would invent yields above 6 t/ha that do not exist here.
    y = 5.0 * (1 - np.exp(-3.0 * np.clip(ndvi - 0.20, 0, None)))

    # NDWI = canopy water, independent-ish of NDVI, so it carries real signal:
    # a green-but-dry field yields less than a green wet one.
    ndwi = 0.30 * ndvi + rng.uniform(-0.10, 0.25, n)
    y += 1.2 * (ndwi - 0.15)

    # SAVI is soil-adjusted NDVI, EVI is atmosphere-corrected NDVI -- both are
    # ~collinear with it, and in the model because the schema has them.
    savi = 0.85 * ndvi + rng.normal(0, 0.03, n)
    evi = 0.80 * ndvi - 0.05 + rng.normal(0, 0.04, n)

    # NBR is a BURN index. For wheat it is noise. Expect ~0 importance.
    nbr = rng.uniform(-0.10, 0.40, n)

    y += rng.normal(0, 0.35, n)      # field-to-field variation
    y = np.clip(y, 0.8, 6.0)

    wheat = one_hot("wheat")
    X = [[a, b, c, d, e] + wheat for a, b, c, d, e in zip(ndvi, evi, ndwi, savi, nbr)]
    return X, list(y)


# 3 districts x 5 seasons = 15 rows per crop, so the real-data path has to
# accept a set that small. Below this we fall back to synthetic rather than
# fit 7 features to a handful of points.
MIN_CSV_ROWS = 8

# Under this many rows a 25% holdout is 3-4 points, and its R2 is noise, not
# a measurement. Use the forest's own out-of-bag score instead: every tree
# scores the ~37% of rows it did not sample, so the whole set trains AND gets
# evaluated. This is the regime the project is actually in until far more
# seasons are collected.
SMALL_DATA_ROWS = 30


def load_training_data():
    """Returns (X, y, crops_present, source)."""
    X, y = load_csv()
    source = f"csv:{CSV_PATH.name}"
    if len(y) < MIN_CSV_ROWS:
        if y:
            print(f"  only {len(y)} usable CSV row(s), need {MIN_CSV_ROWS}; using synthetic")
        else:
            print(f"  no usable rows in {CSV_PATH}; using synthetic")
        X, y = synth()
        source = "synthetic-wheat"

    # Which crops are actually represented, read back off the one-hot columns.
    n_idx = len(INDEX_FEATURES)
    crops = {CROPS[i] for row in X for i, v in enumerate(row[n_idx:]) if v == 1.0}
    return np.array(X), np.array(y), sorted(crops), source


def train():
    X, y, crops, source = load_training_data()
    print(f"source={source}  rows={len(y)}  crops={crops}")

    small = len(y) < SMALL_DATA_ROWS
    kw = dict(n_estimators=200, random_state=42, n_jobs=-1)

    if small:
        # min_samples_leaf=1 here: with a dozen rows, forcing 2 per leaf leaves
        # the tree almost no splits to make.
        rf = RandomForestRegressor(min_samples_leaf=1, oob_score=True, bootstrap=True, **kw)
        rf.fit(X, y)
        pred, y_te = rf.oob_prediction_, y
        print(f"oob R2={rf.oob_score_:.3f} MAE={mean_absolute_error(y, pred):.3f} t/ha "
              f"({len(y)} rows, no holdout -- too few to split)")
    else:
        # min_samples_leaf=2: with 100+ rows, leaves of 1 memorise the noise.
        rf = RandomForestRegressor(min_samples_leaf=2, **kw)
        X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25, random_state=42)
        rf.fit(X_tr, y_tr)
        pred = rf.predict(X_te)
        print(f"holdout R2={r2_score(y_te, pred):.3f} MAE={mean_absolute_error(y_te, pred):.3f} t/ha")

    print("importances:", dict(zip(FEATURE_NAMES, rf.feature_importances_.round(3))))

    if len(crops) < len(CROPS):
        missing = [c for c in CROPS if c not in crops]
        print(f"  WARNING: no training rows for {missing}. Predictions for those "
              f"crops will be REFUSED at /predict until such rows exist.")

    joblib.dump(
        {
            "model": rf,
            "feature_names": FEATURE_NAMES,
            "trained_crops": crops,
            "source": source,
            "n_rows": len(y),
            "model_name": MODEL_NAME,
        },
        MODEL_PATH,
    )
    print(f"saved -> {MODEL_PATH}")
    return rf, crops, y_te, pred, small


if __name__ == "__main__":
    rf, crops, y_te, pred, small = train()

    # Self-check: the properties that make a prediction meaningful.
    # A 15-row real-data fit legitimately scores badly, so the R2 floor only
    # applies to the synthetic set, where a drop means the code broke.
    if not small:
        assert r2_score(y_te, pred) > 0.70, "model no longer explains the training signal"

    wheat = one_hot("wheat")
    low = rf.predict([[0.40, 0.27, 0.22, 0.34, 0.1] + wheat])[0]
    high = rf.predict([[0.80, 0.59, 0.34, 0.68, 0.1] + wheat])[0]
    assert high > low + 0.8, "yield must rise with NDVI"
    assert 1.0 < low < 6.0 and 1.0 < high < 6.0, "yields outside plausible Punjab range"

    ndvi_imp = dict(zip(FEATURE_NAMES, rf.feature_importances_))["ndvi"]
    assert ndvi_imp > 0.25, "NDVI should dominate; check the training data"
    assert crops, "model recorded no trained crops"
    print("self-check OK")
