"""Leave-one-season-out validation of the existing temporal-feature experiment.

    cd ml-service
    PYTHONPATH=. .venv/Scripts/python.exe ../experimental/temporal_features/run_loso.py

EXPERIMENTAL AND NON-DESTRUCTIVE. It reads the experimental dataset and writes
only into experimental/temporal_features/results/loso_8season/. It never
touches app/model.pkl, data/training_data_real.csv, data/crops.csv, the
database, or any production module.

WHY THIS EXISTS. The temporal experiment was validated on ONE fixed holdout
(2021-22 + 2022-23). A single split cannot say whether a per-crop gain is real
or an artifact of which two seasons happened to be held out -- and several
crops carried only 28-68 holdout rows. This runs all 8 Sentinel-2 seasons as
separate held-out folds, so every crop gets 8 independent estimates instead
of 1.

REUSES the existing implementation rather than reimplementing it: matrix(),
impute(), feature_columns(), COVERAGE and RF_KWARGS all come from
scripts.train_temporal_experiment and scripts.build_temporal_features. The
only new logic here is the fold loop and the per-crop bookkeeping.

LEAKAGE. The existing impute() already fits on the training half only, which
is the one preprocessing step in the pipeline; nothing is scaled, nothing is
selected, and no hyperparameter is tuned, so there is nothing else to fit.
The features themselves are computed per row from that row's own
(crop, season, district) observations by build_temporal_features, which this
script re-verifies from the raw observations rather than taking on trust.
"""
import csv
import json
import statistics as st
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from app.crops import season_window
from scripts.build_temporal_features import (MIN_VALID_PX, feature_columns,
                                             temporal_features)
from scripts.train_temporal_experiment import (COVERAGE, PROD, RF_KWARGS, impute,
                                               matrix)

HERE = Path(__file__).resolve().parent
OUT = HERE / "results" / "loso_8season"
EXP_CSV = HERE / "training_data_temporal_experiment.csv"
RAW_CSV = HERE / "temporal_observations_raw.csv"

# Every season Sentinel-2 L2A can cover. 2015-16 and 2016-17 exist in the new
# PBS workbook but not here, and could not be added: the collection begins
# 2017-03-28, so a rabi window before that has no imagery at all.
SEASONS = ["2017-18", "2018-19", "2019-20", "2020-21",
           "2021-22", "2022-23", "2023-24", "2024-25"]

CROPS = ["bajra", "barley", "cotton", "jowar", "maize", "onion",
         "potato", "rice", "sugarcane", "tomato", "wheat"]

# A fold is scored only when the held-out season has enough rows for R2 to
# mean anything AND the true yields actually vary. R2 on 2 points is a line
# through 2 points; R2 on a constant target is undefined.
MIN_FOLD_N = 5


def log(*a):
    print(*a)
    sys.stdout.flush()


def load_rows():
    with EXP_CSV.open(newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        r["actual_yield"] = float(r["actual_yield"])
    return rows


# ------------------------------------------------------------------ audit
def season_window_audit():
    """Every raw observation must sit inside its own (crop, season) window."""
    with RAW_CSV.open(newline="", encoding="utf-8-sig") as fh:
        raw = list(csv.DictReader(fh))
    outside, crops_hit, keys_hit = 0, set(), set()
    for r in raw:
        w0, w1 = season_window(r["crop"], r["season"])
        if not (w0 <= r["date"] <= w1):
            outside += 1
            crops_hit.add(r["crop"])
            keys_hit.add((r["crop"], r["season"], r["district"]))

    # Two seasons of one crop sharing a calendar date would let one
    # observation serve a training row and a held-out row at once.
    spans = defaultdict(lambda: [None, None])
    for r in raw:
        s = spans[(r["crop"], r["season"])]
        s[0] = r["date"] if s[0] is None else min(s[0], r["date"])
        s[1] = r["date"] if s[1] is None else max(s[1], r["date"])
    cross = []
    for crop in sorted({r["crop"] for r in raw}):
        ss = sorted(s for (c, s) in spans if c == crop)
        for a, b in zip(ss, ss[1:]):
            if spans[(crop, a)][1] >= spans[(crop, b)][0]:
                cross.append([crop, a, b])
    return raw, {
        "raw_observations": len(raw),
        "observations_outside_own_season_window": outside,
        "affected_rows": len(keys_hit),
        "affected_crops": sorted(crops_hit),
        "seasons_sharing_a_calendar_date": cross,
    }


def recompute_audit(rows, raw, n=60):
    """Rebuild features from each row's OWN observations and diff them.

    This is the concrete form of "no global statistic before the split". If
    any engineered value had been pooled across seasons, the stored column and
    the per-season recomputation would disagree.
    """
    by_key = defaultdict(list)
    for r in raw:
        if int(r["valid_px"] or 0) < MIN_VALID_PX:
            continue
        by_key[(r["crop"], r["season"], r["district"])].append({
            "date": date.fromisoformat(r["date"]),
            "cloud_pct": float(r["cloud_pct"]) if r["cloud_pct"] else None,
            "valid_px": int(r["valid_px"] or 0),
            **{k: (float(r[k]) if r[k] else None)
               for k in ("ndvi", "evi", "ndwi", "savi", "nbr")},
        })
    for v in by_key.values():
        v.sort(key=lambda x: x["date"])

    step = max(len(rows) // n, 1)
    checked = diffs = 0
    for r in rows[::step][:n]:
        s, e = season_window(r["crop"], r["season"])
        got = temporal_features(by_key.get((r["crop"], r["season"], r["district"]), []),
                                date.fromisoformat(s), date.fromisoformat(e))
        checked += 1
        for k, v in got.items():
            if ("" if v is None else str(v)) != r.get(k, ""):
                diffs += 1
    return {"rows_recomputed_from_own_season_only": checked,
            "differing_values": diffs}


# ------------------------------------------------------------------ folds
def fit_fold(train, test, cols, crops_tr):
    """One (arm, fold) fit. Imputation medians come from `train` alone."""
    Xtr, names = matrix(train, cols, crops_tr)
    Xte, _ = matrix(test, cols, crops_tr)
    Xtr, Xte = impute(Xtr, Xte)
    ytr = np.array([r["actual_yield"] for r in train])
    m = RandomForestRegressor(**RF_KWARGS).fit(Xtr, ytr)
    return m.predict(Xte), len(names)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows = load_rows()
    raw, win_audit = season_window_audit()

    log("=== dataset ===")
    log("experimental rows: %d" % len(rows))
    seasons_present = sorted({r["season"] for r in rows})
    log("seasons present  : %s" % seasons_present)
    assert seasons_present == SEASONS, seasons_present

    log("\n=== season-window audit ===")
    for k, v in win_audit.items():
        log("  %-42s %s" % (k, v if not isinstance(v, list) or v else v))
    rec = recompute_audit(rows, raw)
    log("  %-42s %s" % ("rows recomputed from own season only",
                        rec["rows_recomputed_from_own_season_only"]))
    log("  %-42s %s" % ("differing values", rec["differing_values"]))

    leak_fail = (win_audit["observations_outside_own_season_window"] > 0
                 or win_audit["seasons_sharing_a_calendar_date"]
                 or rec["differing_values"] > 0)
    if leak_fail:
        log("\nLEAKAGE FOUND -- stopping before any training, as instructed.")
        (OUT / "validation_audit.json").write_text(
            json.dumps({"result": "FAIL", "season_window": win_audit,
                        "recompute": rec}, indent=2), encoding="utf-8")
        return 1
    log("  result: PASS")

    cols = feature_columns()
    veg = [c for c in cols if c not in COVERAGE]
    ARMS = {"current": PROD, "temporal": cols, "veg_only": veg}

    # duplicate + missing-data bookkeeping for the audit file
    keyc = Counter((r["district"], r["crop"], r["season"]) for r in rows)
    feat_all = sorted({c for c in cols})
    missing = {c: sum(1 for r in rows if r.get(c, "") == "") for c in feat_all}

    fold_results, audit_folds, insufficient = [], [], []

    for held in SEASONS:
        train = [r for r in rows if r["season"] != held]
        test = [r for r in rows if r["season"] == held]
        crops_tr = sorted({r["crop"] for r in train})
        contamination = sum(1 for r in train if r["season"] == held)
        log("\n=== fold: held out %s  (train %d / test %d) ==="
            % (held, len(train), len(test)))
        assert contamination == 0

        fold_rec = {"held_out_season": held, "train_rows": len(train),
                    "test_rows": len(test),
                    "train_seasons": sorted({r["season"] for r in train}),
                    "held_out_rows_found_in_training": contamination,
                    "crops_in_training": crops_tr, "features": {}}

        for arm, use in ARMS.items():
            pred, nfeat = fit_fold(train, test, use, crops_tr)
            fold_rec["features"][arm] = nfeat
            y = np.array([r["actual_yield"] for r in test])
            line = []
            for crop in CROPS:
                ii = [i for i, r in enumerate(test) if r["crop"] == crop]
                if len(ii) < MIN_FOLD_N or len(set(y[ii])) < 2:
                    if arm == "current":
                        insufficient.append(
                            {"held_out_season": held, "crop": crop, "n": len(ii),
                             "reason": ("fewer than %d rows" % MIN_FOLD_N
                                        if len(ii) < MIN_FOLD_N
                                        else "zero variance in the target")})
                    continue
                yc, pc = y[ii], pred[ii]
                fold_results.append({
                    "model": arm, "held_out_season": held, "crop": crop,
                    "n": len(ii), "r2": round(r2_score(yc, pc), 6),
                    "mae": round(mean_absolute_error(yc, pc), 6),
                    "rmse": round(float(np.sqrt(mean_squared_error(yc, pc))), 6),
                })
                line.append("%s %.3f" % (crop[:4], fold_results[-1]["r2"]))
            log("  %-9s %3d features | %s" % (arm, nfeat, "  ".join(line)))
        audit_folds.append(fold_rec)

    # ---- write results -------------------------------------------------
    with (OUT / "fold_results.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["model", "held_out_season", "crop",
                                           "n", "r2", "mae", "rmse"])
        w.writeheader()
        w.writerows(fold_results)

    def agg(group_key, count_name, with_std):
        out = []
        bag = defaultdict(list)
        for r in fold_results:
            bag[(r["model"], r[group_key])].append(r)
        for (model, g), rs in sorted(bag.items()):
            r2s = [r["r2"] for r in rs]
            row = {"model": model, group_key: g, count_name: len(rs),
                   "mean_r2": round(st.mean(r2s), 6),
                   "median_r2": round(st.median(r2s), 6)}
            if with_std:
                row["std_r2"] = round(st.stdev(r2s), 6) if len(r2s) > 1 else ""
            row["mean_mae"] = round(st.mean([r["mae"] for r in rs]), 6)
            row["mean_rmse"] = round(st.mean([r["rmse"] for r in rs]), 6)
            out.append(row)
        return out

    crop_sum = agg("crop", "valid_folds", True)
    with (OUT / "crop_summary.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["model", "crop", "valid_folds", "mean_r2",
                                           "median_r2", "std_r2", "mean_mae",
                                           "mean_rmse"])
        w.writeheader()
        w.writerows(crop_sum)

    season_sum = agg("held_out_season", "valid_crops", False)
    with (OUT / "season_summary.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["model", "held_out_season", "valid_crops",
                                           "mean_r2", "median_r2", "mean_mae",
                                           "mean_rmse"])
        w.writeheader()
        w.writerows(season_sum)

    audit = {
        "result": "PASS",
        "generated": date.today().isoformat(),
        "scripts_executed": [
            "experimental/temporal_features/run_loso.py  (this file)",
            "imports ml-service/scripts/build_temporal_features.py "
            "(feature_columns, temporal_features, MIN_VALID_PX)",
            "imports ml-service/scripts/train_temporal_experiment.py "
            "(matrix, impute, COVERAGE, PROD, RF_KWARGS)",
            "imports ml-service/app/crops.py (season_window) -- read only",
        ],
        "inputs": {
            "features_csv": str(EXP_CSV.name),
            "raw_observations_csv": str(RAW_CSV.name),
            "rows": len(rows),
            "raw_observations": len(raw),
        },
        "seasons_used": SEASONS,
        "seasons_excluded": {
            "2015-16": "no Sentinel-2 L2A (collection begins 2017-03-28)",
            "2016-17": "no Sentinel-2 L2A for the rabi window",
        },
        "crops_used": CROPS,
        "validation": "leave-one-season-out, 8 folds",
        "min_rows_for_a_scored_fold": MIN_FOLD_N,
        "feature_groups": {
            "current": {
                "columns": PROD,
                "note": "the production feature GROUP (season-median composite "
                        "indices) refit on these rows; not the shipped "
                        "model.pkl, which has a fixed split and cannot be "
                        "cross-validated",
            },
            "temporal": {"n_columns": len(cols)},
            "veg_only": {"n_columns": len(veg),
                         "excluded": list(COVERAGE)},
        },
        "features_per_arm_after_isna_flags_and_one_hot":
            audit_folds[0]["features"],
        "preprocessing": {
            "scaling": "none -- a random forest is scale invariant",
            "feature_selection": "none",
            "hyperparameter_tuning": "none; RF_KWARGS is fixed at "
                                     + json.dumps(RF_KWARGS),
            "one_hot": "built from the TRAINING seasons' crops only",
        },
        "imputation": {
            "method": "column median, plus a companion _isna flag per column",
            "fitted_on": "training rows of each fold only (impute(Xtr, Xte))",
            "source": "scripts.train_temporal_experiment.impute",
        },
        "season_window_checks": win_audit,
        "recompute_check": rec,
        "duplicate_checks": {
            "unique_district_crop_season_keys": len(keyc),
            "rows": len(rows),
            "duplicate_rows": sum(n - 1 for n in keyc.values() if n > 1),
        },
        "missing_data": {
            "engineered_columns": len(feat_all),
            "fully_populated_columns": sum(1 for c in feat_all if missing[c] == 0),
            "worst_columns": sorted(
                ({"column": c, "missing": missing[c],
                  "pct": round(100 * missing[c] / len(rows), 2)}
                 for c in feat_all if missing[c]),
                key=lambda d: -d["missing"])[:10],
        },
        "insufficient_data_folds": insufficient,
        "folds": audit_folds,
    }
    (OUT / "validation_audit.json").write_text(
        json.dumps(audit, indent=2), encoding="utf-8")

    log("\nwrote %d fold rows -> %s" % (len(fold_results), OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
