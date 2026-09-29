"""Step 11b: turn the per-date observations into one temporal feature row per
district-crop-season.

    python -m scripts.build_temporal_features
    python -m scripts.build_temporal_features --report-only

EXPERIMENTAL. Reads data/temporal_observations_raw.csv and, READ-ONLY,
data/training_data_real.csv for the yield labels. Writes
data/training_data_temporal_experiment.csv. Nothing the production pipeline
uses is written.

ROW COUNT IS PRESERVED. One row per district x crop x season, exactly as
before -- the yield label is never duplicated across segments. What changes is
the width of the row, not the number of rows.

ANTI-LEAKAGE. Every feature for a row is computed from observations carrying
that row's own (crop, season, district) key and falling inside that crop's
own observation window. The yield column is read only to be copied through;
it is never an input to any feature. No harvest date is used, because none is
known for these district-level rows.

MISSING IS MISSING. A segment with no usable observation gets an empty cell
and its *_n count records why. Filling it with the season mean would let the
forest read a fabricated value as an observation, and would quietly hide
exactly the coverage problem this experiment is meant to measure.
"""
import argparse
import csv
from collections import defaultdict
from datetime import date
from pathlib import Path

from app.crops import INDEX_FEATURES, season_window

DATA = Path(__file__).resolve().parents[1] / "data"
# Every artifact this experiment produces lives OUTSIDE the ml-service tree,
# in experimental/temporal_features/. The experimental model sat in app/ for
# one run and that is one run too many: app/model.pkl is loaded by path, so a
# rename or a tab-completion slip is all that stands between a research
# artifact and the production predictor. Separate directories remove the
# possibility rather than relying on the filename.
EXPERIMENT = Path(__file__).resolve().parents[2] / "experimental" / "temporal_features"
RAW_CSV = EXPERIMENT / "temporal_observations_raw.csv"
LABELS_CSV = DATA / "training_data_real.csv"          # read-only
OUT_CSV = EXPERIMENT / "training_data_temporal_experiment.csv"

# Three segments, not five. The segmentation has to be affordable in
# observations, and section 5's counts are what decide that: a rabi window is
# 105 days and Punjab's winter fog leaves single figures of usable dates in
# it, so cutting that into five parts produces segments that are empty more
# often than not. Five-way is computed alongside as *_q1.._q5 level means
# only, so the finer split can be measured rather than assumed.
SEGMENTS = ("early", "mid", "late")
N_FINE = 5

# A slope needs at least this many observations in the span. Two points give a
# slope through any pair of noisy values; it is a number, not a trend.
MIN_SLOPE_OBS = 3

# Below this the district mean is a handful of pixels and mostly edge effect.
MIN_VALID_PX = 20


def _f(v):
    return None if v in (None, "") else float(v)


def load_raw():
    """{(crop, season, district): [row, ...]} ordered by date."""
    if not RAW_CSV.exists():
        raise SystemExit("missing %s -- run scripts.fetch_temporal_observations first"
                         % RAW_CSV)
    by_key = defaultdict(list)
    with RAW_CSV.open(newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            if int(r["valid_px"] or 0) < MIN_VALID_PX:
                continue
            by_key[(r["crop"], r["season"], r["district"])].append({
                "date": date.fromisoformat(r["date"]),
                "cloud_pct": _f(r.get("cloud_pct")),
                "valid_px": int(r["valid_px"] or 0),
                **{k: _f(r.get(k)) for k in INDEX_FEATURES},
            })
    for v in by_key.values():
        v.sort(key=lambda x: x["date"])
    return by_key


def load_labels():
    """[{district, season, crop, yield, plus the five median-composite features}].

    The production features are carried through unchanged so the comparison in
    section 13 can be run on identical rows.
    """
    with LABELS_CSV.open(newline="", encoding="utf-8-sig") as fh:
        return [{
            "district": r["district"], "season": r["season"], "crop": r["crop_type"],
            "actual_yield": float(r["actual_yield"]),
            "median": {k: _f(r.get(k)) for k in INDEX_FEATURES},
        } for r in csv.DictReader(fh)]


def segment_of(day, start, end, n):
    """Which of n equal-length calendar parts of [start, end] `day` falls in.

    EQUAL CALENDAR PARTS, not equal observation counts. Splitting by count
    would make "early" mean a different number of days in a cloudy season than
    a clear one, so the same feature name would describe different points of
    the crop's life -- which is exactly the confusion the experiment is trying
    to remove.
    """
    span = (end - start).days
    if span <= 0:
        return 0
    i = int((day - start).days * n / span)
    return min(max(i, 0), n - 1)


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    m = len(xs) // 2
    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2


def _slope(points):
    """Least-squares slope in units per DAY, or None if too few points.

    Per day rather than per observation, because the observations are not
    evenly spaced -- a cloudy gap would otherwise compress into one step and
    read as a sudden change.
    """
    pts = [(x, y) for x, y in points if y is not None]
    if len(pts) < MIN_SLOPE_OBS:
        return None
    n = len(pts)
    mx = sum(x for x, _ in pts) / n
    my = sum(y for _, y in pts) / n
    den = sum((x - mx) ** 2 for x, _ in pts)
    if den == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in pts) / den


def temporal_features(obs, start, end):
    """The feature dict for one district-crop-season's observations."""
    out = {}
    span = max((end - start).days, 1)

    # ---- coverage, section 5 -------------------------------------------
    out["valid_observation_count"] = len(obs)
    seg_obs = {s: [] for s in SEGMENTS}
    for o in obs:
        seg_obs[SEGMENTS[segment_of(o["date"], start, end, len(SEGMENTS))]].append(o)
    for s in SEGMENTS:
        out["%s_observation_count" % s] = len(seg_obs[s])
    out["segments_covered"] = sum(1 for s in SEGMENTS if seg_obs[s])
    out["cloud_pct_mean"] = _round(_mean([o["cloud_pct"] for o in obs]))
    out["valid_px_mean"] = _round(_mean([float(o["valid_px"]) for o in obs]), 1)
    if obs:
        out["first_obs_doy_frac"] = _round((obs[0]["date"] - start).days / span)
        out["last_obs_doy_frac"] = _round((obs[-1]["date"] - start).days / span)
        gaps = [(b["date"] - a["date"]).days for a, b in zip(obs, obs[1:])]
        out["max_gap_days"] = max(gaps) if gaps else span
    else:
        out["first_obs_doy_frac"] = out["last_obs_doy_frac"] = None
        out["max_gap_days"] = span

    fine = {i: [] for i in range(N_FINE)}
    for o in obs:
        fine[segment_of(o["date"], start, end, N_FINE)].append(o)

    for k in INDEX_FEATURES:
        vals = [o[k] for o in obs if o[k] is not None]
        pts = [((o["date"] - start).days, o[k]) for o in obs if o[k] is not None]

        # ---- the baseline representation, recomputed HERE ---------------
        # Median over the same observations the temporal features are built
        # from. This is what makes section 13 a comparison of representations
        # rather than of reduction scales: the production model's own column
        # is a 100 m server-side composite, this is a 500 m median of daily
        # district means, and only one of those two is like-for-like with the
        # temporal features.
        out["%s_season_median" % k] = _round(_median(vals))

        # ---- level, section 4 -------------------------------------------
        for s in SEGMENTS:
            out["%s_%s_mean" % (k, s)] = _round(_mean([o[k] for o in seg_obs[s]]))
        for i in range(N_FINE):
            out["%s_q%d_mean" % (k, i + 1)] = _round(_mean([o[k] for o in fine[i]]))
        out["%s_peak" % k] = _round(max(vals)) if vals else None
        out["%s_min" % k] = _round(min(vals)) if vals else None

        # ---- shape ------------------------------------------------------
        out["%s_amplitude" % k] = (_round(max(vals) - min(vals)) if vals else None)
        e, m, l = (out["%s_%s_mean" % (k, s)] for s in SEGMENTS)
        out["%s_early_to_mid" % k] = _round(m - e) if None not in (e, m) else None
        out["%s_mid_to_late" % k] = _round(l - m) if None not in (m, l) else None
        out["%s_overall_change" % k] = _round(l - e) if None not in (e, l) else None

        # ---- growth: slope up to the peak, slope after it ---------------
        # Split at the peak OBSERVATION rather than at a calendar midpoint,
        # so a season that peaked early is not scored as though it declined
        # for half its length.
        if pts:
            pk = max(pts, key=lambda p: p[1])
            out["%s_peak_frac" % k] = _round(pk[0] / span)
            out["%s_growth_slope" % k] = _round(
                _slope([p for p in pts if p[0] <= pk[0]]), 6)
            out["%s_decline_slope" % k] = _round(
                _slope([p for p in pts if p[0] >= pk[0]]), 6)
        else:
            out["%s_peak_frac" % k] = None
            out["%s_growth_slope" % k] = out["%s_decline_slope" % k] = None

    return out


def _round(v, places=4):
    return None if v is None else round(v, places)


def feature_columns():
    """Every engineered column, in a fixed order."""
    cols = ["valid_observation_count"]
    cols += ["%s_observation_count" % s for s in SEGMENTS]
    cols += ["segments_covered", "cloud_pct_mean", "valid_px_mean",
             "first_obs_doy_frac", "last_obs_doy_frac", "max_gap_days"]
    for k in INDEX_FEATURES:
        cols.append("%s_season_median" % k)
        cols += ["%s_%s_mean" % (k, s) for s in SEGMENTS]
        cols += ["%s_q%d_mean" % (k, i + 1) for i in range(N_FINE)]
        cols += ["%s_peak" % k, "%s_min" % k, "%s_amplitude" % k,
                 "%s_early_to_mid" % k, "%s_mid_to_late" % k,
                 "%s_overall_change" % k, "%s_peak_frac" % k,
                 "%s_growth_slope" % k, "%s_decline_slope" % k]
    return cols


META = ["district", "crop", "season", "actual_yield", "obs_start", "obs_end"]
# The production features, carried through under their own names so one file
# can serve both arms of the comparison.
PROD = ["prod_%s" % k for k in INDEX_FEATURES]


def build():
    raw = load_raw()
    labels = load_labels()
    cols = feature_columns()
    rows, missing = [], 0

    for lab in labels:
        key = (lab["crop"], lab["season"], lab["district"])
        obs = raw.get(key, [])
        if not obs:
            missing += 1
        s, e = season_window(lab["crop"], lab["season"])
        start, end = date.fromisoformat(s), date.fromisoformat(e)
        row = {
            "district": lab["district"], "crop": lab["crop"], "season": lab["season"],
            "actual_yield": lab["actual_yield"], "obs_start": s, "obs_end": e,
        }
        for k in INDEX_FEATURES:
            row["prod_%s" % k] = lab["median"][k]
        row.update(temporal_features(obs, start, end))
        rows.append(row)

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=META + PROD + cols)
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in META + PROD + cols})

    print("wrote %d row(s) x %d column(s) -> %s"
          % (len(rows), len(META + PROD + cols), OUT_CSV))
    print("label rows with no temporal observation at all: %d" % missing)
    return rows, cols


# ------------------------------------------------------------------ reports
def report_missing(rows, cols):
    print("\n=== missing-data statistics ===")
    feat = [c for c in cols if not c.endswith("_count") and c != "segments_covered"]
    n = len(rows)
    print("  rows: %d   engineered columns: %d" % (n, len(cols)))
    blank = {c: sum(1 for r in rows if r.get(c) is None) for c in feat}
    worst = sorted(blank.items(), key=lambda kv: -kv[1])
    print("  columns fully populated: %d of %d"
          % (sum(1 for c in feat if blank[c] == 0), len(feat)))
    print("  most-missing columns:")
    for c, m in worst[:8]:
        print("    %-28s %5d (%4.1f%%)" % (c, m, 100 * m / n))

    print("  per crop: rows, mean obs/season, %% of rows missing each segment")
    print("    %-10s %5s %8s %7s %7s %7s" % ("crop", "rows", "obs/seas", "early", "mid", "late"))
    for c in sorted(set(r["crop"] for r in rows)):
        g = [r for r in rows if r["crop"] == c]
        line = [100 * sum(1 for r in g if r["%s_observation_count" % s] == 0) / len(g)
                for s in SEGMENTS]
        print("    %-10s %5d %8.1f %6.1f%% %6.1f%% %6.1f%%"
              % (c, len(g), _mean([float(r["valid_observation_count"]) for r in g]),
                 *line))


def report_collision(rows, cols):
    """Section 7: do temporal features separate the wheat/barley pairs?"""
    print("\n=== wheat / barley collision ===")
    prod_sig, temp_sig = defaultdict(list), defaultdict(list)
    feat = [c for c in cols if c.endswith(("_mean", "_peak", "_min", "_amplitude",
                                           "_change", "_frac", "_slope", "_median",
                                           "_to_mid", "_to_late"))]
    wb = [r for r in rows if r["crop"] in ("wheat", "barley")]
    for r in wb:
        prod_sig[tuple(r["prod_%s" % k] for k in INDEX_FEATURES)].append(r)
        temp_sig[tuple(r.get(c) for c in feat)].append(r)

    def cross(sig):
        pairs = 0
        for g in sig.values():
            crops = set(r["crop"] for r in g)
            if len(crops) > 1:
                pairs += sum(1 for r in g if r["crop"] == "barley")
        return pairs

    # A row with no usable observation has an all-empty temporal vector, and
    # every such row matches every other one. Counting those as "still
    # colliding" would blame the representation for a coverage gap, so they
    # are reported on their own line instead.
    seen = [r for r in wb if r["valid_observation_count"]]
    old, new = cross(prod_sig), cross(temp_sig)
    blank = len(wb) - len(seen)
    old_seen = cross({k: v for k, v in prod_sig.items()
                      if all(r["valid_observation_count"] for r in v)})
    new_seen = cross({k: v for k, v in temp_sig.items()
                      if all(r["valid_observation_count"] for r in v)})
    print("  wheat+barley rows examined            : %d" % len(wb))
    print("  of those with no usable observation   : %d" % blank)
    print("  identical under 5 median features     : %d  (observed rows only: %d)"
          % (old, old_seen))
    print("  identical under temporal features     : %d  (observed rows only: %d)"
          % (new, new_seen))
    print("  became distinguishable (observed)     : %d" % (old_seen - new_seen))

    # Do the temporal vectors carry real variation, or are they constant?
    both = [r for r in wb if r["ndvi_early_mean"] is not None]
    for c in ("wheat", "barley"):
        g = [r for r in both if r["crop"] == c]
        if not g:
            continue
        print("  %s: n=%d  ndvi early/mid/late means  %s"
              % (c, len(g), "  ".join(
                  "%s=%s" % (s, _fmt(_mean([r["ndvi_%s_mean" % s] for r in g])))
                  for s in SEGMENTS)))


def report_anomaly(rows):
    """Section 8: what do the onion and sugarcane curves actually look like?"""
    print("\n=== onion / sugarcane data quality ===")
    for c in ("onion", "sugarcane", "wheat"):          # wheat as a reference curve
        g = [r for r in rows if r["crop"] == c]
        if not g:
            continue
        print("  %s  (n=%d, %s)" % (c, len(g), "reference" if c == "wheat" else "under review"))
        print("     mean NDVI by fifth of window : %s"
              % "  ".join(_fmt(_mean([r["ndvi_q%d_mean" % i] for r in g]))
                          for i in range(1, N_FINE + 1)))
        print("     mean obs/season %.1f   mean max gap %.0f d   mean cloud %s%%   "
              "mean valid px %s"
              % (_mean([float(r["valid_observation_count"]) for r in g]),
                 _mean([float(r["max_gap_days"]) for r in g]),
                 _fmt(_mean([r["cloud_pct_mean"] for r in g]), 1),
                 _fmt(_mean([r["valid_px_mean"] for r in g]), 0)))
        peaks = [r["ndvi_peak"] for r in g if r["ndvi_peak"] is not None]
        amps = [r["ndvi_amplitude"] for r in g if r["ndvi_amplitude"] is not None]
        pf = [r["ndvi_peak_frac"] for r in g if r["ndvi_peak_frac"] is not None]
        print("     NDVI peak %s   amplitude %s   peak position %s of window"
              % (_fmt(_mean(peaks)), _fmt(_mean(amps)), _fmt(_mean(pf), 2)))
        have = [r for r in g if r["ndvi_peak"] is not None]
        odd = [r for r in have if r["ndvi_peak"] < 0.25]
        print("     rows whose NDVI never exceeds 0.25: %d of %d observed (%s)"
              % (len(odd), len(have),
                 "%.1f%%" % (100 * len(odd) / len(have)) if have else "n/a"))
        # Does the anomaly survive the temporal split, or was it the composite?
        for col in ("prod_ndvi", "ndvi_season_median", "ndvi_peak", "ndvi_amplitude"):
            print("     corr(%-20s, yield) = %s" % (col, _fmt(_pearson(
                [r.get(col) for r in g], [r["actual_yield"] for r in g]), 3)))


def _pearson(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pairs) < 3:
        return None
    n = len(pairs)
    mx = sum(x for x, _ in pairs) / n
    my = sum(y for _, y in pairs) / n
    num = sum((x - mx) * (y - my) for x, y in pairs)
    dx = sum((x - mx) ** 2 for x, _ in pairs) ** 0.5
    dy = sum((y - my) ** 2 for _, y in pairs) ** 0.5
    return num / (dx * dy) if dx and dy else None


def _fmt(v, places=3):
    return "n/a" if v is None else ("%.*f" % (places, v))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--report-only", action="store_true",
                    help="re-read the experimental CSV and reprint the reports")
    args = ap.parse_args()

    if args.report_only:
        with OUT_CSV.open(newline="", encoding="utf-8-sig") as fh:
            rows = [{k: (None if v == "" else _maybe(v)) for k, v in r.items()}
                    for r in csv.DictReader(fh)]
        cols = feature_columns()
    else:
        rows, cols = build()

    report_missing(rows, cols)
    report_collision(rows, cols)
    report_anomaly(rows)


def _maybe(v):
    try:
        return float(v)
    except ValueError:
        return v


if __name__ == "__main__":
    main()
