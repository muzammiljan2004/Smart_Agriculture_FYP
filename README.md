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
py -m venv .venv && .venv\Scripts\activate    # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                              # fill in the values
python -m app.train                               # builds app/model.pkl (~2s)
uvicorn app.main:app --reload                     # http://localhost:8000/docs
```

Google Earth Engine (one-time, only needed for the GEE script in step 4):

```bash
earthengine authenticate
```

Populate `satellite_features` for a farm (manual, run once per farm):

```bash
cd ml-service
python -m scripts.fetch_satellite_data <farm_id> --start 2025-01-15 --end 2025-03-15
```

## 3. frontend

```bash
cd frontend
npm install
cp .env.example .env                              # fill in the values
npm run dev                                       # http://localhost:5173
```

Run both at once — two terminals. The frontend expects ml-service on
`VITE_ML_API_URL`.

## Status

- [x] 1. Project structure
- [x] 2. Schema + RLS migration
- [x] 3. FastAPI `/predict` + synthetic-trained Random Forest
- [x] 4. GEE Sentinel-2 script + `GET /farms/{id}/predict`
- [x] 5. React auth, farm form, dashboard
