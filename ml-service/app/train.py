"""Synthetic wheat training set + Random Forest.

Run once:  python -m app.train

We have no real Sheikhupura yield records yet, so the training set is
fabricated -- but not arbitrarily. The NDVI->yield curve below reproduces two
things that are true of wheat in Punjab and that a hardcoded number would not:

  1. Yield SATURATES in NDVI. Canopy reflectance stops responding once the
     canopy closes (~NDVI 0.8), so the curve is exponential-approach, not
     linear. A linear fit would invent yields above 6 t/ha that don't exist.
  2. Punjab wheat sits around 2.5-4 t/ha. The curve is scaled to land there,
     so the demo number is defensible in the FYP report.

Replace synth() with a real CSV the moment crop-cut survey data exists;
nothing else in the service changes.
"""
import numpy as np
import joblib
from pathlib import Path
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import r2_score, mean_absolute_error

MODEL_PATH = Path(__file__).parent / "model.pkl"
FEATURES = ["ndvi", "evi", "ndwi", "savi", "nbr"]
MODEL_NAME = "RandomForest-synthetic-v1"


def synth(n=160, seed=42):
    """Returns (X [n,5], y [n]) in tonnes/hectare."""
    rng = np.random.default_rng(seed)

    # Sentinel-2 NDVI over healthy wheat between tillering and grain fill.
    ndvi = rng.uniform(0.35, 0.85, n)

    # Saturating yield response, scaled to Punjab reality (~3 t/ha at NDVI 0.6).
    y = 5.0 * (1 - np.exp(-3.0 * np.clip(ndvi - 0.20, 0, None)))

    # NDWI = canopy water. Independent-ish of NDVI, so it carries real extra
    # signal: a green-but-dry field yields less than a green wet one.
    ndwi = 0.30 * ndvi + rng.uniform(-0.10, 0.25, n)
    y += 1.2 * (ndwi - 0.15)

    # SAVI is soil-adjusted NDVI and EVI is atmosphere-corrected NDVI -- both
    # are ~collinear with it. They are in the model because the schema has
    # them, not because they add much.
    savi = 0.85 * ndvi + rng.normal(0, 0.03, n)
    evi = 0.80 * ndvi - 0.05 + rng.normal(0, 0.04, n)

    # NBR is a BURN index. For wheat it is noise. Kept so the feature vector
    # matches satellite_features; expect ~0 importance, and that is the
    # correct result, not a bug.
    nbr = rng.uniform(-0.10, 0.40, n)

    y += rng.normal(0, 0.35, n)          # field-to-field variation
    y = np.clip(y, 0.8, 6.0)

    return np.column_stack([ndvi, evi, ndwi, savi, nbr]), y


def train():
    X, y = synth()
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25, random_state=42)

    # min_samples_leaf=2: with 120 training rows, leaves of 1 memorise the noise.
    rf = RandomForestRegressor(
        n_estimators=200, min_samples_leaf=2, random_state=42, n_jobs=-1
    )
    rf.fit(X_tr, y_tr)

    pred = rf.predict(X_te)
    print(f"holdout R2={r2_score(y_te, pred):.3f} MAE={mean_absolute_error(y_te, pred):.3f} t/ha")
    print("importances:", dict(zip(FEATURES, rf.feature_importances_.round(3))))

    joblib.dump(rf, MODEL_PATH)
    print(f"saved -> {MODEL_PATH}")
    return rf, X_te, y_te, pred


if __name__ == "__main__":
    rf, X_te, y_te, pred = train()

    # Self-check: the three properties that make the prediction meaningful.
    assert r2_score(y_te, pred) > 0.75, "model no longer explains the synthetic signal"

    low, high = rf.predict([[0.40, 0.27, 0.22, 0.34, 0.1]])[0], \
                rf.predict([[0.80, 0.59, 0.34, 0.68, 0.1]])[0]
    assert high > low + 0.8, "yield must rise with NDVI"
    assert 1.0 < low < 6.0 and 1.0 < high < 6.0, "yields outside plausible Punjab range"

    ndvi_imp = dict(zip(FEATURES, rf.feature_importances_))["ndvi"]
    assert ndvi_imp > 0.25, "NDVI should dominate; check synth()"
    print("self-check OK")
