"""Why the yield model does not work: a per-crop diagnosis of the dataset.

    python -m scripts.diagnose_yield_features
    python -m scripts.diagnose_yield_features --csv data/training_data_real.csv

READ ONLY. Touches no data, no model, no database. It opens
data/training_data_real.csv and app/model.pkl and prints.

SCOPE. The ORIGINAL 11 crops in the CSV, including barley. The current model
holds 10 -- barley was removed in a separate step after a wheat/barley window
collision -- but a diagnosis that silently adopted the model's crop list would
be unable to show the very problem that caused the removal.

RELATED. scripts/diagnose_signal.py answers the same question at the level of
the whole dataset (between-crop vs within-crop variance, area share, whether a
cropland mask would help). This one goes per crop, which is where the decision
about each crop has to be made.
"""
import argparse
import csv
import math
import statistics as st
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parents[1] / "data"
MODEL = Path(__file__).resolve().parents[1] / "app" / "model.pkl"
IDX = ("ndvi", "evi", "ndwi", "savi", "nbr")

# The seasons train_real.py holds out. Baseline and model must be scored on
# the SAME rows or the comparison in section 6 is meaningless.
TEST_SEASONS = {"2021-22", "2022-23"}


def rows(path):
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def fnum(r, k):
    try:
        v = float(r[k])
        return None if math.isnan(v) else v
    except (KeyError, TypeError, ValueError):
        return None


def safe_std(v):
    return float(np.std(v)) if len(v) > 1 else 0.0


def pearson(x, y):
    if len(x) < 3 or np.std(x) == 0 or np.std(y) == 0:
        return None
    return float(np.corrcoef(x, y)[0, 1])


def spearman(x, y):
    """Rank correlation, computed without scipy so the script has no new dep."""
    if len(x) < 3:
        return None
    rx, ry = _rank(x), _rank(y)
    return pearson(rx, ry)


def _rank(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    out = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0          # average rank for ties
        for k in range(i, j + 1):
            out[order[k]] = avg
        i = j + 1
    return out


def r2(y_true, y_pred):
    y_true = np.asarray(y_true, dtype=float)
    ss_res = float(np.sum((y_true - np.asarray(y_pred, dtype=float)) ** 2))
    ss_tot = float(np.sum((y_true - y_true.mean()) ** 2))
    return None if ss_tot == 0 else 1.0 - ss_res / ss_tot


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default=str(DATA / "training_data_real.csv"))
    args = ap.parse_args()

    path = Path(args.csv)
    if not path.exists():
        sys.exit(f"missing {path}")
    rs = rows(path)
    crops = sorted({r["crop_type"] for r in rs})
    by = {c: [r for r in rs if r["crop_type"] == c] for c in crops}

    print("=" * 100)
    print(f"YIELD FEATURE DIAGNOSIS  --  {path.name}")
    print(f"{len(rs)} rows, {len(crops)} crops, "
          f"{len({r['district'] for r in rs})} districts, "
          f"{len({r['season'] for r in rs})} seasons")
    print("=" * 100)

    # ---------------------------------------------------- 1 coverage
    print("\n1. DATASET COVERAGE")
    print(f"  {'crop':10s} {'rows':>5s} {'dist':>5s} {'seas':>5s} "
          f"{'mean':>8s} {'std':>8s} {'min':>8s} {'max':>8s}  rows/district  rows/season")
    for c in crops:
        g = by[c]
        y = [fnum(r, "actual_yield") for r in g]
        y = [v for v in y if v is not None]
        d = Counter(r["district"] for r in g)
        s = Counter(r["season"] for r in g)
        print(f"  {c:10s} {len(g):>5d} {len(d):>5d} {len(s):>5d} "
              f"{st.mean(y):>8.3f} {safe_std(y):>8.3f} {min(y):>8.3f} {max(y):>8.3f}"
              f"   {min(d.values())}-{max(d.values())} (med {int(st.median(list(d.values())))})"
              f"      {min(s.values())}-{max(s.values())}")

    # ---------------------------------------------------- 2 feature stats
    print("\n2. SATELLITE FEATURE STATISTICS (per crop)")
    for c in crops:
        g = by[c]
        print(f"  {c}")
        print(f"      {'feat':6s} {'mean':>8s} {'std':>8s} {'min':>8s} {'max':>8s} {'uniq':>6s}")
        for k in IDX:
            v = [fnum(r, k) for r in g]
            v = [x for x in v if x is not None]
            if not v:
                print(f"      {k:6s} {'N/A':>8s}")
                continue
            print(f"      {k:6s} {st.mean(v):>8.4f} {safe_std(v):>8.4f} "
                  f"{min(v):>8.4f} {max(v):>8.4f} {len(set(v)):>6d}")

    # ---------------------------------------------------- 3 within-crop variation
    # Every row indexed by its 5-index signature, so a crop can be checked
    # against the WHOLE dataset and not just against itself.
    all_sig = defaultdict(list)
    for r in rs:
        all_sig[tuple(r[k] for k in IDX)].append(r)

    print("\n3. WITHIN-CROP FEATURE VARIATION")
    print("   CV = std/|mean|, shown only where |mean| > 0.05 -- NDWI and NBR sit")
    print("   near zero, where a ratio explodes and says nothing.")
    print(f"  {'crop':10s} " + " ".join(f"{k+'_std':>10s}" for k in IDX)
          + f" {'ndvi_CV':>8s} {'dupSelf':>8s} {'dupAny':>7s} {'dup%':>6s}")
    within = {}
    for c in crops:
        g = by[c]
        stds, cvs = [], {}
        for k in IDX:
            v = [fnum(r, k) for r in g]
            v = [x for x in v if x is not None]
            s_ = safe_std(v)
            m_ = st.mean(v) if v else 0.0
            stds.append(s_)
            cvs[k] = (s_ / abs(m_)) if abs(m_) > 0.05 else None
        # Two counts, because they answer different questions. dupSelf asks
        # whether a crop repeats itself; dupAny asks whether its rows are
        # duplicated ANYWHERE, which is where the real collisions live -- two
        # crops sharing an observation window produce the same composite for
        # the same district-season, so a crop can be perfectly unique among
        # its own rows and still be indistinguishable from another crop.
        own = Counter(tuple(r[k] for k in IDX) for r in g)
        dup_in = sum(n for n in own.values() if n > 1)
        dup_x = sum(1 for r in g if len(all_sig[tuple(r[k] for k in IDX)]) > 1)
        within[c] = {"stds": dict(zip(IDX, stds)), "dup": dup_in,
                     "dup_cross": dup_x,
                     "dup_pct": dup_x / len(g) if g else 0.0}
        cv = cvs["ndvi"]
        print(f"  {c:10s} " + " ".join(f"{x:>10.4f}" for x in stds)
              + f" {(f'{cv:.3f}' if cv is not None else 'N/A'):>8s}"
              f" {dup_in:>8d} {dup_x:>7d} {dup_x/len(g):>5.0%}")

    # ---------------------------------------------------- 4 feature -> yield
    print("\n4. FEATURE -> YIELD CORRELATION (Pearson / Spearman, per crop)")
    print("   Correlation is not causation, and with 130-270 rows per crop a")
    print("   coefficient under about 0.17 is not distinguishable from zero.")
    print(f"  {'crop':10s} " + " ".join(f"{k:>15s}" for k in IDX))
    corr = {}
    for c in crops:
        g = by[c]
        cells, row_c = [], {}
        for k in IDX:
            xs, ys = [], []
            for r in g:
                a, b = fnum(r, k), fnum(r, "actual_yield")
                if a is not None and b is not None:
                    xs.append(a); ys.append(b)
            p, s_ = pearson(xs, ys), spearman(xs, ys)
            row_c[k] = (p, s_)
            cells.append(f"{p:+.2f}/{s_:+.2f}" if p is not None and s_ is not None else "N/A")
        corr[c] = row_c
        print(f"  {c:10s} " + " ".join(f"{x:>15s}" for x in cells))

    # ---------------------------------------------------- 5 + 6 baseline vs model
    print("\n5. CROP-MEAN BASELINE  (train-set mean predicted for every holdout row)")
    print(f"   holdout seasons: {sorted(TEST_SEASONS)} -- the same split train_real.py uses,")
    print("   so section 6 compares like with like.")
    model_r2, importances, trained = {}, None, []
    if MODEL.exists():
        try:
            import joblib
            b = joblib.load(MODEL)
            model_r2 = b.get("per_crop_r2") or {}
            trained = list(b.get("trained_crops") or [])
            importances = dict(zip(b.get("feature_names") or [],
                                   b["model"].feature_importances_))
        except Exception as e:                    # noqa: BLE001 - diagnostic only
            print(f"   (could not read {MODEL.name}: {e})")

    print(f"  {'crop':10s} {'train':>6s} {'hold':>5s} {'baseR2':>8s} {'baseRMSE':>9s} "
          f"{'baseMAE':>8s} {'modelR2':>8s} {'improve':>8s}")
    summary = {}
    for c in crops:
        g = by[c]
        tr = [fnum(r, "actual_yield") for r in g if r["season"] not in TEST_SEASONS]
        te = [fnum(r, "actual_yield") for r in g if r["season"] in TEST_SEASONS]
        tr = [v for v in tr if v is not None]
        te = [v for v in te if v is not None]
        if len(tr) < 2 or len(te) < 2:
            print(f"  {c:10s} {len(tr):>6d} {len(te):>5d}  insufficient split")
            summary[c] = {"base": None, "model": None, "imp": None,
                          "ntr": len(tr), "nte": len(te)}
            continue
        mu = st.mean(tr)
        pred = [mu] * len(te)
        b_r2 = r2(te, pred)
        rmse = math.sqrt(sum((a - mu) ** 2 for a in te) / len(te))
        mae = sum(abs(a - mu) for a in te) / len(te)
        m_r2 = model_r2.get(c)
        imp = (m_r2 - b_r2) if (m_r2 is not None and b_r2 is not None) else None
        summary[c] = {"base": b_r2, "model": m_r2, "imp": imp,
                      "ntr": len(tr), "nte": len(te)}
        print(f"  {c:10s} {len(tr):>6d} {len(te):>5d} "
              f"{(f'{b_r2:.4f}' if b_r2 is not None else 'N/A'):>8s} "
              f"{rmse:>9.3f} {mae:>8.3f} "
              f"{(f'{m_r2:.4f}' if m_r2 is not None else 'N/A'):>8s} "
              f"{(f'{imp:+.4f}' if imp is not None else 'N/A'):>8s}")

    print("\n6. FEATURE USEFULNESS  = model R2 - crop-mean baseline R2")
    print("   A crop-mean baseline scores 0.0 by construction on its own crop:")
    print("   R2 is measured against the HOLDOUT mean, and the baseline predicts")
    print("   the TRAIN mean, so any drift between the two makes it slightly")
    print("   negative. The number that matters is whether the model beats it.")
    for c in crops:
        s_ = summary[c]
        if s_["imp"] is None:
            tag = "N/A (crop not in the current model)" if c not in trained else "N/A"
            print(f"  {c:10s} {tag}")
        else:
            if s_["model"] is not None and s_["model"] < 0:
                verdict = ("model R2 is NEGATIVE -- worse than this crop's own "
                           "holdout mean, whatever it does against the baseline")
            elif s_["imp"] > 0.05:
                verdict = "model beats the baseline"
            else:
                verdict = "no meaningful gain over the baseline"
            print(f"  {c:10s} {s_['imp']:+.4f}   {verdict}")

    # ---------------------------------------------------- 7 collisions
    print("\n7. IDENTICAL FEATURE VECTORS")
    sig = defaultdict(list)
    for r in rs:
        sig[tuple(r[k] for k in IDX)].append(r)
    dups = {k: v for k, v in sig.items() if len(v) > 1}
    n_rows = sum(len(v) for v in dups.values())
    print(f"  distinct 5-index vectors : {len(sig)}  (from {len(rs)} rows)")
    print(f"  vectors seen more than once: {len(dups)}")
    print(f"  rows involved            : {n_rows} ({n_rows/len(rs):.1%})")

    diff_label, gaps, ds_combos = 0, [], set()
    pair_counts, pair_gaps = Counter(), defaultdict(list)
    for v in dups.values():
        ys = [fnum(r, "actual_yield") for r in v]
        if len(set(ys)) > 1:
            diff_label += len(v)
            gaps.append(max(ys) - min(ys))
        for r in v:
            ds_combos.add((r["district"], r["season"]))
        cs = sorted({r["crop_type"] for r in v})
        for i in range(len(cs)):
            for j in range(i + 1, len(cs)):
                pair_counts[(cs[i], cs[j])] += 1
                a = [fnum(r, "actual_yield") for r in v if r["crop_type"] == cs[i]]
                bb = [fnum(r, "actual_yield") for r in v if r["crop_type"] == cs[j]]
                if a and bb:
                    pair_gaps[(cs[i], cs[j])].append(abs(a[0] - bb[0]))
    print(f"  rows whose duplicate has a DIFFERENT yield: {diff_label}")
    print(f"  district-season combinations involved     : {len(ds_combos)}")
    if gaps:
        print(f"  yield gap among conflicting labels: mean {st.mean(gaps):.3f}  "
              f"max {max(gaps):.3f} t/ha")
    print("\n  crop pairs sharing identical vectors:")
    for (a, bb), n in pair_counts.most_common():
        g = pair_gaps[(a, bb)]
        print(f"    {a:10s} + {bb:10s} {n:>4d} district-seasons   "
              f"mean |yield diff| {st.mean(g):.3f}  max {max(g):.3f} t/ha")

    # ---------------------------------------------------- 8 windows
    print("\n8. OBSERVATION WINDOW ANALYSIS")
    try:
        from app.crops import CROP_ROWS, season_window
        print(f"  {'crop':10s} {'window (2020-21)':28s} {'days':>5s} "
              f"{'duration':>9s} {'sow':>7s} {'status':16s}")
        wins = defaultdict(list)
        for c in crops:
            if c not in CROP_ROWS:
                continue
            a, bq = season_window(c, "2020-21")
            from datetime import date as _d
            span = (_d.fromisoformat(bq) - _d.fromisoformat(a)).days
            row = CROP_ROWS[c]
            wins[(row["obs_start"], row["obs_end"])].append(c)
            print(f"  {c:10s} {a+' .. '+bq:28s} {span:>5d} "
                  f"{row['duration_days']:>9s} {row['sow_typical']:>7s} "
                  f"{row['status']:16s}")
        print("\n  windows are CROP-SPECIFIC, not one fixed range -- but they are")
        print("  fixed CALENDAR ranges per crop, identical in every season and")
        print("  every district. Crops sharing a window:")
        for w, cs in sorted(wins.items()):
            if len(cs) > 1:
                print(f"    {w[0]}..{w[1]}  ->  {', '.join(cs)}   <-- COLLIDES")
        print("\n  The five features are SEASONAL SUMMARIES, not single dates: the")
        print("  builder reduces a MEDIAN COMPOSITE over the whole window")
        print("  (app/gee.py: col.median()), so each row is one number per index")
        print("  for an entire season. Early/mid/late growth are averaged together")
        print("  and cannot be told apart.")
    except Exception as e:                        # noqa: BLE001 - diagnostic only
        print(f"  (crop registry unavailable: {e})")

    # ---------------------------------------------------- 9 importance
    print("\n9. FEATURE IMPORTANCE (from the existing model artifact, not retrained)")
    if not importances:
        print("  N/A -- model artifact unreadable")
    else:
        sat = {k: v for k, v in importances.items() if k in IDX}
        crop_f = {k: v for k, v in importances.items() if k.startswith("crop_")}
        for k, v in sorted(importances.items(), key=lambda kv: -kv[1]):
            print(f"    {k:18s} {v:.4f}")
        print(f"\n    satellite features total : {sum(sat.values()):.4f}")
        print(f"    crop one-hot total       : {sum(crop_f.values()):.4f}")
        top = max(crop_f.items(), key=lambda kv: kv[1]) if crop_f else (None, 0)
        print(f"    single largest crop column: {top[0]} {top[1]:.4f}")

    # ---------------------------------------------------- 10 summary
    print("\n10. SUMMARY")
    print(f"  {'Crop':10s} {'Rows':>5s} {'Dist':>5s} {'Seas':>5s} {'YieldStd':>9s} "
          f"{'NDVIStd':>8s} {'BaseR2':>8s} {'ModelR2':>8s} {'Improve':>8s} {'Conflict':>9s}")
    for c in crops:
        g, s_ = by[c], summary[c]
        y = [v for v in (fnum(r, "actual_yield") for r in g) if v is not None]
        base = f"{s_['base']:.3f}" if s_["base"] is not None else "N/A"
        mdl = f"{s_['model']:.3f}" if s_["model"] is not None else "N/A"
        imp = f"{s_['imp']:+.3f}" if s_["imp"] is not None else "N/A"
        print(f"  {c:10s} {len(g):>5d} {len({r['district'] for r in g}):>5d} "
              f"{len({r['season'] for r in g}):>5d} {safe_std(y):>9.3f} "
              f"{within[c]['stds']['ndvi']:>8.4f} "
              f"{base:>8s} {mdl:>8s} {imp:>8s} {within[c]['dup_cross']:>9d}")

    print("\n11. DIAGNOSIS -- observations, then hypotheses")
    print("""
  OBSERVED (measured above, not inferred)
    o1  Each row is a MEDIAN COMPOSITE over a whole fixed calendar window, so
        there is one observation per district-season-crop and no within-season
        shape at all.
    o2  The window is crop-specific but identical across every season and
        district, and two crop pairs share a window exactly.
    o3  A large share of rows carry a 5-index vector that some other row also
        carries, and those twins mostly disagree on yield.
    o4  Per-crop NDVI standard deviation is small relative to the spread of
        yields the model is asked to explain.
    o5  Per-crop feature-yield correlations are mostly inside the band that a
        sample this size cannot distinguish from zero.
    o6  In the fitted model the crop one-hot carries the overwhelming majority
        of importance; the five satellite features share the remainder.
    o7  Several crops show model R2 at or below their own crop-mean baseline.

  HYPOTHESES (consistent with the above, NOT established by it)
    h1  A season-long median composite may destroy the signal it is meant to
        carry: greenup rate, peak height and senescence timing all collapse to
        one number.
    h2  Where two crops share a window, their district-season rows may be
        physically the same measurement, making them separable only by the
        one-hot.
    h3  The model may be behaving largely as a crop-name lookup table, with the
        indices acting as weak district identifiers rather than as agronomy.
    h4  District-average PBS labels may not be predictable from any
        district-average optical summary, independently of how the features are
        built -- a label-granularity limit rather than a feature limit.

  These are not ranked, and no crop is called better or worse than another.
""")
    print("NOTHING WAS MODIFIED. This script reads two files and prints.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
