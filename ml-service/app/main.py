from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app import alerts, land, suitability
from app.db import db
from app.districts import CROPS, INDEX_FEATURES, one_hot, season_window
from app.field import no_crop

# Below this many TRAINING rows, a crop's prediction carries a thin-data
# caveat. 150 is a judgement call, not a derived threshold: it sits above the
# crops that visibly struggle in the per-crop holdout (barley 112, maize 129,
# cotton 138) and below those that hold up (wheat 204, tomato 192, potato 189).
# Row count is necessary, not sufficient -- tomato has 192 rows and still
# scores negative -- which is why per_crop_r2 is checked separately below.
MIN_ROWS_CONFIDENT = 150
from app.growth import default_sowing_date, growth_stage
from app import report
from app.train import MODEL_PATH

FEATURES = INDEX_FEATURES
_bundle = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the pickle once at startup, not per request -- unpickling a
    200-tree forest on every call would dominate the response time."""
    global _bundle
    if not MODEL_PATH.exists():
        # model.pkl is deliberately NOT committed: it is 30s of CPU away from
        # data/training_data_real.csv, which IS committed. Point at the real
        # trainer when that data exists, and only fall back to the synthetic
        # one when it does not.
        real_csv = MODEL_PATH.resolve().parents[1] / "data" / "training_data_real.csv"
        how = ("python -m scripts.train_real" if real_csv.exists()
               else "python -m app.train   (synthetic; no real dataset found)")
        raise RuntimeError(f"{MODEL_PATH} missing. Run: {how}")
    _bundle = joblib.load(MODEL_PATH)
    missing = [c for c in CROPS if c not in _bundle["trained_crops"]]
    if missing:
        print(f"WARNING: model has no training rows for {missing}; those crops will be refused.")

    # A research job runs on a daemon thread, so a restart kills it mid-flight
    # and leaves the row `running` forever -- a spinner in the portal that
    # never resolves. Mark those failed on the way up rather than retrying:
    # a half-trained model silently resuming is worse than one that visibly
    # did not finish.
    try:
        from app import research
        n = research.reap_stale()
        if n:
            print(f"research: marked {n} interrupted job(s) as failed")
    except Exception as e:  # noqa: BLE001 - never block startup on this
        print(f"research: could not reap stale jobs ({e})")

    yield


app = FastAPI(title="Smart Agriculture ML Service", lifespan=lifespan)

# The browser calls this service directly from the Vite dev server (different
# port = different origin), so without CORS every request fails at the preflight.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def current_user_id(authorization: str = Header(None)) -> str:
    """Resolve the caller's Supabase user id from their Bearer token.

    This service holds the service_role key, which bypasses RLS by design --
    that is what lets it write satellite_features and predictions. The cost is
    that Postgres can no longer answer "who is asking?", so every farm-scoped
    route has to establish identity itself. Without this, any farm UUID that
    leaks (a URL, a screenshot, a shared laptop) reads that farmer's data.

    get_user() asks Supabase Auth to validate the token rather than verifying
    the signature locally. One network hop per request, but it needs no JWT
    secret in the environment and it honours revoked sessions immediately --
    a locally-verified JWT would keep working until it expired.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "missing Authorization: Bearer <supabase access token>")

    token = authorization.split(" ", 1)[1].strip()
    try:
        res = db().auth.get_user(token)
    except Exception:
        raise HTTPException(401, "invalid or expired token")

    if not res or not res.user:
        raise HTTPException(401, "invalid or expired token")
    return res.user.id


def owned_farm(farm_id: str, user_id: str):
    """Fetch a farm, or refuse. Returns the farm row."""
    farm = (
        db().table("farms")
        .select("id, owner_id, farmer_name, district, crop_type, season, gps_lat, gps_lng, planting_date, water_source, salinity_flag, last_crop, area_hectares, harvest_confirmed, actual_harvest_date")
        .eq("id", farm_id)
        .execute()
    )
    if not farm.data:
        raise HTTPException(404, f"no farm {farm_id}")
    if farm.data[0]["owner_id"] != user_id:
        # 403, not 404: the spec asks for it, and hiding existence behind a 404
        # would not help anyway -- the caller already holds the UUID.
        raise HTTPException(403, "this farm belongs to another account")
    return farm.data[0]


class Features(BaseModel):
    ndvi: float = Field(ge=-1, le=1)
    evi: float = Field(ge=-1, le=1)
    ndwi: float = Field(ge=-1, le=1)
    savi: float = Field(ge=-1, le=1)
    nbr: float = Field(ge=-1, le=1)
    crop_type: str = "wheat"


class Prediction(BaseModel):
    predicted_yield: float
    confidence_interval: list[float]
    unit: str = "t/ha"
    model_used: str
    crop_type: str
    # Honesty surface. Computed from the actual state of the data, never
    # hardcoded, so every one of these clears itself the moment real training
    # rows and PBS yields land -- no code change needed for the swap.
    model_status: str = "preliminary"   # 'preliminary' | 'validated'
    caveats: list[str] = []
    # Context. All three are None when the data does not exist yet, and all
    # three are derived from district_yields rows, so they populate themselves.
    district_average: float | None = None
    vs_district_pct: float | None = None       # + = above district average
    trend: list[dict] | None = None            # [{season, yield_t_ha}, ...]
    trend_pct: float | None = None             # latest vs previous season
    growth: dict | None = None                 # phenological stage, see app/growth.py
    alerts: list[dict] = []                    # open alerts, see app/alerts.py
    # Populated only by /farms/{id}/predict -- the dashboard shows the actual
    # Sentinel-2 values behind the number instead of asking you to trust it.
    features: dict | None = None
    feature_date: str | None = None


def model_extras(farm_row: dict) -> dict:
    """Soil and season weather for the wider model, or {} for the base one.

    Skipped entirely when the loaded bundle asks for nothing beyond indices
    and crop, so the base model costs no extra work and, more to the point, no
    Open-Meteo round trip per prediction.

    Never raises. A missing value is left out and build_vector refuses on it
    there, with a message naming the feature -- which is a far better failure
    than a soil lookup taking down a prediction the base model could have
    served from indices alone.
    """
    wanted = set(_bundle["feature_names"])
    if not wanted - set(INDEX_FEATURES) - {f"crop_{c}" for c in CROPS}:
        return {}

    out = {}
    try:
        out.update(land_profile_for(farm_row)["soil"])
    except Exception as e:
        print(f"[predict] soil unavailable for farm {farm_row.get('id')}: {e}")

    try:
        from app.weather import season_weather

        season = current_season(farm_row["crop_type"])
        start, end = season_window(farm_row["crop_type"], season)
        wx = season_weather(farm_row["gps_lat"], farm_row["gps_lng"], start, end)
        if not wx["complete"]:
            # Cumulative features (rain_mm, hot_days_35c) scale with elapsed
            # days, so a half-run season reads as a dry, mild one. The model
            # was trained on finished seasons and cannot know the difference.
            print(f"[predict] season {season} is {wx['days_covered']}/"
                  f"{wx['days_in_window']} days in; weather features are partial")
        out.update(wx)
    except Exception as e:
        print(f"[predict] season weather unavailable for farm {farm_row.get('id')}: {e}")

    return out


def current_season(crop: str, today: date | None = None) -> str:
    """The crop-year label ('2025-26') whose window the farm is in or nearest.

    Anchored to the crop's own sowing month, not to January: a rabi crop sown
    in November 2025 belongs to season 2025-26 for its whole life, including
    the months of 2026 when it is actually growing.
    """
    from app.crops import SOW_WINDOW

    today = today or date.today()
    (sm, _sd), _ = SOW_WINDOW[crop]
    y = today.year if today.month >= sm else today.year - 1
    return f"{y}-{str(y + 1)[2:]}"


def build_vector(f: Features, extra: dict | None = None) -> list[float]:
    """Assemble the model's input row BY NAME, from the bundle's own schema.

    The bundle records feature_names, so this reads them rather than
    hardcoding a layout. That is what lets one code path serve both the
    7-feature base model and the 19-feature soil+weather one: promoting a
    wider model becomes a file swap, with no matching edit needed here.

    Building positionally instead would be the silent-failure route. A forest
    handed 19 numbers in the wrong order does not raise -- it returns a
    confident wrong yield, and nothing downstream can tell.
    """
    extra = extra or {}
    oh = dict(zip([f"crop_{c}" for c in CROPS], one_hot(f.crop_type)))
    row = []
    for name in _bundle["feature_names"]:
        if name in oh:
            row.append(oh[name])
        elif hasattr(f, name):
            row.append(getattr(f, name))
        elif name in extra and extra[name] is not None:
            row.append(float(extra[name]))
        else:
            # Refuse rather than substitute. A zero for ph or rain_mm is not a
            # neutral value -- it is a specific, impossible soil, and the
            # forest would answer for that soil without complaint.
            raise HTTPException(
                503,
                f"model needs feature {name!r} and it is not available for this "
                f"farm. Model expects {_bundle['feature_names']}.",
            )
    return row


def predict(f: Features, extra: dict | None = None) -> Prediction:
    """Shared by POST /predict and GET /farms/{id}/predict.

    `extra` carries soil and season-weather values for models trained with
    them; the base model ignores it, because build_vector only asks for what
    the loaded bundle actually declares.
    """
    if f.crop_type not in CROPS:
        raise HTTPException(400, f"unknown crop {f.crop_type!r}; expected one of {list(CROPS)}")

    # The guard that makes the crop dimension honest. A Random Forest given an
    # unseen one-hot column does not fail -- it falls back to whatever leaf is
    # nearest, which here means returning a wheat yield for rice. Refusing is
    # the only way the caller finds out the model has never seen this crop.
    if f.crop_type not in _bundle["trained_crops"]:
        raise HTTPException(
            422,
            f"model has no training rows for {f.crop_type!r} (trained on: "
            f"{_bundle['trained_crops']}). Add {f.crop_type} seasons to "
            f"data/training.csv with PBS yields and re-run python -m app.train.",
        )

    x = np.array([build_vector(f, extra)])

    # Spread across the trees as the interval. ponytail: this is model
    # disagreement, not a calibrated prediction interval -- it ignores the
    # irreducible field-level noise, so it reads narrow. Swap for quantile
    # regression forests once real yield data exists.
    votes = np.array([t.predict(x)[0] for t in _bundle["model"].estimators_])

    return Prediction(
        predicted_yield=round(float(votes.mean()), 2),
        confidence_interval=[
            round(float(np.percentile(votes, 10)), 2),
            round(float(np.percentile(votes, 90)), 2),
        ],
        model_used=_bundle["model_name"],
        crop_type=f.crop_type,
    )


# REMOVED: borrow_district_features().
#
# It copied a same-district farm's latest indices onto a farm that had none.
# That was defensible only while indices were DISTRICT-level -- fetch_indices
# reduced a district bounding box, so every farm in a district genuinely did
# share one value and copying invented nothing.
#
# app/field.py ended that. Indices are now reduced over a circle sized from
# the farm's own area_hectares, so two farms in one district legitimately
# differ, and copying would hand one farm another's readings while labelling
# them as its own. A confident wrong number is worse than no number, so the
# 404 below is now the only answer when a farm has no imagery of its own.


def district_yield_rows(district: str, crop_type: str):
    """Ground-truth yields for a district+crop, oldest season first.

    Empty today. Every consumer below is written against this shape, so when
    the PBS rows land the comparisons start working with no code change --
    which is the whole requirement for the model swap.
    """
    res = (
        db().table("district_yields")
        .select("season, yield_t_ha, source")
        .eq("district", district)
        .eq("crop_type", crop_type)
        .order("season")
        .execute()
    )
    return res.data or []


def assess(district: str, crop_type: str, yield_rows: list) -> tuple[str, list[str]]:
    """Returns (model_status, caveats) from the real state of the data.

    Three independent reasons a number here is not yet trustworthy, each
    checked against something observable rather than a flag someone has to
    remember to flip.
    """
    caveats = []

    # 1. The model itself. train.py records where its rows came from.
    # ASCII punctuation only: these strings are rendered into a PDF by
    # fpdf2's core fonts, which are latin-1 and raise on an em dash.
    # Anything not explicitly synthetic counts as real. Matching on the
    # positive case rather than "!= one known filename" means a new training
    # source (real:training_data_real.csv) is recognised without editing this.
    synthetic = str(_bundle.get("source", "")).startswith("synthetic")
    if synthetic:
        caveats.append(
            "Model trained on synthetic data - every prediction here is illustrative, not validated."
        )

    # 2. The crop, scaled to the evidence actually behind it.
    #
    # Was `if crop_type == "rice"`, hardcoded. That was blind to row counts and
    # by the 11-crop retrain it had gone backwards: rice has 186 training rows
    # while barley has 112, so the single crop flagged as thin was among the
    # better-supported ones. The bundle now carries crop_rows, so this reads
    # the model instead of a guess and cannot go stale across a retrain.
    n = (_bundle.get("crop_rows") or {}).get(crop_type)
    if n is None:
        caveats.append(
            f"Row count for {crop_type} is not recorded in this model - treat its "
            f"accuracy as unverified."
        )
    elif n < MIN_ROWS_CONFIDENT:
        best = max((_bundle.get("crop_rows") or {}).items(), key=lambda kv: kv[1],
                   default=(None, 0))
        caveats.append(
            f"Limited training data - {n} rows for {crop_type}, against "
            f"{best[1]} for {best[0]}. Predictions are less reliable."
        )

    # 2b. Accuracy is per crop, and pooling hides that. A model scoring well
    #     across all crops can still be worse than useless on one of them --
    #     see per_crop_r2 in the bundle, written by scripts.train_real.
    r2 = (_bundle.get("per_crop_r2") or {}).get(crop_type)
    if r2 is not None and r2 < 0:
        caveats.append(
            f"This model does not predict {crop_type} yield: on held-out seasons it "
            f"scores worse (R2 {r2:.2f}) than simply using the {crop_type} average. "
            f"Treat the number as indicative only."
        )

    # 3. The district. Distinguish "no figures at all" from "figures, but
    #    placeholder ones" -- saying comparisons are unavailable while showing
    #    a comparison is worse than saying nothing.
    validated_rows = [r for r in yield_rows if r.get("source") == "PBS"]
    if not yield_rows:
        caveats.append(
            f"No {crop_type} yield records for {district} yet - "
            f"district comparison and trend are unavailable."
        )
    elif not validated_rows:
        caveats.append(
            f"District comparison for {district} uses placeholder figures, not PBS survey data."
        )

    status = "validated" if (not synthetic and validated_rows) else "preliminary"
    return status, caveats


def add_context(result: Prediction, yield_rows: list) -> None:
    """Attach district average, relative position, and year-over-year trend.

    Every field stays None when the underlying rows are absent -- the UI hides
    what is None rather than rendering a zero, because a zero would read as
    "the district average is 0 t/ha" rather than "we do not know it".
    """
    if not yield_rows:
        return

    values = [r["yield_t_ha"] for r in yield_rows]
    avg = sum(values) / len(values)
    result.district_average = round(avg, 2)
    if avg:
        result.vs_district_pct = round((result.predicted_yield - avg) / avg * 100, 1)

    # Trend needs at least two seasons; one season is a point, not a trend.
    if len(yield_rows) >= 2:
        result.trend = [
            {"season": r["season"], "yield_t_ha": r["yield_t_ha"]} for r in yield_rows
        ]
        prev, latest = values[-2], values[-1]
        if prev:
            result.trend_pct = round((latest - prev) / prev * 100, 1)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": _bundle["model_name"] if _bundle else None,
        "trained_crops": _bundle["trained_crops"] if _bundle else [],
        "training_source": _bundle["source"] if _bundle else None,
        "training_rows": _bundle["n_rows"] if _bundle else 0,
        # Present once trained on real data; lets you confirm a model swap took
        # effect without unpickling anything.
        "metrics": _bundle.get("metrics") if _bundle else None,
    }


@app.post("/predict", response_model=Prediction)
def predict_endpoint(f: Features):
    return predict(f)


@app.get("/farms/{farm_id}/predict", response_model=Prediction)
def predict_for_farm(farm_id: str, user_id: str = Depends(current_user_id)):
    """Latest satellite_features for the farm -> model -> predictions row.

    This is the endpoint the dashboard calls. It runs on the service_role key,
    so it can read any farm and write predictions, which no farmer may write
    directly (see the migration). Ownership is therefore enforced here, in
    owned_farm(), because RLS cannot see this caller.
    """
    farm_row = owned_farm(farm_id, user_id)

    # IN-SEASON, then most recent -- not most recent outright.
    #
    # This used to be a bare `.order("date", desc=True).limit(1)`, which is the
    # newest stored observation whatever it shows. /farms/{id}/timeseries
    # fetches from two weeks before sowing to 45 days past expected harvest, so
    # after a full-season fetch the newest row is POST-HARVEST BARE SOIL. The
    # smoke test caught one: 3.85 t/ha predicted from a 2026-05-26 observation
    # at ndvi 0.1127, months after a rabi wheat crop was off the field. The
    # model reads that as a failed crop and cannot tell it from one.
    #
    # The crop's own observation window is the filter, so a kharif farm is not
    # judged on rabi imagery and vice versa. Pre-season rows are excluded for
    # the same reason as post-season ones: bare soil before sowing and bare
    # soil after harvest are the same picture, and neither is the crop.
    season = current_season(farm_row["crop_type"])
    win_start, win_end = season_window(farm_row["crop_type"], season)

    q = (
        db().table("satellite_features")
        .select("ndvi, evi, ndwi, savi, nbr, date")
        .eq("farm_id", farm_id)
        .gte("date", win_start)
        .lte("date", win_end)
    )
    # Skip rows missing any index. A scene fully masked out over this field is
    # stored with nulls, which is an absence of observation rather than an
    # observation of nothing -- and taking the newest row regardless then hits
    # the 422 below while a perfectly good observation sits one row down.
    for k in INDEX_FEATURES:
        q = q.not_.is_(k, "null")
    # No .limit(1): the SELECTION is unchanged -- still the newest in-season
    # row -- but the whole in-season series is needed a few lines down for the
    # no-crop check, and one query serving both beats a second round trip.
    feats = q.order("date", desc=True).execute()

    # THEN: on or after the farmer's own sowing date.
    #
    # The window above is the TRAINING CONTRACT -- the calendar range the
    # model's features were built from. It says nothing about whether a crop
    # existed. planting_date is the farmer's claim about reality, and an
    # observation taken before they sowed is, by definition, not their crop.
    #
    # For a normally sown field the whole in-window series already follows
    # sowing and this changes nothing; it was checked across every farm
    # holding imagery and only the conflicting one moved. It matters when the
    # two disagree: a wheat farm sown 2026-06-15 had all 25 of its in-window
    # observations sitting BEFORE that date, and /predict answered 2.68 t/ha
    # from 2026-03-15 -- ninety-two days before the crop went in, describing
    # the previous rabi cycle on that land. A confident number about the wrong
    # crop cycle is worse than a refusal, because it looks like an answer.
    sown_on = farm_row.get("planting_date")
    in_window = feats.data or []
    usable = [r for r in in_window if r["date"] >= sown_on] if sown_on else in_window

    # This farm's OWN rows, or nothing. No borrowing from a neighbour: since
    # app/field.py the indices describe this field's geometry specifically,
    # so another farm's values would be mislabelled rather than approximate.
    row = usable[0] if usable else None
    if not row and in_window and sown_on:
        # Imagery exists inside the model's window, but every frame of it
        # predates sowing. Refusing is the only honest answer: there is no
        # picture of this crop cycle to predict from, and inventing one by
        # reaching backwards is exactly the bug this replaces.
        raise HTTPException(
            422,
            f"No imagery of this crop cycle. The sowing date entered for this "
            f"farm is {sown_on}, but the model's {farm_row['crop_type']} "
            f"observation window for {season} runs {win_start} to {win_end}, "
            f"and all {len(in_window)} observation(s) inside that window were "
            f"taken before {sown_on} -- they show the land before this crop "
            f"was sown, not the crop. No yield can be predicted for a "
            f"{farm_row['crop_type']} crop sown on {sown_on}. If that sowing "
            f"date was entered incorrectly, correct it on the farm and try "
            f"again.",
        )
    if not row:
        # Distinguish "nothing fetched" from "fetched, but none of it is from
        # this crop's season". They need different actions from the caller, and
        # one message for both sends farmers to re-fetch imagery they already
        # have. The extra query runs only on this path.
        any_row = (
            db().table("satellite_features")
            .select("date")
            .eq("farm_id", farm_id)
            .order("date", desc=True)
            .limit(1)
            .execute()
        )
        if any_row.data:
            raise HTTPException(
                404,
                f"No imagery inside the {farm_row['crop_type']} {season} "
                f"observation window ({win_start} to {win_end}). The newest "
                f"observation stored for this farm is {any_row.data[0]['date']}, "
                f"which is outside it -- bare ground before sowing or after "
                f"harvest, not the crop. Predicting from it would report a "
                f"failed crop. Fetch the season with: GET /farms/{farm_id}"
                f"/timeseries?refresh=true",
            )
        raise HTTPException(
            404,
            f"No satellite imagery has been fetched for this farm yet. "
            f"Fetch it with: GET /farms/{farm_id}/timeseries?refresh=true "
            f"(about 3-7s), then retry this prediction. Imagery from other "
            f"farms in {farm_row['district']} is deliberately not reused -- "
            f"it describes their fields, not yours.",
        )
    if any(row[k] is None for k in INDEX_FEATURES):
        raise HTTPException(422, f"incomplete indices for {row['date']}: {row}")

    # Did anything actually grow here this season? The forest cannot tell: it
    # reads the crop label far more strongly than the indices, so a built-up
    # plot registered as wheat comes back near the wheat mean. See app.field
    # for the thresholds and the measurements behind them.
    flat = no_crop([r["ndvi"] for r in usable])
    if flat:
        raise HTTPException(
            422,
            f"No active crop vegetation detected in the available in-season "
            f"satellite imagery. Refresh imagery or verify the field location. "
            f"Across {flat['observations']} observations in the "
            f"{farm_row['crop_type']} {season} window ({win_start} to "
            f"{win_end}) NDVI peaked at {flat['ndvi_peak']} and varied by only "
            f"{flat['ndvi_amplitude']} (median {flat['ndvi_median']}); a "
            f"growing field reaches roughly 0.6-0.9 at peak. No yield is "
            f"reported, because the model would answer from the crop name "
            f"rather than from this imagery.",
        )

    result = predict(
        Features(crop_type=farm_row["crop_type"], **{k: row[k] for k in INDEX_FEATURES}),
        extra=model_extras(farm_row),
    )
    result.features = {k: row[k] for k in INDEX_FEATURES}
    result.feature_date = row["date"]

    yield_rows = district_yield_rows(farm_row["district"], farm_row["crop_type"])
    result.model_status, result.caveats = assess(
        farm_row["district"], farm_row["crop_type"], yield_rows
    )
    add_context(result, yield_rows)

    pd_raw = farm_row.get("planting_date")
    result.growth = growth_stage(
        farm_row["crop_type"], date.fromisoformat(pd_raw) if pd_raw else None
    )

    # Alerts are evaluated here because this is the moment both inputs exist:
    # fresh indices and a fresh prediction. sync() dedupes and auto-resolves.
    try:
        result.alerts = alerts.sync(farm_row, alerts.evaluate(farm_row, result, result.features))
    except Exception as e:
        # A broken alert rule must not take down the prediction the farmer
        # actually asked for.
        print(f"[alerts] evaluation failed for farm {farm_id}: {e}")
        result.alerts = []

    lo, hi = result.confidence_interval
    db().table("predictions").insert({
        "farm_id": farm_id,
        "predicted_yield": result.predicted_yield,
        "confidence_interval": f"[{lo},{hi}]",   # Postgres numrange literal
        "model_used": result.model_used,
    }).execute()

    return result


# --------------------------------------------------------------- land + suitability
#
# Soil and climate columns as stored, so the mapping between the profile dict
# and the table lives in ONE place rather than being spelled out twice.
_SOIL_COLS = {"ph": "ph", "clay_pct": "clay_pct", "silt_pct": "silt_pct",
              "sand_pct": "sand_pct", "texture_class": "texture_class",
              "texture": "texture", "bulk_dens": "bulk_density",
              "water_33k": "water_33kpa", "soc_raw": "soc_raw"}
_CLIM_COLS = {"tmax_mean_c": "tmax_mean_c", "tmin_mean_c": "tmin_mean_c",
              "tmax_hottest_c": "tmax_hottest_c", "tmin_coldest_c": "tmin_coldest_c",
              "annual_rain_mm": "annual_rain_mm",
              "frost_days_per_year": "frost_days_per_year",
              "years_used": "climate_years_used", "monthly": "monthly"}


def land_profile_for(farm_row: dict) -> dict:
    """This farm's land profile, built on first request and cached thereafter.

    Lazy rather than eager: building it costs an Earth Engine call and ten
    Open-Meteo calls, which is far too slow to sit inside farm registration.
    The farmer registers instantly; the profile appears the first time anything
    actually needs it.
    """
    cached = (
        db().table("land_profiles").select("*").eq("farm_id", farm_row["id"]).execute()
    ).data
    if cached:
        row = cached[0]
        soil = {k: row.get(col) for k, col in _SOIL_COLS.items()}
        clim = {k: row.get(col) for k, col in _CLIM_COLS.items()}
        # jsonb keys come back as strings; window_climate indexes by int month
        clim["monthly"] = {int(m): v for m, v in (clim.get("monthly") or {}).items()}
    else:
        built = land.build_profile(farm_row["gps_lat"], farm_row["gps_lng"])
        soil, clim = built["soil"], built["climate"]
        payload = {"farm_id": farm_row["id"]}
        payload.update({col: soil.get(k) for k, col in _SOIL_COLS.items()})
        payload.update({col: clim.get(k) for k, col in _CLIM_COLS.items()})
        db().table("land_profiles").upsert(payload, on_conflict="farm_id").execute()

    return {
        "soil": soil,
        "climate": clim,
        "water_source": farm_row.get("water_source"),
        "salinity_flag": farm_row.get("salinity_flag"),
        "last_crop": farm_row.get("last_crop"),
    }


@app.get("/farms/{farm_id}/suitability")
def farm_suitability(farm_id: str, user_id: str = Depends(current_user_id)):
    """What this farm's land is suited to grow, best first.

    Same ownership gate as every other farm route.
    """
    farm_row = owned_farm(farm_id, user_id)
    try:
        profile = land_profile_for(farm_row)
    except LookupError as e:
        raise HTTPException(503, f"land data unavailable for this location: {e}")

    results = suitability.assess(profile, district=farm_row["district"])
    soil = profile["soil"]
    return {
        "farm_id": farm_id,
        "district": farm_row["district"],
        "current_crop": farm_row["crop_type"],
        "last_crop": farm_row.get("last_crop"),
        "land": {
            "texture": soil.get("texture"),
            "ph": soil.get("ph"),
            "sand_pct": soil.get("sand_pct"),
            "clay_pct": soil.get("clay_pct"),
            "water_33k": soil.get("water_33k"),
            "annual_rain_mm": profile["climate"].get("annual_rain_mm"),
            "water_source": profile.get("water_source"),
            "salinity_flag": profile.get("salinity_flag"),
        },
        # Honest by construction: every threshold that produced these classes
        # is marked in crops.csv, and anything still `seed` says so here.
        "thresholds_unverified": sorted(
            {r["crop"] for r in results if r["thresholds_status"] == "seed"}
        ),
        "results": results,
    }


@app.get("/farms/{farm_id}/report")
def farm_report(farm_id: str, user_id: str = Depends(current_user_id)):
    """One-page PDF for this farm. Same ownership gate as the prediction.

    Reuses predict_for_farm rather than duplicating the assembly, so the PDF can
    never drift from what the dashboard shows. Side effect: it writes another
    predictions row, which is acceptable -- that table is an audit log of
    predictions made, and generating a report is one.
    """
    farm_row = owned_farm(farm_id, user_id)
    pred = predict_for_farm(farm_id, user_id)

    pdf = report.build(farm_row, pred.model_dump())
    safe = "".join(c if c.isalnum() else "-" for c in farm_row["farmer_name"])[:40]
    filename = f"{date.today().isoformat()}-{safe}-yield-report.pdf"

    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/farms")
def list_farms(user_id: str = Depends(current_user_id)):
    """Every farm belonging to the caller, newest first.

    The frontend reads farms straight from Supabase under RLS and does not need
    this; it exists so the service's own routes have one consistent notion of
    "the caller's farms", and for scripts running under service_role.
    """
    res = (
        db().table("farms")
        .select("*")
        .eq("owner_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return res.data


# --------------------------------------------------------------- lifecycle
# Field-level monitoring. Separate from the yield routes above on purpose:
# these read a TIME SERIES over one field, while yield prediction reads one
# composite over a district. They share nothing but the ownership gate.

def _field_window(farm_row, start=None, end=None):
    """Resolve the fetch window, defaulting to this field's current season.

    TWO WINDOWS EXIST AND THEY CAN DISAGREE. season_bounds follows the FARMER:
    it brackets the date they entered, which is what the growth curve and the
    harvest detector need. season_window follows the CALENDAR: a fixed
    per-crop range that /predict uses because it is the range the model was
    trained on, and it ignores planting_date entirely.

    For a normally-sown field the two overlap and this changes nothing. For a
    field whose sowing date falls outside its crop's conventional season they
    can be completely disjoint -- a wheat farm sown 2026-06-15 fetches
    2026-06-01..2026-09-29 while /predict looks in 2025-12-01..2026-03-15 --
    and then the fetch can never produce a row /predict will accept. Clicking
    "Fetch satellite imagery" re-fetched the same 50 unusable observations and
    returned the same 404 every time, while the UI promised it would help.

    So when they are disjoint, fetch the UNION: the farmer's window for the
    lifecycle features, the calendar window so a prediction is possible, and
    nothing in between is wasted because it is one Earth Engine call either
    way. The end is still capped at today -- asking for the future returns an
    empty collection that looks exactly like a data gap.

    season_window itself is untouched. This widens what is FETCHED, never what
    the model is given.
    """
    from app.field import season_bounds

    sown = (date.fromisoformat(farm_row["planting_date"])
            if farm_row.get("planting_date")
            else default_sowing_date(farm_row["crop_type"], date.today()))
    if start and end:
        return sown, start, end

    crop = farm_row["crop_type"]
    a, b = season_bounds(crop, sown)
    w0, w1 = season_window(crop, current_season(crop))
    if b < w0 or a > w1:
        today = date.today().isoformat()
        a, b = min(a, w0), min(max(b, w1), today)
    return sown, start or a, end or b


def _stored_series(farm_id):
    """Everything already in satellite_features for this farm, oldest first."""
    res = (
        db().table("satellite_features")
        .select("date, ndvi, evi, ndwi, savi, nbr, vv, vh, cloud_pct, valid_px, source")
        .eq("farm_id", farm_id)
        .order("date")
        .execute()
    )
    return res.data or []


@app.get("/farms/{farm_id}/timeseries")
def farm_timeseries(farm_id: str, start: str = None, end: str = None,
                    refresh: bool = False, user_id: str = Depends(current_user_id)):
    """Field-level satellite time series for the growth curve.

    Serves what is stored unless `refresh=true`. The fetch is 30-60s of Earth
    Engine, which is far too slow to sit in front of a dashboard load, so
    going to GEE is opt-in rather than the default -- exactly the mistake the
    district pipeline avoids by fetching in a script.

    Rows are ordered by date and every row carries every key, with null where
    that sensor did not observe that date.
    """
    farm_row = owned_farm(farm_id, user_id)

    if refresh:
        from app.field import field_series
        from app.gee import NoImagery

        from app.field import InvalidSowingDate

        try:
            sown, a, b = _field_window(farm_row, start, end)
        except InvalidSowingDate as e:
            # The farmer's input, not an outage: 422, and say which date.
            raise HTTPException(422, str(e))
        try:
            rows = field_series(farm_row["gps_lat"], farm_row["gps_lng"],
                                farm_row.get("area_hectares"), a, b)
        except NoImagery as e:
            raise HTTPException(404, str(e))
        except Exception as e:                       # noqa: BLE001
            # A GEE outage must not take down a route that can still serve
            # what is already stored.
            print(f"[timeseries] refresh failed for {farm_id[:8]}: {e}")
            raise HTTPException(503, f"Earth Engine unavailable: {e}")
        _store_series(farm_id, rows)

    series = _stored_series(farm_id)
    return {
        "farm_id": farm_id,
        "crop_type": farm_row["crop_type"],
        "area_hectares": farm_row.get("area_hectares"),
        # Say so rather than letting a 1 ha default pass as a measurement.
        "area_assumed": farm_row.get("area_hectares") is None,
        "count": len(series),
        "series": series,
    }


def _store_series(farm_id, rows):
    """Upsert a field series into satellite_features on (farm_id, date)."""
    if not rows:
        return
    cols = ("ndvi", "evi", "ndwi", "savi", "nbr", "vv", "vh", "cloud_pct", "valid_px")
    payload = [
        {"farm_id": farm_id, "date": r["date"],
         **{k: r.get(k) for k in cols},
         "source": "+".join(sorted(set(r.get("sources") or []))) or None}
        for r in rows
    ]
    db().table("satellite_features").upsert(payload, on_conflict="farm_id,date").execute()


@app.get("/farms/{farm_id}/harvest")
def farm_harvest(farm_id: str, refresh: bool = False,
                 user_id: str = Depends(current_user_id)):
    """Has this field been harvested? Rule-based, and not yet validated.

    `confidence` is a weighted count of corroborating evidence, NOT a
    calibrated probability -- see app/harvest.py. Nothing here has been
    scored against real harvest dates yet.
    """
    from app.harvest import detect

    farm_row = owned_farm(farm_id, user_id)
    if refresh:
        farm_timeseries(farm_id, refresh=True, user_id=user_id)

    sown, _, _ = _field_window(farm_row)
    result = detect(
        _stored_series(farm_id),
        farm_row["crop_type"],
        sown,
        confirmed_date=(farm_row.get("actual_harvest_date")
                        if farm_row.get("harvest_confirmed") else None),
    )
    result["crop_type"] = farm_row["crop_type"]
    result["sowing_date"] = sown.isoformat()
    result["sowing_date_estimated"] = not farm_row.get("planting_date")
    return result


class HarvestConfirm(BaseModel):
    harvested: bool = True
    actual_harvest_date: date | None = None


@app.post("/farms/{farm_id}/harvest/confirm")
def confirm_harvest(farm_id: str, body: HarvestConfirm,
                    user_id: str = Depends(current_user_id)):
    """Record what the farmer actually did. This is ground truth.

    Every confirmation collected here is one row of the validation set that
    scripts/validate_harvest.py scores the detector against -- which is the
    only thing that will ever turn `confidence` into a measured number.
    """
    owned_farm(farm_id, user_id)

    if body.harvested and not body.actual_harvest_date:
        # Also a CHECK in the migration; refused here so the caller gets a
        # readable message rather than a Postgres constraint violation.
        raise HTTPException(422, "actual_harvest_date is required when harvested is true")
    if body.actual_harvest_date and body.actual_harvest_date > date.today():
        raise HTTPException(422, "actual_harvest_date cannot be in the future")

    patch = {
        "harvest_confirmed": body.harvested,
        "actual_harvest_date": (body.actual_harvest_date.isoformat()
                                if body.harvested and body.actual_harvest_date else None),
    }
    db().table("farms").update(patch).eq("id", farm_id).execute()
    return {"farm_id": farm_id, **patch}


@app.get("/farms/{farm_id}/lifecycle")
def farm_lifecycle(farm_id: str, refresh: bool = False,
                   user_id: str = Depends(current_user_id)):
    """Where this field is in its cycle, read from the curve.

    Lifecycle stages 3, 6 and 7: the observed growth phase (and whether it
    agrees with the crop calendar), whether the ground is fallow, and whether
    a new crop has emerged since the last clearance.

    Separate from /harvest on purpose. That endpoint answers "was this field
    harvested, and when"; this one answers "what is it doing now". They read
    the same stored series and neither refetches for the other.
    """
    from app.lifecycle import field_state

    farm_row = owned_farm(farm_id, user_id)
    if refresh:
        farm_timeseries(farm_id, refresh=True, user_id=user_id)

    sown, _, _ = _field_window(farm_row)
    state = field_state(_stored_series(farm_id), farm_row["crop_type"], sown)
    state["crop_type"] = farm_row["crop_type"]
    state["sowing_date"] = sown.isoformat()
    state["sowing_date_estimated"] = not farm_row.get("planting_date")
    return state


# ===========================================================================
# RESEARCHER PORTAL
#
# Two endpoints, and deliberately only two. Everything else the portal needs is
# a plain table read or write it does straight against Postgres through
# PostgREST, exactly as the farmer and government portals do -- so there is no
# CRUD API here that nobody needed.
#
# WHERE AUTHORISATION LIVES, which differs between the two:
#
#   /research/runs/{id}/start   the model_runs INSERT policies already decided
#                               whether this account may run or train. A queued
#                               row that exists is one somebody was allowed to
#                               create, so this only checks WHO may start it.
#
#   /research/datasets          the file has to reach this service's filesystem,
#                               so the row is written with the service_role key
#                               -- which BYPASSES RLS. The can_train_models
#                               check therefore has to happen here in Python.
#                               This is the one place in the portal where a
#                               permission is enforced outside a policy, and it
#                               is enforced because of that bypass, not instead
#                               of a policy.
# ===========================================================================


def _research_profile(user_id: str) -> dict:
    """The caller's research_profiles row, or refuse.

    Mirrors public.research_is_super_admin(): a government super admin is a
    research super admin without a row here, which is the shared tier the brief
    asks for. Kept in sync with that function by hand -- if one changes the
    other has to, and the RLS verification script asserts they agree.
    """
    rows = (db().table("research_profiles")
            .select("id, tier, can_run_models, can_train_models, status")
            .eq("id", user_id).execute().data or [])
    me = rows[0] if rows else None

    if not me or me["status"] != "active":
        gov = (db().table("gov_profiles").select("tier, status")
               .eq("id", user_id).execute().data or [])
        if gov and gov[0]["status"] == "active" and gov[0]["tier"] == "super_admin":
            return {"id": user_id, "tier": "super_admin",
                    "can_run_models": True, "can_train_models": True,
                    "status": "active", "mirrored_from": "gov_profiles"}

    if not me:
        raise HTTPException(403, "no researcher portal account for this user")
    if me["status"] != "active":
        raise HTTPException(403, "this researcher account is deactivated")
    return me


@app.post("/research/datasets")
def upload_dataset(
    file: UploadFile = File(...),
    description: str = Form(...),
    user_id: str = Depends(current_user_id),
):
    """Validate and register an uploaded temporal dataset.

    Requires can_train_models: the brief folds upload into Action B rather than
    gating it separately, so an account that may run models but not train them
    can select an existing dataset_version and cannot add one.

    A MALFORMED FILE IS REJECTED WITH A REASON AND NOTHING IS SAVED -- no row,
    no file on disk. The brief asks for "a clear UI error, never a silent
    failure or crash", and a half-registered dataset that later fails at
    training time is exactly the silent failure it is warning about.
    """
    from app import research

    me = _research_profile(user_id)
    if not me["can_train_models"]:
        raise HTTPException(
            403, "uploading a dataset requires can_train_models, which this account "
                 "does not have. A research lead can grant it on the Access screen."
        )

    description = (description or "").strip()
    if not description:
        raise HTTPException(422, "a description is required: it is how this snapshot "
                                 "is identified on every screen that cites it")
    # Bounded because it is rendered in every picker, table and run report. An
    # unbounded Form field would otherwise put an arbitrarily long string into
    # a <select> option on five screens.
    if len(description) > 300:
        raise HTTPException(422, "the description must be 300 characters or fewer "
                                 f"(got {len(description)})")

    # READ IN BOUNDED CHUNKS, NOT ALL AT ONCE. The size check used to run after
    # file.file.read(), which means a 2 GB upload was fully materialised in
    # memory before being told it was too big -- the check announced the limit
    # without enforcing it. Stopping one chunk past the cap bounds the memory a
    # single request can cost, whatever Content-Length claimed.
    LIMIT = 32 * 1024 * 1024
    chunks, size = [], 0
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > LIMIT:
            raise HTTPException(413, "dataset is larger than 32 MB")
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw:
        raise HTTPException(422, "the uploaded file is empty")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(422, "file is not UTF-8 text; a CSV export is expected")

    try:
        count, notes = research.validate_csv(text)
    except research.DatasetInvalid as e:
        # 422 with the validator's own message. Nothing is written: the file is
        # not saved and no dataset_versions row is created.
        raise HTTPException(422, str(e))

    stem = "".join(c if c.isalnum() or c in "-_" else "_"
                   for c in Path(file.filename or "upload").stem)[:40] or "upload"
    name = f"{datetime.now(timezone.utc):%Y%m%dT%H%M%S}_{stem}.csv"
    dest = research.DATA_DIR / name
    dest.write_text(text, encoding="utf-8")

    row = (db().table("dataset_versions").insert({
        "description": description.strip(),
        # Relative, so the row survives the service moving to another host.
        "storage_path": f"research/{name}",
        "record_count": count,
        "schema_validated": True,
        "validation_notes": "; ".join(notes),
        "uploaded_by": user_id,
    }).execute().data[0])

    return {"dataset_version": row, "record_count": count, "notes": notes}


class StartRun(BaseModel):
    """Nothing in the body. The run row already carries every parameter -- the
    portal wrote them under RLS -- and accepting them again here would create a
    second, unpoliced way to set them."""


@app.post("/research/runs/{run_id}/start")
def start_run(run_id: str, user_id: str = Depends(current_user_id)):
    """Accept a queued run and execute it on a daemon thread.

    Returns as soon as the job is accepted. The portal polls model_runs.
    job_status and model_run_logs for progress -- there is no queue or realtime
    channel in this project and this endpoint does not add one.

    The run's PERMISSION was settled by the insert policy that let the row be
    created. What is checked here is only who may press start on it: the person
    who queued it, or a lead/super admin. Without that, any account could start
    another researcher's queued job and the attribution in `triggered_by` would
    no longer match who caused the work.
    """
    from app import research

    me = _research_profile(user_id)

    rows = (db().table("model_runs").select("id, triggered_by, job_status, run_kind")
            .eq("id", run_id).execute().data or [])
    if not rows:
        raise HTTPException(404, f"no model run {run_id}")
    run = rows[0]

    is_lead = me["tier"] in ("research_lead", "super_admin")
    if run["triggered_by"] != user_id and not is_lead:
        raise HTTPException(403, "only the researcher who queued this run, or a "
                                 "research lead, can start it")

    if run["job_status"] != "queued":
        # Idempotent rather than an error: a double-click in the UI or a retried
        # request must not start the same training twice.
        return {"run_id": run_id, "job_status": run["job_status"], "started": False}

    research.start(run_id)
    return {"run_id": run_id, "job_status": "running", "started": True}


# ===========================================================================
# ACCOUNT PROVISIONING  (government + researcher portals)
#
# One endpoint per portal, both thin wrappers over app/accounts.py.
#
# These exist so an administrator can create a login FROM THE UI instead of
# adding the user in Supabase Studio and pasting a UUID back into a form. The
# Auth Admin API needs the service_role key, which bypasses RLS and must never
# reach a browser bundle -- so the key stays here and the browser posts.
#
# THE HIERARCHY IS ENFORCED IN PYTHON, in accounts._rules(), precisely BECAUSE
# the service key bypasses the policies that would otherwise do it. That is the
# trade for being able to create logins at all, and it is the reason those rules
# are a line-by-line transcription of the insert policies rather than a
# re-interpretation of them.
# ===========================================================================


class NewGovAccount(BaseModel):
    email: str
    password: str
    full_name: str
    tier: str                                  # district_manager | employee
    designation: str | None = None
    district_id: str | None = None


class NewResearchAccount(BaseModel):
    email: str
    password: str
    full_name: str
    tier: str                                  # research_lead | researcher
    can_run_models: bool = False
    can_train_models: bool = False


@app.post("/gov/accounts", status_code=201)
def create_gov_account(body: NewGovAccount, user_id: str = Depends(current_user_id)):
    """Create a government portal login and its profile in one step.

    A super admin may create a district manager; a district manager may create
    an employee in their OWN district, whatever district the request names.
    """
    from app import accounts

    try:
        return accounts.create_account(
            "gov", user_id,
            email=body.email, password=body.password, full_name=body.full_name,
            tier=body.tier, designation=body.designation, district_id=body.district_id,
        )
    except accounts.AccountError as e:
        raise HTTPException(e.status, str(e))


@app.post("/research/accounts", status_code=201)
def create_research_account(body: NewResearchAccount,
                            user_id: str = Depends(current_user_id)):
    """Create a researcher portal login and its profile in one step.

    A super admin may create a research lead or a researcher; a lead may create
    a researcher. The two capability flags apply to a researcher only -- a lead
    carries both by table constraint.
    """
    from app import accounts

    try:
        return accounts.create_account(
            "research", user_id,
            email=body.email, password=body.password, full_name=body.full_name,
            tier=body.tier,
            can_run_models=body.can_run_models,
            can_train_models=body.can_train_models,
        )
    except accounts.AccountError as e:
        raise HTTPException(e.status, str(e))
