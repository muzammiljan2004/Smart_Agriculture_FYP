# Step 3 fills this in: POST /predict, GET /farms/{farm_id}/predict.
from fastapi import FastAPI

app = FastAPI(title="Smart Agriculture ML Service")


@app.get("/health")
def health():
    return {"status": "ok"}
