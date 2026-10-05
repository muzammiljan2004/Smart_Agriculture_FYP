"""Researcher portal — training and evaluation executor.

THE PORTAL IS THE CONTROL SURFACE; THIS IS WHERE THE WORK HAPPENS. Nothing in
`frontend/src/research` fits a model. The portal inserts a `model_runs` row and
POSTs its id here; this module reads the row, does the work, and writes the
metrics back.

WHERE AUTHORISATION LIVES, and why it is not re-checked here.

The insert policies on `model_runs` are the permission gate: a researcher
without `can_run_models` cannot create an evaluation row, and one without
`can_train_models` cannot create a training row -- Postgres refuses, even for a
request crafted straight at PostgREST. So a queued row that exists is a row
somebody was allowed to create, and this module's job is to execute it, not to
second-guess who asked. What it DOES verify is that the row is still `queued`,
which is what stops the same job being run twice.

THE ASYNC MECHANISM IS A DAEMON THREAD, matching `app/gee.py`. The project has
no queue, no broker and no realtime subscription, and adding one for this would
be new infrastructure. So a request returns as soon as the job is accepted, the
work proceeds on a daemon thread, and the portal POLLS `job_status` plus
`model_run_logs` -- the same useQuery/reload path every other screen uses.

Consequence, stated plainly: a job dies if the service restarts mid-run. It is
left `running` forever rather than being retried, because a half-trained model
silently resuming is worse than one that visibly never finished. `reap_stale()`
marks those failed on the next startup.
"""
from __future__ import annotations

import csv
import io
import re
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np

from app.db import db

# Uploaded datasets land beside the committed ones rather than in a Supabase
# Storage bucket -- no bucket is configured in this project, and the ML service
# already reads its training data from this directory.
DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "research"
MODEL_DIR = Path(__file__).resolve().parent / "models" / "research"

# Trained artefacts. *.pkl is already gitignored, which is what we want: a
# 70 MB forest per training run has no business in the repository.
MODEL_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

INDEX_COLUMNS = ("ndvi", "evi", "ndwi", "savi", "nbr")
TARGET_COLUMN = "actual_yield"
TEMPORAL_COLUMNS = ("date", "season")  # at least one required

# COLUMN ALIASES, so this project's own files upload without being renamed.
#
# experimental/temporal_features/training_data_temporal_experiment.csv names its
# season-median composites `prod_ndvi` ... `prod_nbr` and its crop column `crop`.
# That is the same representation the production model trains on, under
# different headings -- and rejecting it for the headings would mean the
# researcher portal cannot read the project's own experimental dataset.
#
# First match wins, and a canonical column always beats its alias: a file
# carrying both `ndvi` and `prod_ndvi` uses `ndvi`.
COLUMN_ALIASES = {
    "ndvi": ("prod_ndvi",),
    "evi": ("prod_evi",),
    "ndwi": ("prod_ndwi",),
    "savi": ("prod_savi",),
    "nbr": ("prod_nbr",),
    "crop_type": ("crop",),
}

# WHAT IS DELIBERATELY *NOT* PICKED UP from that file.
#
# It carries ~90 further engineered columns -- q1-q5 level means, growth and
# decline slopes, peak timing, and a coverage/quality block. They are not used,
# and auto-including every numeric column would be actively harmful: the
# coverage block contains `valid_px_mean`, which docs/step11_temporal_experiment.md
# §4 records as a DISTRICT-IDENTITY PROXY that inflated holdout R2 from 0.9311
# to 0.9465 until it was ablated out. Hoovering up unknown numeric columns would
# silently re-introduce exactly the leak this project found and removed.
#
# TODO(temporal): to train on the temporal block properly, add an explicit
# opt-in feature-group selector on screen 7 listing the groups by name, so a
# researcher chooses `veg_only` or `temporal` knowingly -- the arms the
# experiment actually compared.

# Optional blocks. Present -> used as features; absent -> the model trains on
# indices alone, which is what the production model already does.
WEATHER_COLUMNS = ("tmax_mean_c", "tmin_mean_c", "tmax_peak_c", "rain_mm")
SOIL_COLUMNS = ("ph", "clay_pct", "silt_pct", "sand_pct", "bulk_dens", "water_33k")

# WHICH MODEL TYPES CAN ACTUALLY BE TRAINED HERE.
#
# scikit-learn is the only ML library in requirements.txt, so RandomForest is
# the only entry that works today. The other three are listed because the brief
# and the portal both offer all four, and a type that is offered must fail with
# a reason rather than a traceback.
#
# TODO(models): XGBoost needs `xgboost` (sklearn-compatible, so it drops into
# `_fit_sklearn` with no other change). CNN and LSTM need tensorflow or torch
# plus a sequence-shaped feature builder -- that is the per-date observation
# format from experimental/temporal_features, not this flat matrix.
TRAINABLE = {"RandomForest"}
MODEL_REQUIREMENTS = {
    "XGBoost": "the `xgboost` package is not installed in this environment",
    "CNN": "no deep-learning backend is installed (needs tensorflow or torch) "
           "and CNN training needs the per-date sequence format, not the flat "
           "feature matrix this endpoint builds",
    "LSTM": "no deep-learning backend is installed (needs tensorflow or torch) "
            "and LSTM training needs the per-date sequence format, not the flat "
            "feature matrix this endpoint builds",
}


class DatasetInvalid(Exception):
    """The uploaded file is not a usable temporal dataset."""


# ------------------------------------------------------------------- scoping
#
# The portal lets a run be narrowed to one crop, district or season. Those come
# in as foreign keys on the run row, while the dataset is a flat CSV holding
# plain labels -- so the key has to be resolved to its label and matched against
# a column. The run row recording a crop_id while the fit used every crop is the
# worst of the available outcomes: two runs scoped to different crops return
# byte-identical metrics and the screen presents them as a per-crop comparison.
#
#   run column   -> (csv column, lookup table,   label column)
SCOPE_COLUMNS = {
    "crop_id": ("crop_type", "gov_crops", "name"),
    "district_id": ("district", "gov_districts", "name"),
    "season_id": ("season", "gov_seasons", "label"),
}


def _scope_of(run: dict) -> dict[str, str]:
    """Resolve the run's scope keys to lowercase labels, keyed by CSV column."""
    want: dict[str, str] = {}
    for key, (col, table, label) in SCOPE_COLUMNS.items():
        rid = run.get(key)
        if not rid:
            continue
        row = (db().table(table).select(label).eq("id", rid)
               .limit(1).execute().data or [None])[0]
        if not row:
            raise DatasetInvalid(
                f"The run is scoped to a {table[4:-1]} that no longer exists."
            )
        want[col] = str(row[label]).strip().lower()
    return want


def _resolve(cols: set[str]) -> dict[str, str]:
    """Map each canonical column name to the actual header present in the file.

    Returns only the ones that ARE present, so callers test membership on the
    canonical name and read through the mapping.
    """
    found = {}
    # The scope entries contribute their CSV column name (`district`), not the
    # run's key name (`district_id`) -- the file knows nothing about the keys.
    scope_cols = [col for col, _, _ in SCOPE_COLUMNS.values()]
    for canon in (list(INDEX_COLUMNS)
                  + [TARGET_COLUMN, "crop_type", *scope_cols, *TEMPORAL_COLUMNS]):
        if canon in cols:
            found[canon] = canon
            continue
        for alias in COLUMN_ALIASES.get(canon, ()):
            if alias in cols:
                found[canon] = alias
                break
    return found


# --------------------------------------------------------------- validation

def validate_csv(text: str) -> tuple[int, list[str]]:
    """Check an uploaded dataset against the expected temporal schema.

    Returns (record_count, notes). Raises DatasetInvalid with a message meant
    to be shown to the researcher -- the brief asks for "a clear UI error,
    never a silent failure or crash", so every rejection below names the
    column that is missing rather than saying "invalid".
    """
    if not text.strip():
        raise DatasetInvalid("The file is empty.")

    try:
        reader = csv.DictReader(io.StringIO(text))
        header = reader.fieldnames or []
    except csv.Error as e:
        raise DatasetInvalid(f"Could not parse as CSV: {e}") from e

    if not header:
        raise DatasetInvalid("The file has no header row.")

    cols = {h.strip().lower() for h in header}
    at = _resolve(cols)

    missing_idx = [c for c in INDEX_COLUMNS if c not in at]
    if missing_idx:
        alias_hint = ""
        for c in missing_idx:
            aliases = COLUMN_ALIASES.get(c, ())
            if aliases:
                alias_hint = (" Accepted alternative headings: "
                              + ", ".join(f"`{a}`" for a in
                                          sum((COLUMN_ALIASES.get(x, ()) for x in INDEX_COLUMNS), ()))
                              + ".")
                break
        raise DatasetInvalid(
            "Missing vegetation index column(s): " + ", ".join(missing_idx)
            + f". A temporal dataset needs all five of {', '.join(INDEX_COLUMNS)}."
            + alias_hint
        )

    if TARGET_COLUMN not in at:
        raise DatasetInvalid(
            f"Missing the target column `{TARGET_COLUMN}`. Without a label there "
            "is nothing to train against. A file of raw per-date observations "
            "(one row per satellite pass) has no yield to learn from -- the "
            "label lives in the per-season file and the two have to be joined "
            "before upload."
        )

    if not any(c in at for c in TEMPORAL_COLUMNS):
        raise DatasetInvalid(
            "Missing a temporal column: one of "
            + " or ".join(f"`{c}`" for c in TEMPORAL_COLUMNS)
            + " is required so observations can be ordered in time."
        )

    # Count rows that are actually usable. A row with no target teaches the
    # model nothing and a row with an unparseable index is worse than absent,
    # so both are excluded from the count the portal displays.
    usable = 0
    blank_target = 0
    bad_numbers = 0
    for row in reader:
        low = {(k or "").strip().lower(): v for k, v in row.items()}
        tgt = (low.get(at[TARGET_COLUMN]) or "").strip()
        if not tgt:
            blank_target += 1
            continue
        try:
            float(tgt)
            for c in INDEX_COLUMNS:
                v = (low.get(at[c]) or "").strip()
                if v:
                    float(v)
        except ValueError:
            bad_numbers += 1
            continue
        usable += 1

    if usable == 0:
        raise DatasetInvalid(
            "No usable rows: every row either has a blank "
            f"`{TARGET_COLUMN}` ({blank_target}) or a non-numeric value "
            f"({bad_numbers}). Nothing was saved."
        )

    notes = [f"{usable} usable rows"]
    if blank_target:
        notes.append(f"{blank_target} skipped (blank {TARGET_COLUMN})")
    if bad_numbers:
        notes.append(f"{bad_numbers} skipped (non-numeric)")
    present = [b for b, cs in (("weather", WEATHER_COLUMNS), ("soil", SOIL_COLUMNS))
               if any(c in cols for c in cs)]
    if "crop_type" in at:
        present.append("crop one-hot")
    notes.append("optional blocks present: " + (", ".join(present) if present else "none"))
    renamed = [f"{c} <- {at[c]}" for c in at if at[c] != c]
    if renamed:
        notes.append("resolved by alias: " + ", ".join(renamed))
    extra = len(cols) - len(at) - sum(1 for c in (*WEATHER_COLUMNS, *SOIL_COLUMNS) if c in cols)
    if extra > 10:
        notes.append(f"{extra} further columns present and NOT used as features "
                     "(see COLUMN_ALIASES note in app/research.py)")
    return usable, notes


# ------------------------------------------------------------------ logging

def _log(run_id: str, line: str) -> None:
    """Append one progress line. Never raises: a logging failure must not kill
    a training run that is otherwise fine."""
    try:
        db().table("model_run_logs").insert(
            {"model_run_id": run_id, "log_line": line[:2000]}
        ).execute()
    except Exception:  # noqa: BLE001 - logging is best effort by design
        pass


def _patch(run_id: str, **fields) -> None:
    db().table("model_runs").update(fields).eq("id", run_id).execute()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ----------------------------------------------------------------- features

def _load_matrix(path: Path,
                 scope: dict[str, str] | None = None,
                 ) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Read a dataset CSV into (X, y, feature_names).

    `scope` is {csv_column: lowercase_label} from `_scope_of`, and rows that do
    not match EVERY entry are dropped before anything is fitted. A scope naming
    a column the file does not carry raises rather than being ignored: a run
    recorded as crop-scoped whose numbers came from all eleven crops is a
    mislabelled result, which is worse than a refusal.

    Indices always; CROP ONE-HOT where the file names a crop; weather and soil
    only where the file carries them. Rows with a blank or unparseable target
    are dropped -- the same rule the validator counted by, so `record_count` on
    screen 3 matches what training actually saw.

    WHY THE CROP ONE-HOT IS NOT OPTIONAL WHEN A crop_type COLUMN EXISTS.
    This dataset pools crops whose yields span roughly 0.8 to 65 t/ha, so crop
    identity carries most of the variance in the target. Training on the five
    indices alone scored R2 0.12 against the production model's 0.92 on the
    SAME file -- not because the indices are weak, but because without knowing
    which crop a row is, the model cannot tell sugarcane from wheat and is
    reduced to predicting a single pooled mean.

    `train_real.py` builds `idx + crop_one_hot + soil + weather` in that order,
    and this now mirrors it, so a model trained here is comparable to the
    shipped one rather than quietly crippled.
    """
    rows = list(csv.DictReader(path.open(encoding="utf-8-sig")))
    if not rows:
        raise DatasetInvalid(f"{path.name} has no rows.")

    cols = {(k or "").strip().lower() for k in rows[0]}
    # Alias map, so `prod_ndvi` and `crop` are read as `ndvi` and `crop_type`.
    at = _resolve(cols)
    for c in (*INDEX_COLUMNS, TARGET_COLUMN):
        if c not in at:
            raise DatasetInvalid(f"{path.name} has no `{c}` column, under any accepted heading.")

    # Apply the scope FIRST, so everything downstream -- which crops get a
    # one-hot column, the medians, the split -- is computed on the rows the run
    # actually covers rather than on the whole file.
    for col, label in (scope or {}).items():
        if col not in at:
            raise DatasetInvalid(
                f"This run is scoped to {col.replace('_type', '')} '{label}', but "
                f"{path.name} has no `{col}` column, so the scope cannot be "
                "applied. Upload a file that carries it, or run without the filter."
            )
        # at[] holds the lowercase-stripped name; the file's own spelling is
        # what DictReader keys on, so resolve it once rather than per row.
        hdr = next((k for k in rows[0] if (k or "").strip().lower() == at[col]), None)
        rows = [r for r in rows if (r.get(hdr) or "").strip().lower() == label]
        if not rows:
            raise DatasetInvalid(
                f"No rows in {path.name} have {col} = '{label}'. Nothing to run on."
            )

    # Only the crops this file actually contains get a column. Encoding all
    # eleven when the file holds one would hand the forest ten constant-zero
    # features, and a model trained on a wheat-only file would then demand
    # columns no wheat-only evaluation set could supply.
    crops_present = []
    if "crop_type" in at:
        seen = {(r.get(at["crop_type"]) or "").strip().lower() for r in rows}
        crops_present = sorted(c for c in seen if c)

    feats = list(INDEX_COLUMNS)
    feats += [f"crop_{c}" for c in crops_present]
    feats += [c for c in WEATHER_COLUMNS if c in cols]
    feats += [c for c in SOIL_COLUMNS if c in cols]

    X: list[list[float]] = []
    y: list[float] = []
    for row in rows:
        low = {(k or "").strip().lower(): v for k, v in row.items()}
        tgt = (low.get(at[TARGET_COLUMN]) or "").strip()
        if not tgt:
            continue
        try:
            target = float(tgt)
            # A blank optional cell becomes NaN, not 0. Zero NDVI is a real
            # reading that means bare ground; using it for "unknown" would
            # teach the model that a missing observation looks like a dead
            # field. The imputer below replaces NaN with the training median.
            crop = (low.get(at.get("crop_type", "")) or "").strip().lower()
            vec = []
            for c in feats:
                if c.startswith("crop_"):
                    # A one-hot is never missing: the crop either is or is not
                    # this one. NaN here would be imputed to the column median,
                    # which for a one-hot is a meaningless fraction of a crop.
                    vec.append(1.0 if c == f"crop_{crop}" else 0.0)
                    continue
                # Read through the alias map: `ndvi` may live under `prod_ndvi`.
                v = (low.get(at.get(c, c)) or "").strip()
                vec.append(float(v) if v else float("nan"))
        except ValueError:
            continue
        X.append(vec)
        y.append(target)

    if not X:
        raise DatasetInvalid(f"{path.name} has no rows with a usable {TARGET_COLUMN}.")

    Xa = np.asarray(X, dtype=float)
    # Column medians, computed on the whole file here because this matrix is
    # split afterwards. Documented as a simplification: strictly the median
    # should be fitted on the train half alone.
    # ponytail: whole-file median imputation; fit on the train split only if
    # missingness ever rises above a few percent.
    med = np.nanmedian(Xa, axis=0)
    med = np.where(np.isnan(med), 0.0, med)
    Xa = np.where(np.isnan(Xa), med, Xa)
    return Xa, np.asarray(y, dtype=float), feats


def _split(X, y, ratio: float, seed: int = 42):
    """Deterministic shuffle split. Seeded so a re-run of the same config on
    the same dataset_version reproduces the same numbers -- which is the whole
    point of pinning a dataset_version in the first place."""
    n = len(y)
    rng = np.random.default_rng(seed)
    order = rng.permutation(n)
    cut = max(1, int(round(n * ratio)))
    tr, te = order[:cut], order[cut:]
    if len(te) == 0:  # tiny dataset: keep one row back rather than scoring on train
        tr, te = order[:-1], order[-1:]
    return X[tr], X[te], y[tr], y[te]


# ------------------------------------------------------------------ metrics

def _report(y_true, y_pred, *, feats, n_train, n_test, started, scope=None) -> dict:
    """The numbers the screen shows that are NOT model_runs columns.

    MSE, the residual summary, the split sizes and the feature list all belong
    to a run but do not each deserve a column -- they are written once, read as
    a block, and never filtered or sorted on. So they ride in
    run_config.report, which needs no migration and keeps the table's columns
    to the ones screens actually query.

    MSE is stored rather than left to the UI even though it is RMSE squared,
    because a reader comparing a reported MSE against a reported RMSE should
    not have to trust that two different places rounded the same way.
    """
    import time
    yt = np.asarray(y_true, dtype=float)
    yp = np.asarray(y_pred, dtype=float)
    err = yp - yt
    return {
        "mse": round(float(np.mean(err ** 2)), 6),
        "n_rows": int(len(yt) + n_train),
        "n_train": int(n_train),
        "n_test": int(len(yt)),
        "n_features": len(feats),
        "feature_names": list(feats),
        "mean_actual": round(float(yt.mean()), 6),
        # The spread of the TARGET on these rows, which is the yardstick R2 is
        # measured against: R2 = 1 - (rmse/std_actual)^2. Without it a negative
        # R2 looks like a broken run. Scoping to one crop cuts the spread from
        # 19.3 t/ha to 0.69, so an error that is modest pooled is disastrous
        # within a crop at an unchanged RMSE. Reported so the sign is readable.
        "std_actual": round(float(yt.std()), 6),
        "mean_predicted": round(float(yp.mean()), 6),
        "bias": round(float(err.mean()), 6),
        "residual_min": round(float(err.min()), 6),
        "residual_max": round(float(err.max()), 6),
        "residual_std": round(float(err.std()), 6),
        "within_1": round(float(np.mean(np.abs(err) <= 1.0)), 4),
        "within_2": round(float(np.mean(np.abs(err) <= 2.0)), 4),
        "duration_s": round(time.time() - started, 1),
        # What the numbers above were actually measured on. Without it two runs
        # over different crops are indistinguishable on screen except by the
        # foreign keys, which name the intent rather than the evidence.
        "scope": dict(scope) if scope else None,
    }


def _regression_metrics(y_true, y_pred) -> dict:
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
    return {
        "output_type": "regression",
        "r2": round(float(r2_score(y_true, y_pred)), 6),
        "rmse": round(float(np.sqrt(mean_squared_error(y_true, y_pred))), 6),
        "mae": round(float(mean_absolute_error(y_true, y_pred)), 6),
    }


def _classification_metrics(y_true, y_pred, labels) -> dict:
    """Metrics for a bucketed output.

    `zero_division=0` matters: a class the model never predicts has undefined
    precision, and the alternative to reporting 0 is a warning plus a NaN that
    then renders as a blank cell on screen 4.
    """
    from sklearn.metrics import (
        accuracy_score, confusion_matrix, f1_score, precision_score, recall_score,
    )
    return {
        "output_type": "classification",
        "accuracy": round(float(accuracy_score(y_true, y_pred)), 6),
        "precision_score": round(float(precision_score(
            y_true, y_pred, average="macro", zero_division=0)), 6),
        "recall": round(float(recall_score(
            y_true, y_pred, average="macro", zero_division=0)), 6),
        "f1_score": round(float(f1_score(
            y_true, y_pred, average="macro", zero_division=0)), 6),
        "confusion_matrix": {
            "labels": list(labels),
            "matrix": confusion_matrix(y_true, y_pred, labels=labels).tolist(),
        },
    }


# Yield-category buckets, in t/ha. Used only when a run asks for
# output_type='classification'; the boundaries are the ones the farmer-side
# advisory language already uses for low / moderate / good / high.
BUCKETS = ((1.5, "low"), (3.0, "moderate"), (4.5, "good"), (float("inf"), "high"))


def _bucket(v: float) -> str:
    for edge, name in BUCKETS:
        if v < edge:
            return name
    return BUCKETS[-1][1]


# ----------------------------------------------------------------- training

def _fit_sklearn(model_type: str, X, y, config: dict):
    """Fit one of the sklearn-API models. RandomForest today; XGBoost drops in
    here unchanged once the package is installed."""
    from sklearn.ensemble import RandomForestRegressor

    if model_type == "RandomForest":
        return RandomForestRegressor(
            n_estimators=int(config.get("n_estimators", 500)),
            max_depth=int(config["max_depth"]) if config.get("max_depth") else 25,
            random_state=42,
            n_jobs=-1,
        ).fit(X, y)

    raise DatasetInvalid(f"{model_type} has no sklearn fitter wired up.")


def _next_version_label(model_type: str) -> str:
    """`RandomForest-v3`, derived from the HIGHEST existing label of this type.

    NOT A ROW COUNT. A count is wrong twice over: this runs from inside
    _run_training, so the row being named is already in the table and the count
    includes it (which made the first model of a type come out as "v2"); and a
    count silently reuses a number after any row is removed, producing two
    versions with the same label and no constraint to catch it.

    Reading the maximum suffix already in use is immune to both. The row being
    labelled does not interfere because its own version_label is still null
    until this returns.
    """
    rows = (db().table("model_runs").select("version_label")
            .eq("run_kind", "training").eq("model_type", model_type)
            .not_.is_("version_label", "null").execute().data or [])
    used = []
    for r in rows:
        m = re.search(r"-v(\d+)$", r["version_label"] or "")
        if m:
            used.append(int(m.group(1)))
    return f"{model_type}-v{(max(used) + 1) if used else 1}"


def _run_training(run: dict) -> dict:
    import time
    started = time.time()
    run_id = run["id"]
    model_type = run["model_type"]
    config = run.get("run_config") or {}

    if model_type not in TRAINABLE:
        raise DatasetInvalid(
            f"{model_type} cannot be trained here: {MODEL_REQUIREMENTS[model_type]}."
        )

    ds = (db().table("dataset_versions").select("*")
          .eq("id", run["dataset_version_id"]).single().execute().data)
    if not ds:
        raise DatasetInvalid("The run references a dataset_version that no longer exists.")
    if not ds["schema_validated"]:
        raise DatasetInvalid(
            f"dataset_version {ds['id'][:8]} failed schema validation and cannot "
            "be trained on. Upload a corrected file."
        )

    path = Path(ds["storage_path"])
    if not path.is_absolute():
        path = DATA_DIR.parent / path
    if not path.exists():
        raise DatasetInvalid(f"Dataset file is missing from disk: {ds['storage_path']}")

    scope = _scope_of(run)
    _log(run_id, f"loading {path.name}"
          + (" scoped to " + ", ".join(f"{k}={v}" for k, v in scope.items())
             if scope else " (no scope filter: every row in the file)"))
    X, y, feats = _load_matrix(path, scope)
    _log(run_id, f"{len(y)} rows, {len(feats)} features: {', '.join(feats)}")

    ratio = float(config.get("train_split", 0.8))
    if not 0.1 <= ratio <= 0.95:
        raise DatasetInvalid(f"train_split must be between 0.1 and 0.95, got {ratio}.")
    Xtr, Xte, ytr, yte = _split(X, y, ratio)
    _log(run_id, f"split {len(ytr)} train / {len(yte)} test (ratio {ratio})")

    parent = run.get("parent_model_run_id")
    if parent:
        # RETRAIN. A tree ensemble has no warm start across a changed feature
        # set, so this is an honest refit that RECORDS its lineage rather than
        # pretending to continue the parent's fit. parent_model_run_id is the
        # link; the parent's own weights are untouched and its status is
        # irrelevant to the child, which is always a candidate.
        _log(run_id, f"retrain: lineage recorded from parent {parent[:8]}, "
                     "refitting from scratch on the selected dataset")

    _log(run_id, f"fitting {model_type} ...")
    model = _fit_sklearn(model_type, Xtr, ytr, config)
    pred = model.predict(Xte)

    want = (config.get("output_type") or "regression").lower()
    report = _report(yte, pred, feats=feats, n_train=len(ytr), n_test=len(yte),
                     started=started, scope=scope)
    if want == "classification":
        yt = [_bucket(v) for v in yte]
        yp = [_bucket(v) for v in pred]
        labels = [name for _, name in BUCKETS]
        metrics = _classification_metrics(yt, yp, labels)
        _log(run_id, f"accuracy {metrics['accuracy']:.4f}  f1 {metrics['f1_score']:.4f}")
    else:
        metrics = _regression_metrics(yte, pred)
        _log(run_id, f"R2 {metrics['r2']:.4f}  RMSE {metrics['rmse']:.4f}  "
                     f"MSE {report['mse']:.4f}  MAE {metrics['mae']:.4f}")

    label = _next_version_label(model_type)
    art = MODEL_DIR / f"{run_id}.pkl"
    joblib.dump(
        {"model": model, "feature_names": feats, "model_type": model_type,
         "version_label": label, "dataset_version_id": ds["id"],
         "run_config": config, "metrics": metrics},
        art,
    )
    _log(run_id, f"saved {label} -> {art.name}")

    importances = getattr(model, "feature_importances_", None)
    cfg = dict(config)
    cfg["artifact"] = str(art.relative_to(MODEL_DIR.parents[2]))
    cfg["feature_names"] = feats
    if importances is not None:
        # Feature importance for screen 5 rides in run_config rather than
        # getting its own table: it is one short vector per run, it is written
        # once and never queried across runs, and a table would need its own
        # policies for no gain.
        cfg["feature_importance"] = {
            f: round(float(v), 6) for f, v in zip(feats, importances)
        }
    cfg["report"] = report
    return {**metrics, "version_label": label, "run_config": cfg}


# --------------------------------------------------------------- evaluation

def _run_evaluation(run: dict) -> dict:
    """ACTION A. Score saved model versions against a dataset. Writes nothing
    except this run's own row -- no selected model's status, metrics or
    artefact is touched, which is what makes running the production model safe.
    """
    import time
    started = time.time()
    run_id = run["id"]
    selected = list(run.get("models_selected") or [])
    if not selected:
        raise DatasetInvalid("No models were selected for this evaluation.")

    ds = (db().table("dataset_versions").select("*")
          .eq("id", run["dataset_version_id"]).single().execute().data)
    if not ds:
        raise DatasetInvalid("The run references a dataset_version that no longer exists.")

    path = Path(ds["storage_path"])
    if not path.is_absolute():
        path = DATA_DIR.parent / path
    if not path.exists():
        raise DatasetInvalid(f"Dataset file is missing from disk: {ds['storage_path']}")

    scope = _scope_of(run)
    if scope:
        _log(run_id, "scoped to "
             + ", ".join(f"{k}={v}" for k, v in scope.items()))
    X, y, feats = _load_matrix(path, scope)
    _log(run_id, f"evaluating {len(selected)} model(s) on {len(y)} rows from {path.name}")

    versions = (db().table("model_runs")
                .select("id,version_label,model_type,status,run_config")
                .in_("id", selected).eq("run_kind", "training").execute().data or [])
    found = {v["id"] for v in versions}
    for missing in set(selected) - found:
        _log(run_id, f"skipped {missing[:8]}: not a training row")

    per_model = {}
    want = (run.get("run_config") or {}).get("output_type", "regression").lower()
    scored = []
    preds = {}

    for v in versions:
        art = MODEL_DIR / f"{v['id']}.pkl"
        if not art.exists():
            _log(run_id, f"skipped {v['version_label'] or v['id'][:8]}: artefact missing "
                         "(trained before artefact storage, or the file was removed)")
            continue
        bundle = joblib.load(art)
        names = bundle.get("feature_names") or feats
        # ALIGN BY NAME, never by position. A model trained on a dataset that
        # carried soil columns has a wider matrix than one that did not, and
        # feeding it this file's columns in this file's order would score it on
        # the wrong variables and report the result as real.
        if [n for n in names if n not in feats]:
            _log(run_id, f"skipped {v['version_label']}: needs feature(s) "
                         f"{[n for n in names if n not in feats]} this dataset does not have")
            continue
        cols = [feats.index(n) for n in names]
        pred = bundle["model"].predict(X[:, cols])

        # A model with no crop feature cannot tell one crop from another, so on
        # crop-scoped rows it predicts something near the POOLED mean while the
        # scope has narrowed the target's spread. The result is a large negative
        # R2 that looks like a failed run and is really a mismatched model, so
        # say so against the model rather than leaving the number unexplained.
        if "crop_type" in scope and not any(n.startswith("crop_") for n in names):
            _log(run_id,
                 f"note: {v['version_label'] or v['id'][:8]} was trained without any "
                 f"crop feature ({len(names)} features: {', '.join(names)}), so it "
                 f"cannot distinguish {scope['crop_type']} from the other crops. "
                 "Expect a large negative R2 -- it is being judged against the "
                 "spread of one crop while predicting near the all-crop mean.")

        if want == "classification":
            m = _classification_metrics([_bucket(a) for a in y],
                                        [_bucket(p) for p in pred],
                                        [n for _, n in BUCKETS])
        else:
            m = _regression_metrics(y, pred)
        per_model[v["version_label"] or v["id"]] = {**m, "status": v["status"]}
        # Keep each model's predictions, so the residual block in the report can
        # be computed for whichever one scores best rather than for an arbitrary
        # member of the comparison.
        scored.append(m)
        preds[id(m)] = pred
        head = (f"R2 {m['r2']:.4f}" if want != "classification"
                else f"accuracy {m['accuracy']:.4f}")
        _log(run_id, f"{v['version_label']} [{v['status']}]  {head}")

    if not scored:
        raise DatasetInvalid(
            "None of the selected models could be scored on this dataset. See the "
            "run log for the reason against each."
        )

    # The run row carries the BEST score so screen 4 can sort on one column;
    # run_config.per_model holds every model's numbers for the side-by-side.
    if want == "classification":
        best = max(scored, key=lambda m: m["accuracy"])
    else:
        best = max(scored, key=lambda m: m["r2"])
    best_pred = preds[id(best)]
    cfg = dict(run.get("run_config") or {})
    cfg["per_model"] = per_model
    cfg["feature_names"] = feats
    # Evaluation scores the WHOLE dataset -- there is no train half -- so
    # n_train is 0 and n_test is every row. Stating that explicitly stops the
    # screen reading an evaluation as a training with a 0% split.
    cfg["report"] = {**_report(y, best_pred, feats=feats, n_train=0, scope=scope,
                               n_test=len(y), started=started),
                     # NOT "scope" -- that key holds the crop/district/season
                     # filter, and overwriting it with this sentence made a
                     # wheat-only evaluation report itself as "whole dataset".
                     "split_note": "every scoped row scored; an evaluation has "
                                   "no train half to hold back",
                     "models_scored": len(scored)}
    return {**best, "run_config": cfg}


# ------------------------------------------------------------------ driver

def _execute(run_id: str) -> None:
    try:
        run = (db().table("model_runs").select("*").eq("id", run_id)
               .single().execute().data)
        if not run:
            return
        if run["job_status"] != "queued":
            # Already picked up. Returning rather than raising keeps a
            # double-POST idempotent instead of running the job twice.
            return

        _patch(run_id, job_status="running", started_at=_now())
        _log(run_id, f"started {run['run_kind']} for {run['model_type']}")

        result = (_run_training(run) if run["run_kind"] == "training"
                  else _run_evaluation(run))

        _patch(run_id, job_status="completed", completed_at=_now(), **result)
        _log(run_id, "completed")

    except DatasetInvalid as e:
        # An expected, explainable failure: show the researcher the reason.
        _log(run_id, f"failed: {e}")
        try:
            _patch(run_id, job_status="failed", completed_at=_now(),
                   error_message=str(e)[:1000])
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:  # noqa: BLE001 - the thread must not die silently
        # An unexpected failure. The traceback goes to the log table so it is
        # diagnosable from the portal, and error_message carries a short form.
        _log(run_id, "failed: " + traceback.format_exc()[-1800:])
        try:
            _patch(run_id, job_status="failed", completed_at=_now(),
                   error_message=f"{type(e).__name__}: {e}"[:1000])
        except Exception:  # noqa: BLE001
            pass


def start(run_id: str) -> None:
    """Accept a queued run and execute it on a daemon thread."""
    threading.Thread(target=_execute, args=(run_id,), daemon=True).start()


def reap_stale() -> int:
    """Mark runs that were `running` when the service died as failed.

    Called at startup. Without this a job interrupted by a restart stays
    `running` forever and the portal shows a spinner that never resolves.
    """
    try:
        rows = (db().table("model_runs").select("id")
                .in_("job_status", ["running", "queued"]).execute().data or [])
        for r in rows:
            db().table("model_runs").update({
                "job_status": "failed",
                "completed_at": _now(),
                "error_message": "Interrupted: the ML service restarted while this "
                                 "job was in flight. Trigger it again.",
            }).eq("id", r["id"]).execute()
            _log(r["id"], "failed: service restarted while this job was in flight")
        return len(rows)
    except Exception:  # noqa: BLE001 - startup must not be blocked by this
        return 0
