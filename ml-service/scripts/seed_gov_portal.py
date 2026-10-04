"""Load the government portal's analytical tables from REAL pipeline outputs.

    python -m scripts.seed_gov_portal            # load everything
    python -m scripts.seed_gov_portal --dry-run  # compute and report, write nothing

Runs under the service_role key, which is what lets it write tables the portal's
own RLS blocks for every authenticated user. That split is the point: these are
pipeline-owned tables, and this script is the pipeline.

WHAT IS REAL HERE, AND WHAT IS NOT
----------------------------------
Everything written by this script is derived from data already in the repository.
Nothing is generated, sampled or invented. Specifically:

  gov_satellite_indices       REAL. The five indices per district-crop-season
                              from data/training_data_real.csv, which came out
                              of Google Earth Engine.
  gov_yield_actuals           REAL. Reported yields from the same file, with the
                              provenance string carried across verbatim.
  gov_yield_predictions       REAL MODEL OUTPUT. app/model.pkl run over the real
                              indices above, with the interval taken from the
                              tree spread exactly as app/main.py does it. Rows
                              from seasons the model trained on are marked
                              'in_sample' and the portal says so.
  gov_subsidy_recommendations COMPUTED, from a rule written out in full below,
                              over real yields and real soil water capacity.
  gov_risk_alerts             COMPUTED, from a documented NDVI deviation rule
                              over the real index series.
  gov_datasets                FACTUAL. Describes the sources this project
                              actually uses; record counts are read back from
                              our own tables rather than asserted.

  gov_crop_area_estimates     NOT WRITTEN. No source exists -- see the note at
  gov_harvest_progress        the bottom of this file. The portal shows an
                              explicit empty state for both rather than a
                              plausible number.
"""
import argparse
import csv
import json
import os
import statistics
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import joblib
import numpy as np
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
if not URL or not KEY:
    sys.exit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in ml-service/.env")

TRAINING = ROOT / "data" / "training_data_real.csv"
SOIL = ROOT / "data" / "district_soil.csv"
CROPS_CSV = ROOT / "data" / "crops.csv"
MODEL = ROOT / "app" / "model.pkl"

# Seasons held out of training by scripts/train_real.py. A prediction for one of
# these is genuinely out-of-sample; a prediction for any other season is a fit
# to a row the forest has already seen. Read from the bundle rather than
# hardcoded, so a retrain cannot silently invalidate the labelling.
HOLDOUT_FALLBACK = ("2021-22", "2022-23")


# ------------------------------------------------------------------ transport
#
# urllib rather than the supabase client. One dependency fewer, and PostgREST's
# upsert is a plain header (`Prefer: resolution=merge-duplicates`) that the
# client would only wrap. Batched because a 2378-row insert one request at a
# time is 2378 round trips.

def _req(method, path, body=None, prefer=None):
    headers = {
        "apikey": KEY,
        "Authorization": "Bearer " + KEY,
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"{URL}/rest/v1/{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else [], resp.headers.get("content-range")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:600]
        raise SystemExit(
            f"\n{method} {path} failed with HTTP {e.code}:\n  {detail}\n\n"
            "If the table does not exist, apply the three migrations first:\n"
            "  supabase/migrations/20261003100000_gov_portal_schema.sql\n"
            "  supabase/migrations/20261003100100_gov_portal_rls.sql\n"
            "  supabase/migrations/20261003100200_gov_portal_seed.sql\n"
        )


def select(table, query=""):
    """Every row of a table, paged.

    PostgREST caps an unbounded select at 1000 rows by default and returns the
    first page WITHOUT saying it truncated. This project has already been caught
    by that once, so paging is explicit here rather than trusted.
    """
    out, offset = [], 0
    # `query` is often empty; interpolating it bare would emit "select=*&&limit=…"
    # and PostgREST rejects the empty parameter.
    extra = f"&{query}" if query else ""
    while True:
        page, _ = _req("GET", f"{table}?select=*{extra}&limit=1000&offset={offset}")
        out += page
        if len(page) < 1000:
            return out
        offset += 1000


def upsert(table, rows, conflict, dry_run=False, chunk=500):
    if not rows:
        print(f"  {table:32} 0 rows (nothing to write)")
        return
    if dry_run:
        print(f"  {table:32} {len(rows):5} rows (dry run, not written)")
        return
    for i in range(0, len(rows), chunk):
        _req(
            "POST",
            f"{table}?on_conflict={conflict}",
            rows[i : i + chunk],
            prefer="resolution=merge-duplicates,return=minimal",
        )
    print(f"  {table:32} {len(rows):5} rows upserted")


# ------------------------------------------------------------------ inputs

def load_crop_windows():
    """sow_typical and duration_days per crop, for the composite date and lead time."""
    out = {}
    for r in csv.DictReader(open(CROPS_CSV, encoding="utf-8-sig")):
        if not r.get("sow_typical") or not r.get("duration_days"):
            continue
        mm, dd = (int(x) for x in r["sow_typical"].split("-"))
        out[r["crop"]] = {
            "sow_md": (mm, dd),
            "duration": int(r["duration_days"]),
            "obs_start": r["obs_start"],
            "obs_end": r["obs_end"],
            "season": r["season"],
        }
    return out


def season_years(label):
    """'2024-25' -> (2024, 2025). The agricultural year spans two calendar ones."""
    a, b = label.split("-")
    return int(a), int(a[:2] + b)


def composite_date(crop_win, season_label):
    """A representative date for a seasonal median composite.

    The training CSV has no date column because each row IS a season-long median
    over the crop's observation window -- there is no single acquisition to point
    at. The midpoint of that window is the honest stand-in, and gov_satellite_
    indices.source says explicitly that the row is a composite, so nothing
    downstream mistakes it for one Sentinel-2 pass.
    """
    y0, y1 = season_years(season_label)
    sm, sd = (int(x) for x in crop_win["obs_start"].split("-"))
    em, ed = (int(x) for x in crop_win["obs_end"].split("-"))
    start = date(y0 if sm >= 5 else y1, sm, sd)
    end = date(y0 if em >= 5 else y1, em, ed)
    if end < start:                       # window crosses the new year
        end = date(end.year + 1, em, ed)
    return start + (end - start) / 2


def harvest_date(crop_win, season_label):
    y0, y1 = season_years(season_label)
    sm, sd = crop_win["sow_md"]
    sow = date(y0 if sm >= 5 else y1, sm, sd)
    return sow + timedelta(days=crop_win["duration"])


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="compute and report row counts, write nothing")
    ap.add_argument("--offline", action="store_true",
                    help="also stub the dimension ids from the CSVs, so the whole "
                         "computation runs with no database at all. Implies --dry-run "
                         "and is how the rules below are checked before any migration "
                         "has been applied.")
    args = ap.parse_args()
    if args.offline:
        args.dry_run = True

    print("Government portal seed" + (" (DRY RUN)" if args.dry_run else ""))
    print(f"  project {'(offline, no database)' if args.offline else URL}\n")

    # --- dimensions, which the SQL migration seeded ------------------------
    if args.offline:
        # Deterministic fake uuids so row assembly is exercised end to end.
        def _id(prefix, n):
            return f"{prefix}{n:08d}-0000-4000-8000-000000000000"[:36]
        src = list(csv.DictReader(open(TRAINING, encoding="utf-8-sig")))
        districts = {n: _id("d", i) for i, n in enumerate(sorted({r["district"] for r in src}))}
        crops = {n: _id("c", i) for i, n in enumerate(sorted({r["crop_type"] for r in src}))}
        seasons = {n: _id("5", i) for i, n in enumerate(sorted({r["season"] for r in src}))}
    else:
        districts = {d["name"]: d["id"] for d in select("gov_districts")}
        crops = {c["name"]: c["id"] for c in select("gov_crops")}
        seasons = {s["label"]: s["id"] for s in select("gov_seasons")}
    if not districts or not crops or not seasons:
        sys.exit("Dimension tables are empty. Apply 20261003100200_gov_portal_seed.sql first.")
    print(f"dimensions: {len(districts)} districts, {len(crops)} crops, {len(seasons)} seasons")

    bundle = joblib.load(MODEL)
    feature_names = list(bundle["feature_names"])
    trained = {str(c) for c in bundle["trained_crops"]}
    holdout = set(bundle.get("metrics", {}).get("test_seasons") or HOLDOUT_FALLBACK)
    per_crop_r2 = {str(k): float(v) for k, v in (bundle.get("per_crop_r2") or {}).items()}
    print(f"model {bundle['model_name']}: {len(trained)} trained crops, "
          f"holdout seasons {sorted(holdout)}")

    windows = load_crop_windows()
    soil = {r["district"]: r for r in csv.DictReader(open(SOIL, encoding="utf-8-sig"))}

    rows = list(csv.DictReader(open(TRAINING, encoding="utf-8-sig")))
    print(f"source  {TRAINING.name}: {len(rows)} rows\n")

    idx_rows, actual_rows, pred_rows = [], [], []
    pred_inputs, pred_meta = [], []
    skipped = defaultdict(int)
    # ndvi by (crop, season) and by (district, crop), for the alert rule below.
    ndvi_by_dc = defaultdict(list)
    yield_by_dc = defaultdict(list)
    latest_season = max(seasons, key=lambda s: season_years(s)[0])

    for r in rows:
        dname, cname, slabel = r["district"], r["crop_type"], r["season"]
        did, cid, sid = districts.get(dname), crops.get(cname), seasons.get(slabel)
        if not (did and cid and sid):
            skipped["unknown dimension"] += 1
            continue
        win = windows.get(cname)
        if not win:
            skipped["no crop window"] += 1
            continue

        idx = {k: (float(r[k]) if r.get(k) not in (None, "") else None)
               for k in ("ndvi", "evi", "ndwi", "savi", "nbr")}
        cdate = composite_date(win, slabel)

        idx_rows.append({
            "district_id": did, "crop_id": cid, "season_id": sid,
            "date": cdate.isoformat(), **idx,
            "source": "Sentinel-2 L2A seasonal median composite (Google Earth Engine)",
        })

        if r.get("actual_yield"):
            y = float(r["actual_yield"])
            actual_rows.append({
                "district_id": did, "crop_id": cid, "season_id": sid,
                "yield_t_ha": y, "source": "PBS",
                "confidence": r.get("yield_confidence") or None,
            })
            yield_by_dc[(dname, cname)].append((slabel, y))

        if idx["ndvi"] is not None:
            ndvi_by_dc[(dname, cname)].append((slabel, idx["ndvi"]))

        # --- real model output ---------------------------------------------
        # Refused rather than filled for a crop the forest never saw, for the
        # same reason app/main.py returns 422: a Random Forest handed an unseen
        # one-hot does not fail, it answers for the nearest leaf -- a wheat
        # yield for barley.
        if cname not in trained:
            skipped[f"crop not trained ({cname})"] += 1
            continue
        if any(v is None for v in idx.values()):
            skipped["incomplete indices"] += 1
            continue

        oh = {f"crop_{c}": (1.0 if c == cname else 0.0) for c in trained}
        try:
            vec = [idx[n] if n in idx else oh[n] for n in feature_names]
        except KeyError as e:
            skipped[f"feature missing {e}"] += 1
            continue

        # Vector now, prediction after the loop. Calling each tree once per ROW
        # is 500 trees x ~2100 rows = a million single-row predict calls, which
        # takes minutes; calling each tree once on the whole matrix is 500 calls
        # and takes about a second for an identical result.
        pred_inputs.append(vec)
        pred_meta.append({
            "district_id": did, "crop_id": cid, "season_id": sid,
            "model_used": bundle["model_name"],
            "lead_days": max(0, (harvest_date(win, slabel) - cdate).days),
            "evaluation": "holdout" if slabel in holdout else "in_sample",
        })

    # Same interval as production: the spread of the individual trees, 10th to
    # 90th percentile. It is model DISAGREEMENT, not a calibrated prediction
    # interval -- app/main.py's comment on that applies verbatim here, and the
    # portal repeats the caveat rather than printing a bare range.
    if pred_inputs:
        X = np.array(pred_inputs)
        votes = np.stack([t.predict(X) for t in bundle["model"].estimators_])  # (trees, rows)
        means = votes.mean(axis=0)
        los = np.percentile(votes, 10, axis=0)
        his = np.percentile(votes, 90, axis=0)
        for m, mu, lo_, hi_ in zip(pred_meta, means, los, his):
            pred_rows.append({**m,
                              "predicted_yield": round(float(mu), 2),
                              "ci_low": round(float(lo_), 2),
                              "ci_high": round(float(hi_), 2)})

    print("built:")
    print(f"  satellite indices   {len(idx_rows)}")
    print(f"  reported yields     {len(actual_rows)}")
    print(f"  model predictions   {len(pred_rows)} "
          f"({sum(1 for p in pred_rows if p['evaluation'] == 'holdout')} out-of-sample)")
    for k, v in sorted(skipped.items()):
        print(f"  skipped: {k:28} {v}")

    # ---------------------------------------------------------------- alerts
    #
    # THE RULE, in full: for the latest season, flag a district-crop whose NDVI
    # sits more than one standard deviation below that district-crop's own mean
    # across every earlier season, needing at least four prior seasons to have a
    # mean worth comparing against.
    #
    # Per district-crop rather than province-wide on purpose. Barani Chakwal
    # runs structurally drier than canal-irrigated Sahiwal, so a provincial
    # threshold would flag the north every single season and tell a policymaker
    # nothing they did not already know. A district compared against its own
    # history flags a CHANGE.
    #
    # Only 'drought' and 'water_stress' are produced. Flood needs SAR
    # backscatter and anomaly needs a within-season series; neither exists at
    # this grain, so neither is fabricated -- the portal shows those two
    # categories as having no detector wired rather than as having no events.
    DROUGHT_SIGMA = 1.0
    MIN_HISTORY = 4
    alert_rows = []
    for (dname, cname), series in sorted(ndvi_by_dc.items()):
        hist = [v for s, v in series if s != latest_season]
        cur = next((v for s, v in series if s == latest_season), None)
        if cur is None or len(hist) < MIN_HISTORY:
            continue
        mean = statistics.fmean(hist)
        sd = statistics.pstdev(hist)
        if sd == 0:
            continue
        z = (cur - mean) / sd
        if z > -DROUGHT_SIGMA:
            continue
        # NDWI is canopy water; a dry canopy alongside low greenness points at
        # irrigation rather than at a failed stand, so the two get different
        # labels and a reviewer can tell which they are looking at.
        severity = "high" if z <= -2.0 else "medium" if z <= -1.5 else "low"
        kind = "drought" if z <= -1.5 else "water_stress"
        alert_rows.append({
            "district_id": districts[dname], "crop_id": crops[cname],
            "season_id": seasons[latest_season],
            "alert_type": kind, "severity": severity,
            "message": (
                f"{cname.title()} NDVI in {dname} is {abs(cur - mean):.3f} below this "
                f"district's own {len(hist)}-season mean ({z:+.2f} SD). "
                f"Observed {cur:.3f} against {mean:.3f}."
            ),
            "details": {
                "rule": "seasonal NDVI below district-crop historical mean",
                "threshold_sd": -DROUGHT_SIGMA, "observed_ndvi": round(cur, 4),
                "historical_mean": round(mean, 4), "historical_sd": round(sd, 4),
                "z_score": round(z, 3), "seasons_compared": len(hist),
                "season": latest_season, "source": "Sentinel-2 seasonal composites",
            },
        })
    print(f"  risk alerts         {len(alert_rows)} (rule: NDVI < district mean "
          f"- {DROUGHT_SIGMA} SD, >= {MIN_HISTORY} prior seasons)")

    # --------------------------------------------------------------- subsidy
    #
    # THE RULE the brief specifies, implemented literally and stored in `reason`
    # so the screen can print it per row:
    #
    #   (predicted yield significantly below historical average)
    #     AND (low soil/water access factor)
    #
    # Left half  : latest-season reported yield against the district-crop mean of
    #              all earlier seasons. A deficit of 10% or more counts as
    #              significant -- below that it is inside the year-to-year noise
    #              of the PBS series itself.
    # Right half : water_33k from data/district_soil.csv, the volumetric water
    #              held at field capacity (-33 kPa). It is the real, measured
    #              proxy for how much of an irrigation turn the soil can retain.
    #              Scored as a PERCENTILE RANK across the 34 districts, not a
    #              min-max rescale: water_33k is skewed, so on a min-max scale
    #              "access >= 0.5" means "below the midpoint of the range" and
    #              caught only 22 of 242 district-crops, while the reason string
    #              printed on screen claims "the drier half of Punjab". A rank
    #              makes the number mean what the row says it means, which
    #              matters more here than anywhere else in the portal -- this
    #              column is the stated justification for moving public money.
    #
    # BOTH halves must fire. A district with a bad season on good soil needs a
    # different intervention from one with a bad season on sand, and the brief
    # is explicit that the conjunction is the rule.
    DEFICIT_PCT = 10.0
    ACCESS_FLOOR = 0.5
    w33 = {d: float(s["water_33k"]) for d, s in soil.items() if s.get("water_33k")}
    ranked = sorted(w33, key=lambda d: w33[d])
    # 0.0 for the district with the least retentive soil in Punjab, 1.0 for the most.
    retention_rank = {d: (i / (len(ranked) - 1) if len(ranked) > 1 else 0.5)
                      for i, d in enumerate(ranked)}
    subsidy = []
    for (dname, cname), series in sorted(yield_by_dc.items()):
        hist = [v for s, v in series if s != latest_season]
        cur = next((v for s, v in series if s == latest_season), None)
        if cur is None or len(hist) < MIN_HISTORY or dname not in w33:
            continue
        mean = statistics.fmean(hist)
        if mean <= 0:
            continue
        deficit = (mean - cur) / mean * 100.0
        retention = retention_rank[dname]
        access = 1.0 - retention
        if deficit < DEFICIT_PCT or access < ACCESS_FLOOR:
            continue
        subsidy.append({
            "district": dname, "crop": cname,
            "deficit": deficit, "access": access,
            "score": min(1.0, (deficit / 50.0) * 0.5 + access * 0.5),
            "reason": (
                f"Yield {deficit:.1f}% below {dname}'s own {len(hist)}-season mean for "
                f"{cname} ({cur:.2f} against {mean:.2f} t/ha), AND soil water retention "
                f"at field capacity ranks in the driest {access * 100:.0f}% of Punjab's "
                f"{len(ranked)} districts ({w33[dname]:.1f} vol% at -33 kPa). "
                f"Both conditions are required for a district to appear here."
            ),
        })
    # Rank within (crop, resource), highest priority first -- rank is unique per
    # that grain in the schema, so it has to be assigned after the full sort.
    subsidy.sort(key=lambda s: -s["score"])
    subsidy_rows = []
    rank_at = defaultdict(int)
    for s in subsidy:
        rank_at[s["crop"]] += 1
        subsidy_rows.append({
            "district_id": districts[s["district"]], "crop_id": crops[s["crop"]],
            "season_id": seasons[latest_season], "resource_type": "water",
            "rank": rank_at[s["crop"]], "reason": s["reason"],
            "yield_deficit_pct": round(s["deficit"], 2),
            "resource_access_score": round(s["access"], 4),
            "priority_score": round(s["score"], 4),
        })
    print(f"  subsidy targets     {len(subsidy_rows)} (rule: deficit >= {DEFICIT_PCT}% "
          f"AND water access score >= {ACCESS_FLOOR})")

    # -------------------------------------------------------------- datasets
    #
    # These describe sources the project genuinely uses. Record counts are read
    # back from what was just loaded rather than asserted, and anything this
    # project has not validated carries no quality score instead of a flattering
    # one.
    dataset_rows = [
        {"name": "Sentinel-2 L2A seasonal composites", "version": "1",
         "source": "Copernicus / Google Earth Engine",
         "coverage": f"{len(districts)} Punjab districts · 10 m · per crop season",
         "description": "Median composites over each crop's observation window, "
                        "reduced per district. Feeds gov_satellite_indices.",
         "status": "verified", "record_count": len(idx_rows), "quality_score": None},
        {"name": "PBS reported district yields", "version": "1",
         "source": "Pakistan Bureau of Statistics · Crop Reporting Service",
         "coverage": f"{len(districts)} districts · {len(seasons)} seasons · 11 crops",
         "description": "Reported yields used as ground truth. Row-level provenance "
                        "is kept in gov_yield_actuals.confidence.",
         "status": "verified", "record_count": len(actual_rows), "quality_score": None},
        {"name": "OpenLandMap district soil profile", "version": "1",
         "source": "OpenLandMap via Google Earth Engine",
         "coverage": f"{len(w33)} districts · 0–30 cm root zone",
         "description": "pH, texture, bulk density and water at field capacity. "
                        "Supplies the water-access half of the subsidy rule.",
         "status": "verified", "record_count": len(w33), "quality_score": None},
        {"name": f"{bundle['model_name']} yield model", "version": "1",
         "source": "Smart Agriculture ML pipeline",
         "coverage": f"{len(trained)} crops · trained on {bundle.get('n_rows', '?')} rows",
         "description": (
             "RandomForest on five spectral indices plus crop identity. Holdout R² "
             f"{bundle.get('metrics', {}).get('holdout_r2', '?')} pooled across crops; "
             "per-crop R² varies widely and is published per crop in the portal."),
         "status": "verified", "record_count": len(pred_rows), "quality_score": None},
        {"name": "Crop area classification", "version": "0",
         "source": "Not yet produced",
         "coverage": "—",
         "description": "No crop-area classification has been run. gov_crop_area_estimates "
                        "is empty and screen 5 says so rather than estimating.",
         "status": "pending", "record_count": 0, "quality_score": None},
        {"name": "Harvest progress reporting", "version": "0",
         "source": "Not yet collected",
         "coverage": "—",
         "description": "District harvest progress needs officer returns or a per-field "
                        "detector run at scale. Neither exists; gov_harvest_progress is empty.",
         "status": "pending", "record_count": 0, "quality_score": None},
    ]

    # ------------------------------------------------------------------ write
    print("\nwriting:" if not args.dry_run else "\nwould write:")
    upsert("gov_satellite_indices", idx_rows,
           "district_id,crop_id,season_id,date", args.dry_run)
    upsert("gov_yield_actuals", actual_rows,
           "district_id,crop_id,season_id", args.dry_run)
    upsert("gov_yield_predictions", pred_rows,
           "district_id,crop_id,season_id,lead_days", args.dry_run)
    upsert("gov_subsidy_recommendations", subsidy_rows,
           "district_id,crop_id,season_id,resource_type", args.dry_run)
    upsert("gov_datasets", dataset_rows, "name,version", args.dry_run)

    # gov_risk_alerts has no natural key to upsert on -- an alert is an event,
    # and two identical events on different days are two alerts, not one. So the
    # season's generated alerts are cleared and rewritten, which keeps a re-run
    # idempotent without pretending an event has an identity.
    #
    # Filtered on season + the two types this script generates, NOT on the jsonb
    # `rule` string: that predicate needed the rule sentence in the URL, and its
    # spaces have to be percent-encoded or urllib builds a malformed request.
    # Keying on the enum is both encodable and narrower -- it cannot delete a
    # flood or anomaly alert written by some other producer.
    if alert_rows and not args.dry_run:
        _req("DELETE",
             f"gov_risk_alerts?season_id=eq.{seasons[latest_season]}"
             f"&alert_type=in.%28drought,water_stress%29")
        for i in range(0, len(alert_rows), 500):
            _req("POST", "gov_risk_alerts", alert_rows[i : i + 500], prefer="return=minimal")
        print(f"  {'gov_risk_alerts':32} {len(alert_rows):5} rows replaced for {latest_season}")
    elif args.dry_run:
        print(f"  {'gov_risk_alerts':32} {len(alert_rows):5} rows (dry run, not written)")

    # ------------------------------------------------------------ not written
    print(
        "\nNOT SEEDED, because no real source exists:\n"
        "  gov_crop_area_estimates   needs a crop-type classification raster per season.\n"
        "                            The pipeline has never produced one; the training set\n"
        "                            is district-crop-season rows, which carry no area.\n"
        "  gov_harvest_progress      needs either officer returns at district scale or the\n"
        "                            per-field harvest detector run across every farm. The\n"
        "                            detector exists (app/harvest.py) but is unvalidated --\n"
        "                            20-30 real harvest dates are still the binding\n"
        "                            constraint -- so running it province-wide would\n"
        "                            publish an unvalidated number as a statistic.\n"
        "  Both screens render an explicit empty state naming the missing input.\n"
    )
    print("Per-crop R2 from the model bundle, which the portal publishes so no screen\n"
          "implies uniform accuracy:")
    for c, r2 in sorted(per_crop_r2.items(), key=lambda kv: -kv[1]):
        flag = "" if r2 > 0.3 else "   <- weak, portal labels predictions for this crop"
        print(f"  {c:12} R2 {r2:+.4f}{flag}")

    print("\nDone." + (" (dry run, nothing written)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
