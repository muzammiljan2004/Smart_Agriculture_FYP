# Smart Agriculture — Farmer Portal (MVP)

Crop yield prediction for **Sheikhupura, Punjab** / **wheat** / **Random Forest**.

```
frontend/     React 18 + Vite + Tailwind + Leaflet. Talks to Supabase directly
              for CRUD, and to ml-service for predictions.
ml-service/   FastAPI. Owns Google Earth Engine + the ML model. Writes to
              Supabase with the service_role key.
supabase/     Migrations (schema + RLS).
```

Split rationale: anything needing Python (GEE, sklearn) lives in `ml-service`;
anything that is a plain table read/write goes straight to Supabase from the
browser so we don't write a CRUD API we don't need. Two people can work on the
two folders without touching each other's files.

## 1. Supabase setup

1. Create a free project at supabase.com. Region: any (Singapore is closest).
2. **SQL Editor** → paste `supabase/migrations/20260919000000_init.sql` → Run.
   (Or `supabase db push` if you install the CLI — not required.)
3. **Authentication → Providers → Email**: enabled by default. For local dev turn
   **Confirm email** OFF, otherwise every test signup needs an inbox.
4. **Project Settings → API**, copy:
   - Project URL + `anon` key → `frontend/.env`
   - `service_role` key → `ml-service/.env` — **server only**. It bypasses RLS;
     if it reaches the browser bundle, every farmer's data is public.

## 2. ml-service

```bash
cd ml-service

# Windows
py -m venv .venv
.venv\Scripts\activate

# macOS / Linux
python3 -m venv .venv
source .venv/bin/activate
```

```bash
pip install -r requirements.txt
cp .env.example .env                              # fill in the values
python -m scripts.train_real                      # builds app/model.pkl from the
                                                  # committed real dataset (~30s,
                                                  # no GEE credentials needed)
uvicorn app.main:app --reload                     # http://localhost:8000/docs
```

Google Earth Engine (one-time, only needed for the GEE script in step 4):

```bash
earthengine authenticate
```

Populate `satellite_features` for a farm (bbox + dates come from the farm's
district and crop):

```bash
cd ml-service
python -m scripts.fetch_satellite_data <farm_id>
```

Build the training CSV (3 districts x 5 seasons):

```bash
python -m scripts.fetch_historical_ndvi              # wheat / rabi
python -m scripts.fetch_historical_ndvi --crop rice  # rice / kharif
```

Then fill `yield_t_ha` in `ml-service/data/training.csv` from PBS district
yield tables and re-run `python -m app.train`. **Until rice rows have yields,
the model refuses rice predictions with a 422** rather than returning a
wheat-shaped guess — see `trained_crops` in `GET /health`.

## 3. frontend

```bash
cd frontend
npm install
cp .env.example .env                              # fill in the values
npm run dev                                       # http://localhost:5173
```

Run both at once — two terminals. The frontend expects ml-service on
`VITE_ML_API_URL`.

The trained model is NOT committed. `data/training_data_real.csv` (170 rows,
90 minutes of Earth Engine) is, and the model is 30 seconds of CPU away from
it with a fixed `random_state`, so every teammate builds an identical one.
Committing the pickle would add ~4.7 MB of undeltifiable binary to git history
per retrain.

## Tests

```bash
cd ml-service
python tests/test_ownership.py   # 403 on another farmer's farm
python tests/test_pipeline.py    # growth, alerts, PDF, multi-farm
```

Both hit the LIVE Supabase project: they create throwaway accounts and farms
and delete them in a `finally` block. Nothing persists.

## Status

- [x] 1. Project structure
- [x] 2. Schema + RLS migration
- [x] 3. FastAPI `/predict` + synthetic-trained Random Forest
- [x] 4. GEE Sentinel-2 script + `GET /farms/{id}/predict`
- [x] 5. React auth, farm form, dashboard
- [x] 6. JWT ownership check on /farms/{id}/predict (403)
- [x] 7. Multi-farm switcher
- [x] 8. District + crop dropdowns, honesty caveats, "model: preliminary"
- [x] 9. Confidence interval, district comparison, YoY trend
- [x] 10. Growth-stage tracker
- [x] 11. Drought + low-yield alerts, Gmail SMTP, alerts table
- [x] 12. One-page PDF report
