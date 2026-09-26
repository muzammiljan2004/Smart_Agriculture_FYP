from contextlib import asynccontextmanager
from datetime import date

import joblib
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app import alerts, land, suitability
from app.db import db
from app.districts import CROPS, INDEX_FEATURES, one_hot

# Below this many TRAINING rows, a crop's prediction carries a thin-data
# caveat. 150 is a judgement call, not a derived threshold: it sits above the
# crops that visibly struggle in the per-crop holdout (barley 112, maize 129,
# cotton 138) and below those that hold up (wheat 204, tomato 192, potato 189).
# Row count is necessary, not sufficient -- tomato has 192 rows and still
# scores negative -- which is why per_crop_r2 is checked separately below.
MIN_ROWS_CONFIDENT = 150
from app.growth import growth_stage
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
        .select("id, owner_id, farmer_name, district, crop_type, season, gps_lat, gps_lng, planting_date, water_source, salinity_flag, last_crop")
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
        from app.crops import season_window
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


def borrow_district_features(farm_row) -> dict | None:
    """Copy a same-district farm's latest indices onto this farm.

    Legitimate only because indices are currently DISTRICT-level: fetch_indices
    samples the district bounding box, not the farm, so every farm in a
    district gets byte-identical values. Re-querying GEE per farm would spend
    ~30s to recompute a number we already hold.

    ponytail: DELETE THIS the moment per-farm geometry lands (the 500 m buffer
    around farms.gps_*). At that point two farms in one district legitimately
    differ, and copying would silently hand one farm another's readings --
    which is far worse than the 404 this replaces.
    """
    peers = (
        db().table("farms").select("id")
        .eq("district", farm_row["district"])
        .neq("id", farm_row["id"])
        .execute()
    )
    ids = [p["id"] for p in (peers.data or [])]
    if not ids:
        return None

    src = (
        db().table("satellite_features")
        .select("date, " + ", ".join(INDEX_FEATURES))
        .in_("farm_id", ids)
        .order("date", desc=True)
        .limit(1)
        .execute()
    )
    if not src.data:
        return None

    row = {"farm_id": farm_row["id"], "date": src.data[0]["date"],
           **{k: src.data[0][k] for k in INDEX_FEATURES}}
    db().table("satellite_features").upsert(row, on_conflict="farm_id,date").execute()
    print(f"[features] farm {farm_row['id'][:8]} reused {farm_row['district']} "
          f"indices dated {row['date']}")
    return row


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

    feats = (
        db().table("satellite_features")
        .select("ndvi, evi, ndwi, savi, nbr, date")
        .eq("farm_id", farm_id)
        .order("date", desc=True)
        .limit(1)
        .execute()
    )
    row = feats.data[0] if feats.data else borrow_district_features(farm_row)
    if not row:
        raise HTTPException(
            404,
            f"No imagery for {farm_row['district']} yet, and no other farm in that "
            f"district has any to reuse. Run: "
            f"python -m scripts.fetch_satellite_data {farm_id}",
        )
    if any(row[k] is None for k in INDEX_FEATURES):
        raise HTTPException(422, f"incomplete indices for {row['date']}: {row}")

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
