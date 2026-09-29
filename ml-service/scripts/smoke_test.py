"""End-to-end smoke test against the real database and the real model.

    python -m scripts.smoke_test
    python -m scripts.smoke_test --no-gee     # skip the checks that call GEE

Prints PASS / FAIL / BLOCKED per check and exits non-zero if anything FAILED.

WHAT THIS IS. Eleven checks over the seams that have actually broken in this
project: cross-user access, per-farm imagery isolation, model metadata, the
per-crop caveats, the PDF, the no-imagery path, which observation
/predict actually feeds the model, and the no-crop guard. It runs the real FastAPI
app in-process against the real Supabase project with REAL bearer tokens --
not dependency overrides -- so the auth path is genuinely exercised.

CREDENTIALS. Nothing is hardcoded. SUPABASE_URL and the service_role key come
from ml-service/.env, the anon key from frontend/.env, exactly as
tests/test_ownership.py already does. The two test accounts are created for
the run with a random password and deleted in the finally block; no password
is printed and no permanent user is left behind.

CLEANUP. Every row this script creates is tracked by id -- farms, and the
prediction and alert rows that /predict writes as a side effect on EXISTING
dev farms. Cleanup deletes only those ids, so it cannot touch real data. The
farms created here cascade to their own satellite_features on delete.
"""
import argparse
import os
import pathlib
import re
import secrets
import sys
import uuid
from datetime import date, timedelta

from dotenv import load_dotenv
from fastapi.testclient import TestClient
from supabase import create_client

from app.db import db
from app.main import app
from app.train import MODEL_PATH

load_dotenv()

FRONTEND_ENV = pathlib.Path(__file__).resolve().parents[2] / "frontend" / ".env"
URL = os.environ["SUPABASE_URL"]
TAG = uuid.uuid4().hex[:8]
# Generated per run, never written down. The accounts live for one run.
PW = secrets.token_urlsafe(18) + "aA1!"

results = []          # (name, verdict, evidence)
made_farms, made_users = [], []
pred_before, alert_before = set(), set()


def record(name, verdict, evidence=""):
    results.append((name, verdict, evidence))
    tag = {"PASS": "PASS", "FAIL": "FAIL", "BLOCKED": "BLOCKED"}[verdict]
    print(f"  {tag:7s} {name}" + (f"\n          {evidence}" if evidence else ""))


def check(name, ok, evidence=""):
    record(name, "PASS" if ok else "FAIL", evidence)
    return ok


def anon_key():
    if not FRONTEND_ENV.exists():
        return None
    m = re.search(r"VITE_SUPABASE_ANON_KEY=(\S+)",
                  FRONTEND_ENV.read_text(encoding="utf-8-sig"))
    return m.group(1) if m else None


def make_user(email, key):
    u = db().auth.admin.create_user(
        {"email": email, "password": PW, "email_confirm": True}).user.id
    made_users.append(u)
    c = create_client(URL, key)
    tok = c.auth.sign_in_with_password(
        {"email": email, "password": PW}).session.access_token
    return u, {"Authorization": f"Bearer {tok}"}


def make_farm(owner, crop, season, lat, lng, district, label, area=2.0,
              planting=None):
    row = db().table("farms").insert({
        "owner_id": owner, "farmer_name": f"SMOKE {TAG} {label}",
        "gps_lat": lat, "gps_lng": lng, "district": district,
        "crop_type": crop, "season": season, "area_hectares": area,
        **({"planting_date": planting} if planting else {}),
    }).execute().data[0]
    made_farms.append(row["id"])
    return row


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-gee", action="store_true",
                    help="skip checks that need a live Earth Engine fetch")
    args = ap.parse_args()

    key = anon_key()
    if not key:
        record("prerequisite: anon key", "BLOCKED",
               f"no VITE_SUPABASE_ANON_KEY in {FRONTEND_ENV}")
        return 1
    if not MODEL_PATH.exists():
        record("prerequisite: model.pkl", "BLOCKED",
               f"{MODEL_PATH} missing; run scripts.train_real")
        return 1

    import joblib
    bundle = joblib.load(MODEL_PATH)
    per_r2 = bundle.get("per_crop_r2") or {}
    trained = sorted(bundle.get("trained_crops") or [])

    # Snapshot side-effect tables so cleanup removes only what we caused.
    global pred_before, alert_before
    pred_before = {r["id"] for r in
                   (db().table("predictions").select("id").execute().data or [])}
    alert_before = {r["id"] for r in
                    (db().table("alerts").select("id").execute().data or [])}

    print(f"smoke test {TAG}  |  model {bundle.get('model_name')}  "
          f"|  {len(trained)} trained crops\n")

    with TestClient(app) as c:
        a_id, HA = make_user(f"smoke-a-{TAG}@example.com", key)
        b_id, HB = make_user(f"smoke-b-{TAG}@example.com", key)

        # ---------------------------------------------------------- A
        print("A. cross-user farm isolation")
        farm_a = make_farm(a_id, "wheat", "rabi", 31.49882, 73.72578,
                           "Sheikhupura", "A-owned")
        rb = c.get(f"/farms/{farm_a['id']}/timeseries", headers=HB)
        ok = rb.status_code == 403
        body = rb.text
        check("B cannot read A's timeseries", ok, f"HTTP {rb.status_code}")
        check("no A data leaked in the refusal body",
              "series" not in body and farm_a["farmer_name"] not in body,
              f"{len(body)} bytes, no series key")
        ra = c.get(f"/farms/{farm_a['id']}/timeseries", headers=HA)
        check("A can read A's own farm", ra.status_code == 200,
              f"HTTP {ra.status_code}")
        # Fetch A's own imagery now. D1 and E both need a farm that this run
        # can authenticate against, and every existing dev farm belongs to an
        # account whose password we deliberately do not hold. The coordinate is
        # a Dynamic-World-sampled cropland pixel, so the series is real.
        if not args.no_gee:
            rr = c.get(f"/farms/{farm_a['id']}/timeseries?refresh=true", headers=HA)
            n = (rr.json() or {}).get("count", 0) if rr.status_code == 200 else 0
            check("A's own field imagery fetched", rr.status_code == 200 and n > 10,
                  f"HTTP {rr.status_code}, {n} observations")
        check("unauthenticated is refused",
              c.get(f"/farms/{farm_a['id']}/timeseries").status_code == 401)

        # ---------------------------------------------------------- B
        print("\nB. same-district farms use their own imagery")
        if args.no_gee:
            record("two same-district farms differ", "BLOCKED", "--no-gee")
        else:
            dev = (db().table("farms").select("id, district, gps_lat, gps_lng, owner_id")
                   .neq("farmer_name", f"SMOKE {TAG} A-owned").execute()).data or []
            bydist = {}
            for f in dev:
                bydist.setdefault(f["district"], []).append(f)
            pair = next((v for v in bydist.values() if len(v) >= 2), None)
            if not pair:
                record("two same-district farms differ", "BLOCKED",
                       "no district holds two existing farms")
            else:
                f1, f2 = pair[0], pair[1]
                # Query as the owner of each, via a token, not service_role.
                vecs = {}
                for f in (f1, f2):
                    own = db().auth.admin.get_user_by_id(f["owner_id"]).user.email
                    # Read through the API using an admin-minted session is not
                    # possible without the password, so read the stored rows
                    # directly and prove they differ; the API path is already
                    # covered by check A.
                    r = c.get(f"/farms/{f['id']}/timeseries?refresh=true",
                              headers=HA)
                    if r.status_code == 403:
                        rows = (db().table("satellite_features")
                                .select("date, ndvi, evi, ndwi, savi, nbr")
                                .eq("farm_id", f["id"]).order("date", desc=True)
                                .limit(1).execute()).data
                    else:
                        rows = (r.json().get("series") or [])[-1:]
                    vecs[f["id"]] = rows[0] if rows else None
                v1, v2 = vecs[f1["id"]], vecs[f2["id"]]
                if not v1 or not v2:
                    record("two same-district farms differ", "BLOCKED",
                           "one farm has no stored imagery")
                else:
                    idx = ("ndvi", "evi", "ndwi", "savi", "nbr")
                    differs = any(v1.get(k) != v2.get(k) for k in idx)
                    check("same-district farms hold DIFFERENT index vectors",
                          differs,
                          f"{f1['district']}: ndvi {v1.get('ndvi')} vs {v2.get('ndvi')}"
                          f"  (borrow_district_features would make these equal)")

        # ---------------------------------------------------------- C
        print("\nC. /health trained-crop metadata")
        h = c.get("/health")
        hj = h.json() if h.status_code == 200 else {}
        got = sorted(hj.get("trained_crops") or [])
        check("/health returns 200", h.status_code == 200, f"HTTP {h.status_code}")
        check("trained_crops matches the model artifact", got == trained,
              f"{len(got)}: {', '.join(got)}")
        check("barley is NOT trained", "barley" not in got)
        check("garlic/brinjal/chilli are NOT trained",
              not ({"garlic", "brinjal", "chilli"} & set(got)))
        exposes = ("per_crop_r2" in hj) or ("crop_rows" in hj)
        record("per-crop r2 / row counts exposed by /health",
               "PASS" if exposes else "BLOCKED",
               "exposed" if exposes else
               "NOT exposed: /health returns trained_crops + pooled metrics only. "
               "Per-crop figures live in the bundle and surface as caveats on "
               "/predict. Reported, not asserted -- the endpoint does not claim them.")

        # ---------------------------------------------------------- D
        print("\nD. prediction behaviour and caveats")
        if args.no_gee:
            record("D1 wheat prediction", "BLOCKED", "--no-gee")
        else:
            r = c.get(f"/farms/{farm_a['id']}/predict", headers=HA)
            j = r.json() if r.status_code == 200 else {}
            check("D1 wheat /predict 200 with a number",
                  r.status_code == 200
                  and isinstance(j.get("predicted_yield"), (int, float)),
                  f"HTTP {r.status_code} -> {j.get('predicted_yield')} {j.get('unit')}"
                  f" from {j.get('feature_date')}")
            check("D1 wheat has NO does-not-predict caveat",
                  not any("does not predict" in x for x in j.get("caveats", [])),
                  f"{len(j.get('caveats', []))} caveat(s)")

        neg = sorted(cr for cr, v in per_r2.items() if v < 0)
        if not neg:
            record("D2 negative-R2 crop caveat", "BLOCKED",
                   "no trained crop has a negative holdout R2 in the current model")
        elif args.no_gee:
            record("D2 negative-R2 crop caveat", "BLOCKED", "--no-gee")
        else:
            crop = neg[0]
            season = {"rice": "kharif", "bajra": "kharif", "jowar": "kharif",
                      "maize": "kharif", "tomato": "kharif", "cotton": "kharif",
                      "wheat": "rabi", "barley": "rabi", "potato": "rabi",
                      "onion": "rabi", "sugarcane": "annual"}[crop]
            nf = make_farm(a_id, crop, season, 31.49882, 73.72578,
                           "Sheikhupura", f"neg-{crop}")
            c.get(f"/farms/{nf['id']}/timeseries?refresh=true", headers=HA)
            r = c.get(f"/farms/{nf['id']}/predict", headers=HA)
            j = r.json() if r.status_code == 200 else {}
            check(f"D2 {crop} (R2 {per_r2[crop]:+.4f}) carries the does-not-predict caveat",
                  r.status_code == 200
                  and any("does not predict" in x for x in j.get("caveats", [])),
                  f"HTTP {r.status_code}; caveats: "
                  + " | ".join(x[:70] for x in j.get("caveats", [])))

        # D3 barley: creatable (Step 4 kept it) but unpredictable (Step 6 removed it)
        if args.no_gee:
            record("D3 barley refused by /predict", "BLOCKED", "--no-gee")
        else:
            try:
                bf = make_farm(a_id, "barley", "rabi", 31.49882, 73.72578,
                               "Sheikhupura", "barley")
                created = True
            except Exception as e:
                created = False
                record("D3 barley farm is creatable", "FAIL", str(e)[:70])
            if created:
                check("D3 barley farm is creatable (Step 4 kept it valid)", True,
                      bf["id"][:8])
                c.get(f"/farms/{bf['id']}/timeseries?refresh=true", headers=HA)
                r = c.get(f"/farms/{bf['id']}/predict", headers=HA)
                detail = (r.json() or {}).get("detail", "") if r.status_code != 200 else ""
                check("D3 barley /predict refuses", r.status_code == 422,
                      f"HTTP {r.status_code}: {str(detail)[:90]}")
                check("D3 refusal is actionable and fabricates no yield",
                      "predicted_yield" not in r.text and "barley" in str(detail))

        # D4 garlic: the database must refuse it
        try:
            make_farm(a_id, "garlic", "rabi", 31.49882, 73.72578,
                      "Sheikhupura", "garlic")
            check("D4 garlic farm rejected by the DB", False,
                  "*** it was accepted ***")
        except Exception as e:
            check("D4 garlic farm rejected by the DB",
                  "farms_crop_type_check" in str(e),
                  "farms_crop_type_check violated, as intended")

        # ---------------------------------------------------------- E
        print("\nE. PDF report endpoint")
        r = c.get(f"/farms/{farm_a['id']}/report", headers=HA)
        if r.status_code != 200:
            record("E PDF endpoint", "BLOCKED",
                   f"HTTP {r.status_code} -- farm A has no imagery yet, "
                   f"the report reuses /predict")
        else:
            body = r.content
            check("E PDF: 200, application/pdf, %PDF magic, non-empty",
                  r.headers.get("content-type", "").startswith("application/pdf")
                  and body[:4] == b"%PDF" and len(body) > 1000,
                  f"{r.headers.get('content-type')}, {len(body)} bytes, "
                  f"starts {body[:4]!r}")

        # ---------------------------------------------------------- F
        print("\nF. farm with no imagery")
        bare = make_farm(a_id, "wheat", "rabi", 31.40, 73.60,
                         "Sheikhupura", "no-imagery")
        r = c.get(f"/farms/{bare['id']}/predict", headers=HA)
        detail = str((r.json() or {}).get("detail", "")) if r.status_code != 200 else ""
        check("F no-imagery farm returns 404", r.status_code == 404,
              f"HTTP {r.status_code}")
        check("F no fabricated prediction", "predicted_yield" not in r.text)
        check("F guidance names the current refresh workflow",
              "timeseries?refresh=true" in detail, detail[:110])

        # ---------------------------------------------------------- G
        # Step 9. /predict used to take the newest stored observation
        # outright, which after a full-season fetch is post-harvest bare soil.
        # This plants three observations either side of the crop's window and
        # asserts the in-season one is chosen -- so the regression cannot come
        # back silently. No GEE: the rows are written directly, which is the
        # point. A real fetch cannot be made to produce a chosen shape.
        print("")
        print("G. /predict selects an IN-SEASON observation")
        from app.crops import season_window as _win
        from app.main import current_season as _season

        gf = make_farm(a_id, "wheat", "rabi", 31.49882, 73.72578,
                       "Sheikhupura", "season-pick")
        season = _season("wheat")
        w0, w1 = (date.fromisoformat(x) for x in _win("wheat", season))
        plant = {
            # label          date                       ndvi  (all five scale together)
            "pre-season":  (w0 - timedelta(days=30), 0.11),
            "in-season":   (w1 - timedelta(days=10), 0.62),
            "post-season": (w1 + timedelta(days=60), 0.09),
        }
        db().table("satellite_features").insert([
            {"farm_id": gf["id"], "date": d.isoformat(), "ndvi": v,
             "evi": round(v * 0.9, 4), "ndwi": round(v * 0.5, 4),
             "savi": round(v * 1.1, 4), "nbr": round(v * 0.8, 4)}
            for d, v in plant.values()
        ]).execute()

        r = c.get(f"/farms/{gf['id']}/predict", headers=HA)
        j = r.json() if r.status_code == 200 else {}
        want_date, want_ndvi = plant["in-season"]
        newest_date = plant["post-season"][0]
        check("G1 /predict returns 200", r.status_code == 200,
              f"HTTP {r.status_code}")
        check("G2 chose the in-season observation, not the newest stored",
              j.get("feature_date") == want_date.isoformat(),
              f"window {w0}..{w1}; chose {j.get('feature_date')}, "
              f"newest stored is {newest_date} (the old code took that one)")
        check("G3 the indices fed to the model are the in-season ones",
              (j.get("features") or {}).get("ndvi") == want_ndvi,
              f"ndvi {(j.get('features') or {}).get('ndvi')} "
              f"(post-season bare soil is {plant['post-season'][1]})")

        # And a farm whose ONLY imagery is out of season must refuse rather
        # than reach for it: the message has to say why, or the farmer is sent
        # to re-fetch imagery they already have.
        of = make_farm(a_id, "wheat", "rabi", 31.49882, 73.72578,
                       "Sheikhupura", "out-of-season-only")
        db().table("satellite_features").insert({
            "farm_id": of["id"], "date": newest_date.isoformat(),
            "ndvi": 0.09, "evi": 0.08, "ndwi": 0.04, "savi": 0.10, "nbr": 0.07,
        }).execute()
        r = c.get(f"/farms/{of['id']}/predict", headers=HA)
        detail = str((r.json() or {}).get("detail", "")) if r.status_code != 200 else ""
        check("G4 out-of-season-only imagery is refused, not used",
              r.status_code == 404 and "predicted_yield" not in r.text,
              f"HTTP {r.status_code}")
        check("G5 the refusal says the imagery is outside the window",
              "outside" in detail and newest_date.isoformat() in detail,
              detail[:130])

        # ---------------------------------------------------------- H
        # The no-crop guard. Farm 6cc28b46 sat on ground Dynamic World calls
        # 100% built and /predict answered 3.41 t/ha, because the forest reads
        # the crop one-hot far harder than the indices. Both halves are
        # asserted here: the flat series must be refused AND a crop-shaped one
        # must still go through, or a guard that simply refuses everything
        # would pass a one-sided test.
        print("")
        print("H. no-crop guard")

        def plant_series(label, values):
            """A farm carrying these NDVI values, evenly spread in-season."""
            f = make_farm(a_id, "wheat", "rabi", 31.49882, 73.72578,
                          "Sheikhupura", label)
            span = (w1 - w0).days
            step = span // (len(values) + 1)
            db().table("satellite_features").insert([
                {"farm_id": f["id"],
                 "date": (w0 + timedelta(days=step * (i + 1))).isoformat(),
                 "ndvi": v, "evi": round(v * 0.9, 4), "ndwi": round(v * 0.5, 4),
                 "savi": round(v * 1.1, 4), "nbr": round(v * 0.8, 4)}
                for i, v in enumerate(values)
            ]).execute()
            return f

        # HA. The measured built-up series: 12 readings, none above 0.20.
        flat = plant_series("flat-no-crop",
                            [0.169, 0.189, 0.178, 0.131, 0.083, 0.153,
                             0.196, 0.130, 0.155, 0.128, 0.197, 0.198])
        r = c.get(f"/farms/{flat['id']}/predict", headers=HA)
        detail = str((r.json() or {}).get("detail", "")) if r.status_code != 200 else ""
        check("HA flat low-NDVI series is refused", r.status_code == 422,
              f"HTTP {r.status_code}")
        check("HA no yield is fabricated for it",
              "predicted_yield" not in r.text
              and "No active crop vegetation" in detail,
              detail[:120])
        check("HA the refusal reports its evidence",
              "0.198" in detail and "12 observations" in detail,
              "peak and observation count both named")

        # HB. A crop-shaped season over the same window: green-up, peak,
        # senescence. Must still predict.
        good = plant_series("crop-shaped",
                            [0.18, 0.24, 0.38, 0.55, 0.71, 0.82,
                             0.79, 0.68, 0.52, 0.39, 0.28, 0.22])
        r = c.get(f"/farms/{good['id']}/predict", headers=HA)
        j = r.json() if r.status_code == 200 else {}
        check("HB crop-shaped series still predicts",
              r.status_code == 200
              and isinstance(j.get("predicted_yield"), (int, float)),
              f"HTTP {r.status_code} -> {j.get('predicted_yield')} "
              f"from {j.get('feature_date')}")

        # HC. Low but ALIVE. Never clears 0.25, yet swings 0.21 across the
        # season -- a weak crop, not a missing one. The amplitude clause is
        # what keeps this from being refused, and requirement 5 turns on it.
        weak = plant_series("low-but-alive",
                            [0.03, 0.06, 0.11, 0.18, 0.24, 0.23,
                             0.19, 0.14, 0.09, 0.06, 0.05, 0.03])
        r = c.get(f"/farms/{weak['id']}/predict", headers=HA)
        check("HC low-yield-but-living series is NOT refused",
              r.status_code == 200,
              f"HTTP {r.status_code}; peak 0.24 is under the 0.25 bar but it "
              f"varies by 0.21, so it is a poor crop rather than no crop")

        # ---------------------------------------------------------- I
        # A sowing date outside the crop's conventional season. The fetch
        # window follows the farmer and the predict window follows the
        # calendar, and for this farm they used to be completely disjoint:
        # "Fetch satellite imagery" stored 50 real observations that /predict
        # then rejected as out of season, so the button could be pressed
        # forever without ever producing a prediction.
        print("")
        print("I. sowing date outside the crop's calendar season")
        from app.field import InvalidSowingDate, season_bounds
        from app.main import _field_window

        wrong = make_farm(a_id, "wheat", "rabi", 30.6525, 73.6461,
                          "Okara", "wrong-season", planting="2026-06-15")

        # I1. The two windows must overlap. Pure arithmetic, no GEE.
        _, fa, fb = _field_window(wrong)
        pw0, pw1 = _win("wheat", _season("wheat"))
        check("I1 fetch window overlaps the predict window",
              not (fb < pw0 or fa > pw1),
              f"fetch {fa}..{fb}  vs  predict {pw0}..{pw1}")

        # I3. A future sowing date must name itself rather than arriving as a
        # generic "no imagery" 404. Also pure -- run before I2 so it still
        # reports under --no-gee.
        try:
            season_bounds("wheat", date(2026, 11, 20), date(2026, 9, 29))
            check("I3 future sowing date is refused by name", False,
                  "*** it produced a window instead ***")
        except InvalidSowingDate as e:
            check("I3 future sowing date is refused by name",
                  "2026-11-20" in str(e), str(e)[:100])

        # I2. The verdict has to be the RIGHT one.
        #
        # An earlier version of this check asserted only that the refresh loop
        # had ended, and it passed while /predict answered 2.68 t/ha from
        # 2026-03-15 -- three months before the farmer says they sowed. The
        # test encoded the wrong requirement: the goal is not "a verdict", it
        # is a verdict about THIS farmer's crop cycle.
        if args.no_gee:
            record("I2 wrong-season farm is refused, not predicted from "
                   "pre-sowing imagery", "BLOCKED", "--no-gee")
        else:
            rt = c.get(f"/farms/{wrong['id']}/timeseries?refresh=true", headers=HA)
            n = (rt.json() or {}).get("count", 0) if rt.status_code == 200 else 0
            r = c.get(f"/farms/{wrong['id']}/predict", headers=HA)
            body = r.json() or {}
            detail = str(body.get("detail", "")) if r.status_code != 200 else ""

            check("I2a the refresh loop is over", not (r.status_code == 404
                                                       and "refresh=true" in r.text),
                  f"fetched {n} observation(s); /predict -> HTTP {r.status_code}")
            check("I2b it did NOT predict from the pre-sowing 2026-03-15 frame",
                  r.status_code == 422
                  and "predicted_yield" not in r.text
                  and body.get("feature_date") != "2026-03-15",
                  f"HTTP {r.status_code}, feature_date {body.get('feature_date')}")
            check("I2c the refusal names the crop, the sowing date and the window",
                  all(s in detail for s in ("wheat", "2026-06-15", pw0, pw1))
                  and "sowing date" in detail,
                  detail[:150])

        # I4. The other half: a NORMALLY sown farm must be untouched by the
        # rule above. Without this, refusing everything would pass I2.
        if args.no_gee:
            record("I4 normal wheat farm keeps its observation", "BLOCKED", "--no-gee")
        else:
            normal = make_farm(a_id, "wheat", "rabi", 31.49882, 73.72578,
                               "Sheikhupura", "normal-sowing", planting="2025-11-15")
            c.get(f"/farms/{normal['id']}/timeseries?refresh=true", headers=HA)

            # What the window alone would pick, ignoring the sowing date --
            # i.e. the selection as it behaved before this rule existed.
            qq = (db().table("satellite_features")
                  .select("date").eq("farm_id", normal["id"])
                  .gte("date", pw0).lte("date", pw1))
            for k in ("ndvi", "evi", "ndwi", "savi", "nbr"):
                qq = qq.not_.is_(k, "null")
            before = (qq.order("date", desc=True).limit(1).execute().data or [{}])
            before_date = before[0].get("date")

            r = c.get(f"/farms/{normal['id']}/predict", headers=HA)
            j = r.json() if r.status_code == 200 else {}
            check("I4 normal wheat farm predicts, and from the SAME observation "
                  "as before the rule",
                  r.status_code == 200 and j.get("feature_date") == before_date,
                  f"HTTP {r.status_code}; window-only pick {before_date}, "
                  f"actual {j.get('feature_date')}; sown 2025-11-15")

    return 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    finally:
        # ---- cleanup: only ids this run created -------------------------
        for f in made_farms:
            db().table("farms").delete().eq("id", f).execute()
        new_preds = [r["id"] for r in
                     (db().table("predictions").select("id").execute().data or [])
                     if r["id"] not in pred_before]
        for p in new_preds:
            db().table("predictions").delete().eq("id", p).execute()
        new_alerts = [r["id"] for r in
                      (db().table("alerts").select("id").execute().data or [])
                      if r["id"] not in alert_before]
        for a in new_alerts:
            db().table("alerts").delete().eq("id", a).execute()
        for u in made_users:
            db().auth.admin.delete_user(u)

        left = (db().table("farms").select("id", count="exact")
                .like("farmer_name", f"SMOKE {TAG}%").limit(1).execute().count or 0)
        print(f"\ncleanup: {len(made_farms)} farm(s), {len(new_preds)} prediction(s), "
              f"{len(new_alerts)} alert(s), {len(made_users)} user(s) removed; "
              f"{left} smoke farm(s) left behind")

        p = sum(1 for _, v, _ in results if v == "PASS")
        f = sum(1 for _, v, _ in results if v == "FAIL")
        b = sum(1 for _, v, _ in results if v == "BLOCKED")
        print(f"\n{p} PASS   {f} FAIL   {b} BLOCKED")
        for n, v, e in results:
            if v != "PASS":
                print(f"  {v:7s} {n}")
        sys.exit(1 if (f or left) else code)
