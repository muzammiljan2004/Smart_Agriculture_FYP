from contextlib import asynccontextmanager
from datetime import date

import joblib
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app import alerts
from app.db import db
from app.districts import CROPS, INDEX_FEATURES, one_hot
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
        raise RuntimeError(f"{MODEL_PATH} missing. Run: python -m app.train")
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
        .select("id, owner_id, farmer_name, district, crop_type, season, gps_lat, gps_lng, planting_date")
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


def predict(f: Features) -> Prediction:
    """Shared by POST /predict and GET /farms/{id}/predict."""
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

    x = np.array([[getattr(f, name) for name in INDEX_FEATURES] + one_hot(f.crop_type)])

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
    synthetic = _bundle["source"] != "csv:training.csv"
    if synthetic:
        caveats.append(
            "Model trained on synthetic data - every prediction here is illustrative, not validated."
        )

    # 2. The crop. Rice reaching this point at all means it has training rows
    #    (predict() refuses otherwise), but "some" is not "enough".
    if crop_type == "rice":
        caveats.append(
            "Limited training data - predictions for rice are less reliable than for wheat."
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
    if not feats.data:
        raise HTTPException(
            404,
            f"no satellite_features for farm {farm_id}. Run: "
            f"python -m scripts.fetch_satellite_data {farm_id}",
        )

    row = feats.data[0]
    if any(row[k] is None for k in INDEX_FEATURES):
        raise HTTPException(422, f"incomplete indices for {row['date']}: {row}")

    result = predict(
        Features(crop_type=farm_row["crop_type"], **{k: row[k] for k in INDEX_FEATURES})
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
