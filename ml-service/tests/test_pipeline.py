"""Steps 5-7 end to end: growth stage, alerts (incl. drought), PDF report."""
import json
import os
import pathlib
import re
import uuid

from dotenv import load_dotenv
from fastapi.testclient import TestClient
from supabase import create_client

from app.db import db
from app.main import app

load_dotenv()
ANON = re.search(
    r"VITE_SUPABASE_ANON_KEY=(\S+)",
    (pathlib.Path(__file__).resolve().parents[2] / "frontend" / ".env").read_text(encoding="utf-8-sig"),
).group(1)
URL = os.environ["SUPABASE_URL"]

TAG = uuid.uuid4().hex[:8]
EMAIL = f"test-full-{TAG}@example.com"
PW = "TestPassword123!"
users, farms = [], []
checks = []


def check(label, got, want):
    checks.append((label, got, want))


try:
    u = db().auth.admin.create_user({"email": EMAIL, "password": PW, "email_confirm": True})
    users.append(u.user.id)

    # Two farms for the same owner -> also exercises multi-farm (step 2).
    healthy = db().table("farms").insert({
        "owner_id": u.user.id, "farmer_name": f"Healthy {TAG}",
        "gps_lat": 31.7131, "gps_lng": 73.9783, "district": "Sheikhupura",
        "crop_type": "wheat", "season": "rabi", "planting_date": "2025-11-15",
    }).execute().data[0]
    farms.append(healthy["id"])

    stressed = db().table("farms").insert({
        "owner_id": u.user.id, "farmer_name": f"Stressed {TAG}",
        "gps_lat": 30.8103, "gps_lng": 73.4459, "district": "Okara",
        "crop_type": "wheat", "season": "rabi", "planting_date": "2025-11-20",
    }).execute().data[0]
    farms.append(stressed["id"])

    # Healthy: good NDWI, good NDVI.
    db().table("satellite_features").upsert({
        "farm_id": healthy["id"], "date": "2026-02-20",
        "ndvi": 0.68, "evi": 0.49, "ndwi": 0.28, "savi": 0.58, "nbr": 0.15,
    }, on_conflict="farm_id,date").execute()

    # A healthy PEER in Okara. Without it the stressed farm is the only farm in
    # its district, so there is no baseline to be below and drought cannot fire.
    peer = db().table("farms").insert({
        "owner_id": u.user.id, "farmer_name": f"Peer {TAG}",
        "gps_lat": 30.8200, "gps_lng": 73.4500, "district": "Okara",
        "crop_type": "wheat", "season": "rabi", "planting_date": "2025-11-18",
    }).execute().data[0]
    farms.append(peer["id"])
    db().table("satellite_features").upsert({
        "farm_id": peer["id"], "date": "2026-02-20",
        "ndvi": 0.66, "evi": 0.48, "ndwi": 0.27, "savi": 0.56, "nbr": 0.15,
    }, on_conflict="farm_id,date").execute()

    # Stressed: NDWI far below, NDVI low -> should trigger BOTH alerts.
    db().table("satellite_features").upsert({
        "farm_id": stressed["id"], "date": "2026-02-20",
        "ndvi": 0.38, "evi": 0.25, "ndwi": 0.05, "savi": 0.32, "nbr": 0.15,
    }, on_conflict="farm_id,date").execute()

    tok = create_client(URL, ANON).auth.sign_in_with_password(
        {"email": EMAIL, "password": PW}
    ).session.access_token
    H = {"Authorization": f"Bearer {tok}"}

    with TestClient(app) as c:
        check("lists all three farms", len(c.get("/farms", headers=H).json()), 3)

        # --- healthy farm ---
        r = c.get(f"/farms/{healthy['id']}/predict", headers=H)
        d = r.json()
        g = d.get("growth") or {}
        print("healthy growth:", json.dumps(
            {k: g.get(k) for k in ("stage", "days_since_sowing", "next_stage",
                                   "days_to_next_stage", "progress_pct",
                                   "planting_date_estimated")}, indent=2))
        check("healthy 200", r.status_code, 200)
        check("growth present", bool(g), True)
        check("planting date not estimated", g.get("planting_date_estimated"), False)
        check("stage is a real stage", g.get("stage") in
              ("Sowing", "Tillering", "Jointing", "Heading", "Grain filling", "Harvest"), True)

        # --- stressed farm ---
        r = c.get(f"/farms/{stressed['id']}/predict", headers=H)
        d2 = r.json()
        got_alerts = {a["type"] for a in d2.get("alerts", [])}
        print("\nstressed alerts:")
        for a in d2.get("alerts", []):
            print(f"  {a['type']:10s} [{a['severity']}] {a['message']}")
        check("stressed 200", r.status_code, 200)
        check("drought alert raised", "drought" in got_alerts, True)
        check("low_yield alert raised", "low_yield" in got_alerts, True)

        # Re-run: dedupe must not create duplicates.
        again = c.get(f"/farms/{stressed['id']}/predict", headers=H).json()
        check("no duplicate alerts on re-run", len(again.get("alerts", [])), len(d2.get("alerts", [])))

        open_rows = db().table("alerts").select("id").eq("farm_id", stressed["id"]).eq(
            "resolved", False).execute().data
        check("db holds exactly 2 open alerts", len(open_rows), 2)

        # Healthy farm should have no alerts.
        check("healthy farm has no alerts", len(d.get("alerts", [])), 0)

        # --- PDF ---
        r = c.get(f"/farms/{stressed['id']}/report", headers=H)
        check("report 200", r.status_code, 200)
        check("is a PDF", r.content[:4], b"%PDF")
        check("content-type", r.headers.get("content-type"), "application/pdf")
        check("has attachment filename",
              "attachment" in (r.headers.get("content-disposition") or ""), True)
        print(f"\nPDF: {len(r.content)} bytes, {r.headers.get('content-disposition')}")
        pathlib.Path(__file__).parent.joinpath("report-from-api.pdf").write_bytes(r.content)

        # --- ownership still holds on the new route ---
        check("report needs auth", c.get(f"/farms/{stressed['id']}/report").status_code, 401)

    print()
    ok = True
    for label, got, want in checks:
        ok &= got == want
        print(f"  [{'PASS' if got == want else 'FAIL'}] {label}: got={got!r} want={want!r}")
    print("\nALL PASS" if ok else "\nFAILURES")

finally:
    for f in farms:
        db().table("farms").delete().eq("id", f).execute()
    for x in users:
        db().auth.admin.delete_user(x)
    print("cleaned up")
