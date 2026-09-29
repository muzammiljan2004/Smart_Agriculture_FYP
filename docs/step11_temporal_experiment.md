# Temporal Satellite Feature Experiment

*Experimental result. The production system was not changed by this work.*

## 1. Purpose and status

The production yield model represents each crop season as a **single median composite** of five
Sentinel-2 indices over that crop's observation window. This collapses green-up rate, peak height
and senescence timing into one number per index, and a prior diagnostic established that the
resulting model behaves largely as a crop-name lookup.

This experiment asks one question: **does keeping the within-season temporal shape carry
information that the season-long median discards?**

It is a research result. No part of it was promoted to production. The shipped median-composite
model, `/predict`, `/health`, the crop list, the frontend, the database schema and RLS are all
exactly as they were before the experiment began.

---

## 2. Pipeline

```
fetch  →  build  →  train  →  ablate  →  time-aware validate
```

| Stage | Script | Output |
|---|---|---|
| fetch | `ml-service/scripts/fetch_temporal_observations.py` | `temporal_observations_raw.csv` |
| build | `ml-service/scripts/build_temporal_features.py` | `training_data_temporal_experiment.csv` |
| train / ablate / validate | `ml-service/scripts/train_temporal_experiment.py` | `model_temporal_experiment.pkl` |

All three data artifacts live in `experimental/temporal_features/`, deliberately outside the
`ml-service` tree, so the experimental model cannot be mistaken for the production one.

### 2.1 Fetch

The production fetch reduces one median composite per district-crop-season. This fetch keeps one
observation **per date** instead. To make that affordable it batches by crop-season — every
district in a crop-season shares the same date window — and stacks the dates as bands of a single
image so one `reduceRegions` call serves the whole unit. That reduced 2,378 separate requests to
85, and a measured 392 s per crop-season to roughly 20 s.

Reduction scale is 500 m rather than the production composite's 100 m, because reducing every
scene in a window instead of one composite raises the per-request pixel budget by two orders of
magnitude. A Punjab district is ~5,000 km², which is still ~20,000 pixels at 500 m. To keep the
comparison honest the build stage **recomputes the median representation at this same 500 m
scale**, so the temporal-vs-median contrast is like-for-like and is not confounded by resolution.

Because several Sentinel-2 granules cover one district on a single overpass day, each day is
mosaicked before reduction. Reduced granule-by-granule, one date would arrive as several partial,
disagreeing district means, which the feature engineering would read as real day-to-day variation.

### 2.2 Experiment setup

Source dataset, unchanged and used only as a read-only label source:

| | |
|---|---|
| Rows | 2,378 (district × crop × season) |
| Crops | 11 |
| Districts | 34 |
| Seasons | 2017-18 … 2024-25 |
| Labels and coverage | identical to `training_data_real.csv` |

The fetch plan was derived **from** `training_data_real.csv`, so coverage is identical by
construction and any difference in results cannot be a difference in rows.

Collection result:

| | |
|---|---|
| Raw satellite observations | 136,687 |
| Crop-season units fetched | 85 |
| Failures | 0 |
| No-imagery cases | 0 |
| Scale fallbacks | 0 |

The experimental dataset is **2,378 rows** — the same keys, verified unique. The yield label was
never duplicated across segments; only the width of each row changed, from 11 columns to 111.

### 2.3 Temporal features

Approximately 100 engineered columns, derived from NDVI, EVI, NDWI, SAVI and NBR.

Per index (19 columns each):

- **Level** — season median, early/mid/late means, q1–q5 means, peak, minimum
- **Shape** — amplitude, early-to-mid change, mid-to-late change, overall change
- **Growth** — growth slope, decline slope (split at the peak *observation*, not a calendar
  midpoint, so a season that peaked early is not scored as declining for half its length;
  expressed per day, because observations are unevenly spaced)
- **Timing** — peak position as a fraction of the window

Coverage and quality (10 columns): valid observation count, early/mid/late observation counts,
segments covered, mean cloud percentage, mean valid pixels, first and last observation timing,
maximum observation gap.

**Three broad segments, not five.** Segmentation must be affordable in observations. A rabi window
is 105 days and Punjab's winter fog leaves single figures of usable dates in parts of it, so five
equal segments produce segments that are empty more often than not for the shorter crop windows.
The five-way split is retained as `q1`–`q5` level means so the finer division can be measured
rather than assumed.

Segments are equal **calendar** parts, not equal observation counts. Splitting by count would make
"early" cover a different number of days in a cloudy season than a clear one, so the same feature
name would describe different points of the crop's life.

**Missing values are recorded as missing**, with a companion `_isna` flag and an explicit
observation count, never filled with a season mean. Imputation to the training median happens at
model-fit time only, fitted on the training half alone.

### 2.4 Coverage achieved

35 of 95 feature columns are fully populated. The worst column is `ndwi_growth_slope` at 9.2%
missing — a slope requires at least three observations on the relevant side of the peak.

| Crop | Rows | Obs/season | Empty early | Empty mid | Empty late |
|---|---:|---:|---:|---:|---:|
| bajra | 201 | 18.1 | 7.5% | 8.0% | 0.0% |
| barley | 131 | 42.7 | 0.0% | 0.0% | 0.0% |
| cotton | 182 | 74.2 | 0.0% | 3.8% | 0.0% |
| jowar | 184 | 38.5 | 0.5% | 9.8% | 0.0% |
| maize | 184 | 45.7 | 8.7% | 0.0% | 0.0% |
| onion | 237 | 68.6 | 0.0% | 0.0% | 0.0% |
| potato | 249 | 54.0 | 0.0% | 0.0% | 0.0% |
| rice | 248 | 48.4 | 0.4% | 5.6% | 0.0% |
| sugarcane | 240 | 121.8 | 0.0% | 0.0% | 0.0% |
| tomato | 250 | 59.8 | 0.0% | 0.0% | 0.0% |
| wheat | 272 | 43.6 | 0.0% | 0.0% | 0.0% |

### 2.5 Anti-leakage

Every feature for a row is computed only from observations carrying that row's own
(crop, season, district) key, inside that crop's own observation window. The yield column is read
only to be copied through and is never an input to any feature. No harvest date is used. No future
season, no other district and no other season contributes to any row.

---

## 3. Wheat / barley collision

The wheat and barley observation windows are identical — both `12-01 .. 03-15` — so under the
median representation the two crops in the same district-season reduce to the same five numbers.

| Representation | Wheat+barley rows examined | Identical representations |
|---|---:|---:|
| Five median features | 403 | 106 |
| Temporal features | 403 | 69 |

> **Temporal features resolved 37 of the 106 wheat/barley collisions, approximately 35%, but did
> not resolve all collisions.**

Zero of the 403 rows lacked usable observations, so the 69 remaining collisions are genuine rather
than an artifact of empty vectors.

The remaining collisions are consistent with the shared `12-01 .. 03-15` window and with very
similar district-level vegetation curves:

| Crop | Early NDVI | Mid NDVI | Late NDVI |
|---|---:|---:|---:|
| wheat | 0.342 | 0.453 | 0.511 |
| barley | 0.326 | 0.420 | 0.491 |

Barley traces the same shape roughly 0.02 lower throughout. At district-average resolution that
separation is small relative to the spread within each crop. Temporal features do not completely
solve wheat/barley separation.

---

## 4. The `valid_px_mean` ablation catch

**This is the most important methodological finding in the experiment.**

The first temporal model appeared to deliver a large improvement. Inspecting feature importance
showed `valid_px_mean` — the mean number of reduced pixels contributing to a district's
observations — as the fifth-most-important feature in the whole model (0.0130), ranked above every
vegetation column.

`valid_px_mean` is not a vegetation measurement. It is the district's **area**, expressed in
pixels:

- It takes a distinct value in **all 34 districts** (mean values range from 4,516 to 45,848).
- It therefore identifies the district outright.
- A forest can use it as a district lookup — the same failure mode as the crop one-hot, one level
  down.
- Part of the apparent performance gain was therefore **not attributable to temporal vegetation
  information**.

This was not anticipated. It was found only because the arms were ablated, and the ablation is now
a permanent part of the training script rather than something a reader must think to request.

### 4.1 Ablation arms

1. **median / current** — five median-composite indices + crop one-hot (the production design)
2. **temporal** — all engineered temporal features + crop one-hot
3. **no_px** — temporal, minus `valid_px_mean` alone
4. **veg_only** — temporal, minus the entire coverage/quality block
5. **both** — median + temporal stacked

All five use identical rows, labels, holdout and forest hyper-parameters (500 trees, max_depth 25,
`squared_error`, seed 42), so the only thing that varies is the feature set.

### 4.2 Fixed-holdout results (test seasons 2021-22 and 2022-23)

| Model | Holdout R² | RMSE | MAE |
|---|---:|---:|---:|
| Median / current | 0.9212 | 5.6467 | 2.8956 |
| Temporal | 0.9465 | 4.6527 | 2.4971 |
| No_px | 0.9350 | 5.1282 | 2.7016 |
| **Vegetation-only** | **0.9311** | **5.2818** | **2.6990** |
| Both | 0.9468 | 4.6390 | 2.4886 |

> The initial headline gain was partially inflated by a district-identity proxy. After removing
> `valid_px_mean`, the temporal vegetation-only model still improved over the median-composite
> baseline, but by a smaller and more defensible margin.

The 0.9465 and 0.9468 figures are **not** the evidence of temporal-feature quality and are reported
only to document what the ablation removed. The defensible comparison is
**0.9311 (vegetation-only) against 0.9212 (median)**.

Removing that single column costs most of the gain on three crops:

| Crop | Temporal | No_px | Veg-only | Median |
|---|---:|---:|---:|---:|
| sugarcane | 0.4127 | 0.1944 | 0.1739 | 0.2505 |
| tomato | 0.1995 | 0.0516 | −0.1192 | −0.5420 |
| maize | 0.1855 | 0.0305 | −0.1916 | −0.1629 |
| wheat | 0.7853 | 0.7748 | 0.7730 | 0.7176 |

Sugarcane and maize are in fact **worse** than the median baseline once the district proxy is
removed. Wheat is nearly unaffected, which is what makes the wheat result credible.

---

## 5. Per-crop results — fixed holdout, vegetation-only

| Crop | R² |
|---|---:|
| Bajra | −0.7197 |
| Barley | −0.1383 |
| Cotton | 0.2559 |
| Jowar | 0.3807 |
| Maize | −0.1916 |
| Onion | 0.3308 |
| Potato | 0.2607 |
| Rice | −0.0453 |
| Sugarcane | 0.1739 |
| Tomato | −0.1192 |
| Wheat | **0.7730** |

**Five of eleven crops remain negative**, meaning the model does worse than predicting that crop's
own holdout mean. The experiment therefore **does not demonstrate uniformly reliable 11-crop yield
prediction.** Barley trained without error at 19 holdout rows and was not removed.

---

## 6. Wheat

| | R² |
|---|---:|
| Production median-composite model (prior result) | ≈ 0.711 |
| Experiment's own median arm, same holdout | 0.7176 |
| Temporal vegetation-only | **0.7730** |
| Temporal vegetation-only, time-aware split | 0.4565 (vs 0.4250 median) |

> **A genuine gain, held under time-aware validation, but not large enough alone to justify a
> production swap this close to submission.**

The improvement is meaningful precisely because it survives the time-aware split, where the model
never sees a future season: wheat improves under both validation designs, and unlike sugarcane and
maize it barely moves when `valid_px_mean` is removed. That rules out the district proxy as the
explanation.

This is **not** a production improvement. A single crop improving by ~0.06 R² in a research
pipeline is not sufficient justification for replacing a tested production model shortly before
submission.

---

## 7. Sugarcane — window mechanism

Current observation window: `03-01 → 11-30`.

Mean NDVI by calendar month across all sugarcane observations:

| Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.49 | 0.30 | 0.23 | 0.23 | 0.28 | 0.39 | 0.45 | 0.37 | 0.28 |

NDVI is at its **highest on the first day of the window** and falls for three months. Mean peak
position is 0.15 of the window, against wheat's 0.73. That is not the shape of a crop growing
through its window.

Sugarcane is a ~330-day crop and is commonly ratooned, so a window opening on 1 March can open on
the previous cycle's standing mature cane, capture its harvest, and only then observe the
subsequent crop rising to 0.45 by September.

> The temporal analysis provides evidence that the current calendar window can mix two sugarcane
> crop cycles, making the window biologically misaligned for a long-duration crop.

This is evidence for the mechanism, not proof that it is the sole cause of sugarcane's prediction
behaviour.

---

## 8. Onion — unresolved

Onion showed a negative satellite/yield correlation in the earlier diagnostic. The temporal data
does not explain it.

What the experiment found for onion:

- **Sufficient observations** — 68.6 per season, among the highest of any crop
- **Low cloud** — 3.0% mean scene cloud
- **Substantial valid pixels** — 17,849 mean
- **Reasonable gaps** — 17-day mean maximum gap
- **Plausible NDVI behaviour** — by fifth of window: 0.340 → 0.422 → 0.501 → 0.498 → 0.322, a
  textbook single-peak curve with peak position 0.52 and amplitude 0.421
- **No implausible values** — no row fails to exceed NDVI 0.25

The negative relationship survives every representation tested:

| Feature | Correlation with yield |
|---|---:|
| `prod_ndvi` (100 m median composite) | −0.175 |
| `ndvi_season_median` (500 m median) | −0.210 |
| `ndvi_peak` | −0.254 |
| `ndvi_amplitude` | −0.101 |
| *(wheat reference: `ndvi_peak`)* | *+0.554* |

> Onion's negative correlation remains unresolved. The experiment found no evidence that missing
> observations, cloud contamination, or the median-composite representation explains it.

No agronomic explanation is offered, because the experiment produced no evidence for one.

---

## 9. Time-aware validation

The fixed holdout trains on 2023-24 and 2024-25 while testing on 2021-22, which lets the model see
the future. The time-aware design removes that:

- **Training:** seasons ≤ 2022-23 (1,864 rows)
- **Testing:** 2023-24 and 2024-25 (514 rows)

Overall:

| Model | R² | RMSE | MAE |
|---|---:|---:|---:|
| Median / current | 0.9043 | 6.5428 | 3.4751 |
| Temporal | 0.9275 | 5.6954 | 3.1105 |
| No_px | 0.9144 | 6.1875 | 3.3407 |
| **Vegetation-only** | **0.9073** | **6.4411** | **3.3830** |
| Both | 0.9275 | 5.6973 | 3.1158 |

Per crop, vegetation-only:

| Crop | R² |
|---|---:|
| Wheat | 0.4565 |
| Sugarcane | 0.2314 |
| Potato | 0.2545 |
| Onion | 0.2085 |
| Cotton | 0.1870 |
| Rice | 0.1554 |
| Jowar | 0.1385 |
| Barley | 0.0270 |
| Tomato | −0.1892 |
| Maize | −0.6969 |
| Bajra | −0.9292 |

Every arm drops on this harder split, and the ordering between arms is preserved. The experiment
still provides evidence that temporal features can generalize better than a season-level median
representation. These results are **not** proof of deployment readiness.

---

## 10. Crop-label dominance

The earlier diagnostic measured the production model at roughly 90.7% crop one-hot importance
against 9.3% satellite importance. The same measurement across the experimental arms:

| Arm | Crop one-hot | Satellite | Coverage / quality |
|---|---:|---:|---:|
| median | 90.89% | 9.11% | 0.00% |
| temporal | 90.89% | 6.44% | 2.67% |
| no_px | 90.89% | 7.17% | 1.94% |
| veg_only | 90.89% | 9.11% | 0.00% |
| both | 90.89% | 6.45% | 2.65% |

**The temporal representation did not reduce crop-label dominance at all.** This was checked for a
bug — three separately fitted forests return crop shares of 0.908944, 0.908934 and 0.908934, and
`crop_sugarcane` lands on **0.746793 in all of them, identical to six decimal places**.

The invariance is the finding. The root split separating sugarcane's ~63 t/ha mean from every other
crop's 0.8–23 t/ha removes a fixed quantity of variance regardless of what other columns exist, so
the 90/10 figure measures the **yield-scale gap between crops pooled into one regressor**, not the
model's reliance on imagery. It cannot be moved by feature engineering, and it should not be used
as a target.

---

## 11. Final interpretation

### What the experiment demonstrates

1. Per-date satellite observations can be recovered at useful coverage — 136,687 observations,
   18–122 per district-season, zero fetch failures.
2. Temporal feature engineering contains information beyond a single season-level median.
3. Temporal vegetation features improve the overall fixed-holdout result over the median composite
   (0.9311 vs 0.9212).
4. The gain remains directionally supported under time-aware validation (0.9073 vs 0.9043).
5. Temporal features partially resolve wheat/barley representation collisions — 37 of 106.
6. `valid_px_mean` demonstrated why ablation is necessary: district-identifying information can
   artificially inflate apparent model performance.
7. Sugarcane requires a biologically appropriate crop-cycle window.
8. Onion remains an unresolved modelling/data question.
9. Wheat shows the clearest crop-specific improvement.

### What the experiment does NOT demonstrate

- It does **not** demonstrate reliable yield prediction for all 11 crops. Five of eleven remain
  negative on the fixed holdout under the vegetation-only arm.
- It does **not** justify replacing the production model.
- It does **not** justify claiming ~93% accurate yield prediction. The overall R² is dominated by
  the between-crop yield-scale gap, as section 10 shows.
- It does **not** establish field-level yield prediction. Every row is a district average.
- It does **not** establish calibrated production performance.

---

## 12. Production decision

> **Production decision: retain the existing median-composite model.**

> The temporal representation is promising and provides a strong direction for future improvement,
> but several crops remain weak, some crop windows require biological correction, and the
> experiment was completed close to submission. The production model therefore remains unchanged
> to preserve stability and reproducibility.

This is a **research result, not a failed attempt**. It produced a reusable per-date observation
pipeline, a measured answer on the wheat/barley collision, a concrete mechanism for the sugarcane
window problem, a methodological catch that will apply to every future feature set, and evidence
that the crop-dominance metric is not the target it appeared to be.

### Verified unchanged

| Artifact | Status |
|---|---|
| `ml-service/data/training_data_real.csv` | unchanged — md5 `5e99e0bd993bcf1166e531a0dc5d571a` |
| `ml-service/app/model.pkl` | unchanged — md5 `00e3da764557dca13b37e9a1fa41a732` |
| `/predict`, `/health` | unchanged |
| Crop support and caveats | unchanged |
| Frontend | unchanged |
| Database schema, migrations, RLS | unchanged |

All experimental artifacts are held in `experimental/temporal_features/`, outside the `ml-service`
tree, so the experimental model cannot be loaded in place of the production one.
