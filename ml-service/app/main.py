from contextlib import asynccontextmanager

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.db import db
from app.train import FEATURES, MODEL_NAME, MODEL_PATH

_model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the pickle once at startup, not per request -- unpickling a
    200-tree forest on every call would dominate the response time."""
    global _model
    if not MODEL_PATH.exists():
        raise RuntimeError(f"{MODEL_PATH} missing. Run: python -m app.train")
    _model = joblib.load(MODEL_PATH)
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
    model_used: str = MODEL_NAME
    # Populated only by /farms/{id}/predict -- the dashboard shows the actual
    # Sentinel-2 values behind the number instead of asking you to trust it.
    features: dict | None = None
    feature_date: str | None = None


def predict(f: Features) -> Prediction:
    """Shared by POST /predict and (step 4) GET /farms/{id}/predict."""
    if f.crop_type != "wheat":
        # The model was trained on wheat only. Silently predicting for maize
        # would return a confident, wrong number -- worse than a 400.
        raise HTTPException(400, f"model only supports wheat, got {f.crop_type!r}")

    x = np.array([[getattr(f, name) for name in FEATURES]])

    # Spread across the trees as the interval. ponytail: this is model
    # disagreement, not a calibrated prediction interval -- it ignores the
    # irreducible field-level noise, so it reads narrow. Swap for quantile
    # regression forests once real yield data exists.
    votes = np.array([t.predict(x)[0] for t in _model.estimators_])

    return Prediction(
        predicted_yield=round(float(votes.mean()), 2),
        confidence_interval=[
            round(float(np.percentile(votes, 10)), 2),
            round(float(np.percentile(votes, 90)), 2),
        ],
    )


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "loaded": _model is not None}


@app.post("/predict", response_model=Prediction)
def predict_endpoint(f: Features):
    return predict(f)


@app.get("/farms/{farm_id}/predict", response_model=Prediction)
def predict_for_farm(farm_id: str):
    """Latest satellite_features for the farm -> model -> predictions row.

    This is the endpoint the dashboard calls. It runs on the service_role key,
    so it can read any farm and write predictions, which no farmer may write
    directly (see the migration). The farm_id is supplied by the browser and is
    NOT ownership-checked here -- see the note at the bottom of this file.
    """
    farm = db().table("farms").select("crop_type").eq("id", farm_id).execute()
    if not farm.data:
        raise HTTPException(404, f"no farm {farm_id}")

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
    if any(row[k] is None for k in FEATURES):
        raise HTTPException(422, f"incomplete indices for {row['date']}: {row}")

    result = predict(Features(crop_type=farm.data[0]["crop_type"], **{k: row[k] for k in FEATURES}))
    result.features = {k: row[k] for k in FEATURES}
    result.feature_date = row["date"]

    lo, hi = result.confidence_interval
    db().table("predictions").insert({
        "farm_id": farm_id,
        "predicted_yield": result.predicted_yield,
        "confidence_interval": f"[{lo},{hi}]",   # Postgres numrange literal
        "model_used": result.model_used,
    }).execute()

    return result


# TODO(phase 2): this endpoint trusts whatever farm_id it is given, so anyone
# who learns a UUID can read another farmer's yield. RLS does not help here --
# service_role bypasses it by design. Fix: have the frontend send its Supabase
# access token as a Bearer header, verify it with db().auth.get_user(token),
# and check farms.owner_id == that user's id before predicting.
