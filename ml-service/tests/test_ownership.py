"""End-to-end ownership test for GET /farms/{id}/predict.

Creates two throwaway Supabase accounts + one farm, checks that farmer B cannot
read farmer A's farm, then deletes everything it made.

IMPORTANT: sign-in happens on a SEPARATE anon client. supabase-py stores the
session on the client instance, so calling sign_in_with_password() on the
shared service_role client silently downgrades it to that user for every later
PostgREST call -- RLS then applies and service_role reads return nothing.
"""
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


FRONTEND_ENV = pathlib.Path(__file__).resolve().parents[2] / "frontend" / ".env"
ANON_KEY = re.search(
    r"VITE_SUPABASE_ANON_KEY=(\S+)", FRONTEND_ENV.read_text(encoding="utf-8-sig")
).group(1)
URL = os.environ["SUPABASE_URL"]

def token_client():
    """A fresh anon client per user. Keeps db() pure service_role, and avoids
    sign_out(), whose default global scope REVOKES the token we just issued."""
    return create_client(URL, ANON_KEY)

TAG = uuid.uuid4().hex[:8]
EMAIL_A = f"test-a-{TAG}@example.com"
EMAIL_B = f"test-b-{TAG}@example.com"
PW = "TestPassword123!"

created_users, created_farms = [], []


def token_for(email):
    c = token_client()
    return c.auth.sign_in_with_password({"email": email, "password": PW}).session.access_token


try:
    for email in (EMAIL_A, EMAIL_B):
        u = db().auth.admin.create_user({"email": email, "password": PW, "email_confirm": True})
        created_users.append(u.user.id)
    a_id, b_id = created_users
    print(f"users: A={a_id[:8]} B={b_id[:8]}")

    farm = db().table("farms").insert({
        "owner_id": a_id, "farmer_name": f"Owner A {TAG}",
        "gps_lat": 31.7131, "gps_lng": 73.9783,
        "district": "Sheikhupura", "crop_type": "wheat", "season": "rabi",
    }).execute()
    farm_id = farm.data[0]["id"]
    created_farms.append(farm_id)
    print(f"farm:  {farm_id[:8]} owned by A")

    tok_a, tok_b = token_for(EMAIL_A), token_for(EMAIL_B)

    # Guard against the bug this test just hit: after issuing tokens, the
    # shared client must STILL be service_role, i.e. able to see A's farm.
    seen = db().table("farms").select("id").eq("id", farm_id).execute()
    assert seen.data, "db() lost service_role -- a sign-in leaked into the shared client"
    print("db() still service_role after token issuance: OK")

    with TestClient(app) as c:
        checks = []
        h = lambda t: {"Authorization": f"Bearer {t}"}

        r = c.get(f"/farms/{farm_id}/predict")
        checks.append(("no token            ", r.status_code, 401))

        r = c.get(f"/farms/{farm_id}/predict", headers={"Authorization": "Bearer garbage.token.here"})
        checks.append(("garbage token       ", r.status_code, 401))

        r = c.get(f"/farms/{farm_id}/predict", headers=h(tok_b))
        checks.append(("farmer B -> A's farm", r.status_code, 403))

        # Owner clears the ownership gate; the 404 here is the NEXT check
        # (no satellite_features yet), which is what we want to see.
        r = c.get(f"/farms/{farm_id}/predict", headers=h(tok_a))
        detail_a = r.json().get("detail", "")
        checks.append(("farmer A -> A's farm", r.status_code, 404))
        checks.append(("  ..and it is the features 404", "satellite_features" in detail_a, True))

        r = c.get(f"/farms/{uuid.uuid4()}/predict", headers=h(tok_a))
        checks.append(("nonexistent farm    ", r.status_code, 404))

        ra = c.get("/farms", headers=h(tok_a))
        rb = c.get("/farms", headers=h(tok_b))
        checks.append(("A lists own farms   ", (ra.status_code, len(ra.json())), (200, 1)))
        checks.append(("B lists own farms   ", (rb.status_code, len(rb.json())), (200, 0)))

    print()
    ok = True
    for label, got, want in checks:
        mark = "PASS" if got == want else "FAIL"
        ok &= got == want
        print(f"  [{mark}] {label}  got={got} want={want}")
    print("\nALL PASS" if ok else "\nFAILURES ABOVE")

finally:
    for fid in created_farms:
        db().table("farms").delete().eq("id", fid).execute()
    for uid in created_users:
        try:
            db().auth.admin.delete_user(uid)
        except Exception as e:
            print(f"  could not delete user {uid[:8]}: {e}")
    print(f"cleaned up {len(created_farms)} farm(s), {len(created_users)} user(s)")
