"""Prove the government portal's access control against the live database.

    python -m scripts.verify_gov_rls            # run, then clean up
    python -m scripts.verify_gov_rls --keep     # leave the test accounts in place

Creates three throwaway accounts -- one per tier, two in DIFFERENT districts --
signs in as each with the ANON key exactly as a browser does, and asserts what
each can and cannot read and write. Then deletes them.

WHY THIS EXISTS. Every access rule in the brief is implemented as an RLS policy,
and a policy that looks right is not a policy that works: a NULL on either side of
a comparison, a missing WITH CHECK, or a recursive subquery on gov_profiles all
produce a schema that applies cleanly and then either leaks rows or refuses
everyone. The only way to know is to log in as each tier and try. Reading the
policies proves nothing; this does.

It runs as the test users themselves, never as service_role, except to create and
delete the fixtures. A test that checked these rules with the service key would
pass no matter how broken the policies were, because service_role bypasses RLS.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
load_dotenv(ROOT.parent / "frontend" / ".env")        # the anon key lives here

URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SERVICE = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
ANON = os.environ.get("VITE_SUPABASE_ANON_KEY") or ""
if not (URL and SERVICE and ANON):
    sys.exit("Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (ml-service/.env) "
             "and VITE_SUPABASE_ANON_KEY (frontend/.env)")

PASSWORD = "Verify-" + uuid.uuid4().hex[:16] + "!aA9"


def call(method, path, body=None, key=None, token=None, prefer=None, base="rest/v1"):
    headers = {"apikey": key or ANON, "Content-Type": "application/json"}
    headers["Authorization"] = "Bearer " + (token or key or ANON)
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}/{base}/{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"message": raw[:300]}


# ----------------------------------------------------------------- assertions
FAILS = []
PASSES = 0


def ok(cond, name, detail=""):
    global PASSES
    if cond:
        PASSES += 1
        print(f"  ok   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name}" + (f"\n       {detail}" if detail else ""))


def rows_seen(token, table, query="select=*&limit=2000"):
    status, body = call("GET", f"{table}?{query}", token=token)
    if status != 200:
        return None, (body or {}).get("message", f"HTTP {status}")
    return body, None


# ------------------------------------------------------------------- fixtures
def admin_create_user(email):
    status, body = call("POST", "admin/users", {
        "email": email, "password": PASSWORD, "email_confirm": True,
    }, key=SERVICE, base="auth/v1")
    if status not in (200, 201):
        sys.exit(f"could not create {email}: {status} {body}")
    return body["id"]


def admin_delete_user(uid):
    call("DELETE", f"admin/users/{uid}", key=SERVICE, base="auth/v1")


def sign_in(email):
    status, body = call("POST", "token?grant_type=password",
                        {"email": email, "password": PASSWORD}, base="auth/v1")
    if status != 200:
        sys.exit(f"could not sign in {email}: {status} {body}")
    return body["access_token"]


def service_insert(table, row):
    status, body = call("POST", table, row, key=SERVICE, prefer="return=representation")
    if status not in (200, 201):
        sys.exit(f"fixture insert into {table} failed: {status} {body}")
    return body[0] if isinstance(body, list) else body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="leave the test accounts behind")
    args = ap.parse_args()

    print("Government portal RLS verification")
    print(f"  project {URL}\n")

    # Dimensions, read with the service key -- fixtures only, not under test.
    status, districts = call("GET", "gov_districts?select=id,name&order=name", key=SERVICE)
    if status != 200:
        sys.exit(f"gov_districts unreadable ({status}). Apply the migrations first: {districts}")
    if len(districts) < 2:
        sys.exit("need at least two seeded districts to test cross-district isolation")
    _, crops = call("GET", "gov_crops?select=id,name&limit=1", key=SERVICE)
    _, seasons = call("GET", "gov_seasons?select=id,label&order=label.desc&limit=1", key=SERVICE)

    d_a, d_b = districts[0], districts[1]
    crop_id = crops[0]["id"]
    season_id = seasons[0]["id"]
    print(f"districts under test: A={d_a['name']}  B={d_b['name']}")

    tag = uuid.uuid4().hex[:8]
    users = {}
    try:
        emails = {
            "super": f"rlstest-super-{tag}@example.invalid",
            "mgr_a": f"rlstest-mgra-{tag}@example.invalid",
            "mgr_b": f"rlstest-mgrb-{tag}@example.invalid",
            "officer_a": f"rlstest-offa-{tag}@example.invalid",
            "analyst_a": f"rlstest-ana-{tag}@example.invalid",
            "orphan": f"rlstest-orphan-{tag}@example.invalid",
        }
        for k, e in emails.items():
            users[k] = admin_create_user(e)
        print(f"created {len(users)} throwaway auth users\n")

        # Profiles inserted with the service key: provisioning a super admin is a
        # bootstrap step by design, and the hierarchy's own insert paths are
        # tested separately below.
        service_insert("gov_profiles", {
            "id": users["super"], "full_name": "Test Super", "tier": "super_admin"})
        service_insert("gov_profiles", {
            "id": users["mgr_a"], "full_name": "Test Manager A",
            "tier": "district_manager", "district_id": d_a["id"], "created_by": users["super"]})
        service_insert("gov_profiles", {
            "id": users["mgr_b"], "full_name": "Test Manager B",
            "tier": "district_manager", "district_id": d_b["id"], "created_by": users["super"]})
        service_insert("gov_profiles", {
            "id": users["officer_a"], "full_name": "Test Officer A", "tier": "employee",
            "designation": "agriculture_officer", "district_id": d_a["id"],
            "created_by": users["mgr_a"]})
        service_insert("gov_profiles", {
            "id": users["analyst_a"], "full_name": "Test Analyst A", "tier": "employee",
            "designation": "analyst", "district_id": d_a["id"], "created_by": users["mgr_a"]})
        # 'orphan' deliberately gets NO profile: a valid login with no portal access.

        tok = {k: sign_in(e) for k, e in emails.items()}

        # ---------------------------------------------------------- read scope
        print("read scope")
        for table in ["gov_yield_predictions", "gov_yield_actuals", "gov_satellite_indices",
                      "gov_risk_alerts", "gov_subsidy_recommendations"]:
            seen_super, err_s = rows_seen(tok["super"], table)
            seen_a, err_a = rows_seen(tok["mgr_a"], table)
            if err_s or err_a:
                ok(False, f"{table} readable", f"super={err_s} mgr_a={err_a}")
                continue
            foreign = [r for r in seen_a if r.get("district_id") != d_a["id"]]
            ok(not foreign, f"{table}: district manager sees only their own district",
               f"{len(foreign)} foreign rows leaked")
            ok(len(seen_super) >= len(seen_a),
               f"{table}: super admin sees at least as much as a scoped manager",
               f"super={len(seen_super)} mgr={len(seen_a)}")

        seen_a, _ = rows_seen(tok["mgr_a"], "gov_districts")
        ok(seen_a is not None and len(seen_a) == 1 and seen_a[0]["id"] == d_a["id"],
           "gov_districts: a district manager sees exactly their own district",
           f"saw {[r.get('name') for r in (seen_a or [])]}")

        seen_super, _ = rows_seen(tok["super"], "gov_districts")
        ok(seen_super is not None and len(seen_super) == len(districts),
           "gov_districts: super admin sees every district")

        seen_off, _ = rows_seen(tok["officer_a"], "gov_crops")
        ok(seen_off is not None and len(seen_off) > 0,
           "gov_crops: reference vocabulary readable by an employee")

        # An account with no profile must see nothing anywhere.
        leaked = []
        for table in ["gov_districts", "gov_crops", "gov_yield_actuals", "gov_profiles"]:
            seen, _ = rows_seen(tok["orphan"], table)
            if seen:
                leaked.append(f"{table}:{len(seen)}")
        ok(not leaked, "a signed-in user with no profile reads nothing", ", ".join(leaked))

        # --------------------------------------------- farmer-side isolation
        print("\nfarmer-side isolation")
        for table in ["farms", "satellite_features", "predictions", "alerts", "land_profiles"]:
            seen, _ = rows_seen(tok["super"], table)
            ok(not seen, f"{table}: no government role can read farmer records",
               f"super admin saw {len(seen or [])} rows")

        # ------------------------------------------------- analytics are read-only
        print("\nanalytical tables are read-only from the portal")
        for who in ["super", "mgr_a", "officer_a"]:
            status, body = call("POST", "gov_yield_predictions", {
                "district_id": d_a["id"], "crop_id": crop_id, "season_id": season_id,
                "predicted_yield": 99.0, "model_used": "RLS-TEST", "evaluation": "in_sample",
            }, token=tok[who])
            ok(status >= 400, f"{who} cannot insert a yield prediction",
               f"HTTP {status} {body}")

        status, body = call("PATCH",
                            f"gov_risk_alerts?district_id=eq.{d_a['id']}",
                            {"resolved": True}, token=tok["super"], prefer="return=representation")
        ok(status >= 400 or not body,
           "super admin cannot resolve a pipeline-owned alert", f"HTTP {status} {body}")

        # ----------------------------------------------------- field surveys
        print("\nfield surveys")
        survey = {"crop_id": crop_id, "season_id": season_id, "survey_type": "yield_cut",
                  "verified_yield": 3.2, "harvest_date": "2025-04-01", "status": "pending"}

        status, body = call("POST", "gov_field_surveys",
                            {**survey, "officer_id": users["officer_a"], "district_id": d_a["id"]},
                            token=tok["officer_a"], prefer="return=representation")
        ok(status in (200, 201), "an agriculture officer may submit for their own district",
           f"HTTP {status} {body}")
        survey_id = body[0]["id"] if status in (200, 201) and body else None

        status, body = call("POST", "gov_field_surveys",
                            {**survey, "officer_id": users["analyst_a"], "district_id": d_a["id"]},
                            token=tok["analyst_a"])
        ok(status >= 400, "an analyst may NOT submit a survey (designation gate)",
           f"HTTP {status} {body}")

        status, body = call("POST", "gov_field_surveys",
                            {**survey, "officer_id": users["officer_a"], "district_id": d_b["id"]},
                            token=tok["officer_a"])
        ok(status >= 400, "an officer may NOT submit against another district",
           f"HTTP {status} {body}")

        status, body = call("POST", "gov_field_surveys",
                            {**survey, "officer_id": users["analyst_a"], "district_id": d_a["id"]},
                            token=tok["officer_a"])
        ok(status >= 400, "an officer may NOT file a survey under another officer's name",
           f"HTTP {status} {body}")

        status, body = call("POST", "gov_field_surveys",
                            {**survey, "officer_id": users["officer_a"], "district_id": d_a["id"],
                             "status": "verified"},
                            token=tok["officer_a"])
        ok(status >= 400, "an officer may NOT submit a survey already marked verified",
           f"HTTP {status} {body}")

        if survey_id:
            status, body = call("PATCH", f"gov_field_surveys?id=eq.{survey_id}",
                                {"status": "verified", "reviewed_by": users["mgr_b"]},
                                token=tok["mgr_b"], prefer="return=representation")
            ok(status >= 400 or not body,
               "a manager may NOT verify another district's survey", f"HTTP {status} {body}")

            status, body = call("PATCH", f"gov_field_surveys?id=eq.{survey_id}",
                                {"status": "verified", "reviewed_by": users["mgr_a"]},
                                token=tok["mgr_a"], prefer="return=representation")
            ok(status in (200, 204) and body,
               "a manager may verify their own district's survey", f"HTTP {status} {body}")

            status, body = call("PATCH", f"gov_field_surveys?id=eq.{survey_id}",
                                {"status": "verified", "reviewed_by": users["super"]},
                                token=tok["officer_a"], prefer="return=representation")
            ok(status >= 400 or not body,
               "an officer may NOT verify a survey", f"HTTP {status} {body}")

        # --------------------------------------------------------- datasets
        print("\ndatasets")
        status, body = call("POST", "gov_datasets",
                            {"name": f"rls-test-{tag}", "version": "1",
                             "district_id": d_a["id"], "uploaded_by": users["mgr_a"]},
                            token=tok["mgr_a"], prefer="return=representation")
        ok(status in (200, 201), "a manager may register a dataset for their district",
           f"HTTP {status} {body}")

        status, body = call("POST", "gov_datasets",
                            {"name": f"rls-test-foreign-{tag}", "version": "1",
                             "district_id": d_b["id"], "uploaded_by": users["mgr_a"]},
                            token=tok["mgr_a"])
        ok(status >= 400, "a manager may NOT register a dataset for another district",
           f"HTTP {status} {body}")

        status, body = call("POST", "gov_datasets",
                            {"name": f"rls-test-prov-{tag}", "version": "1",
                             "district_id": None, "uploaded_by": users["mgr_a"]},
                            token=tok["mgr_a"])
        ok(status >= 400, "a manager may NOT register province-wide data",
           f"HTTP {status} {body}")

        status, body = call("POST", "gov_datasets",
                            {"name": f"rls-test-officer-{tag}", "version": "1",
                             "district_id": d_a["id"], "uploaded_by": users["officer_a"]},
                            token=tok["officer_a"])
        ok(status >= 400, "an officer may NOT register a dataset", f"HTTP {status} {body}")

        # --------------------------------------------------------- hierarchy
        print("\nthe provisioning hierarchy")
        probe = uuid.uuid4().hex[:8]
        tmp = admin_create_user(f"rlstest-tmp-{probe}@example.invalid")
        users["tmp"] = tmp

        status, body = call("POST", "gov_profiles",
                            {"id": tmp, "full_name": "Probe", "tier": "employee",
                             "designation": "analyst", "district_id": d_a["id"],
                             "created_by": users["mgr_a"]},
                            token=tok["mgr_a"], prefer="return=representation")
        ok(status in (200, 201), "a manager may create an employee in their own district",
           f"HTTP {status} {body}")
        if status in (200, 201):
            call("DELETE", f"gov_profiles?id=eq.{tmp}", key=SERVICE)

        status, body = call("POST", "gov_profiles",
                            {"id": tmp, "full_name": "Probe", "tier": "employee",
                             "designation": "analyst", "district_id": d_b["id"],
                             "created_by": users["mgr_a"]},
                            token=tok["mgr_a"])
        ok(status >= 400, "a manager may NOT create an employee in another district",
           f"HTTP {status} {body}")

        status, body = call("POST", "gov_profiles",
                            {"id": tmp, "full_name": "Probe", "tier": "district_manager",
                             "district_id": d_a["id"], "created_by": users["mgr_a"]},
                            token=tok["mgr_a"])
        ok(status >= 400, "a manager may NOT create another district manager",
           f"HTTP {status} {body}")

        status, body = call("POST", "gov_profiles",
                            {"id": tmp, "full_name": "Probe", "tier": "super_admin",
                             "created_by": users["mgr_a"]},
                            token=tok["mgr_a"])
        ok(status >= 400, "a manager may NOT create a super admin", f"HTTP {status} {body}")

        status, body = call("POST", "gov_profiles",
                            {"id": tmp, "full_name": "Probe", "tier": "district_manager",
                             "district_id": d_a["id"], "created_by": users["super"]},
                            token=tok["super"], prefer="return=representation")
        ok(status in (200, 201), "a super admin may create a district manager",
           f"HTTP {status} {body}")
        if status in (200, 201):
            call("DELETE", f"gov_profiles?id=eq.{tmp}", key=SERVICE)

        status, body = call("POST", "gov_profiles",
                            {"id": tmp, "full_name": "Probe", "tier": "district_manager",
                             "district_id": d_a["id"], "created_by": users["super"]},
                            token=tok["officer_a"])
        ok(status >= 400, "an employee may create nobody", f"HTTP {status} {body}")

        status, body = call("POST", "gov_profiles",
                            {"id": tmp, "full_name": "Forged", "tier": "district_manager",
                             "district_id": d_a["id"], "created_by": users["mgr_b"]},
                            token=tok["super"])
        ok(status >= 400, "created_by cannot be forged to another account",
           f"HTTP {status} {body}")

        # ------------------------------------------------- self-escalation
        print("\nself-escalation")
        for who, patch, label in [
            ("officer_a", {"designation": "district_officer"},
             "an employee cannot change their own designation"),
            ("officer_a", {"tier": "district_manager"},
             "an employee cannot promote themselves to manager"),
            ("officer_a", {"district_id": d_b["id"]},
             "an employee cannot move themselves to another district"),
            ("mgr_a", {"tier": "super_admin", "district_id": None},
             "a manager cannot promote themselves to super admin"),
            ("mgr_a", {"district_id": d_b["id"]},
             "a manager cannot move themselves to another district"),
            ("mgr_a", {"full_name": "Renamed"},
             "a manager cannot even edit their own name"),
            ("super", {"full_name": "Renamed"},
             "a super admin cannot edit their own row either"),
        ]:
            status, body = call("PATCH", f"gov_profiles?id=eq.{users[who]}", patch,
                                token=tok[who], prefer="return=representation")
            ok(status >= 400 or not body, label, f"HTTP {status} {body}")

        status, body = call("PATCH", f"gov_profiles?id=eq.{users['officer_a']}",
                            {"tier": "district_manager", "designation": None},
                            token=tok["mgr_a"], prefer="return=representation")
        ok(status >= 400 or not body,
           "a manager cannot promote their own employee to manager", f"HTTP {status} {body}")

        status, body = call("PATCH", f"gov_profiles?id=eq.{users['officer_a']}",
                            {"district_id": d_b["id"]},
                            token=tok["mgr_a"], prefer="return=representation")
        ok(status >= 400 or not body,
           "a manager cannot move their employee out of their district", f"HTTP {status} {body}")

        status, body = call("PATCH", f"gov_profiles?id=eq.{users['officer_a']}",
                            {"designation": "district_officer"},
                            token=tok["mgr_a"], prefer="return=representation")
        ok(status in (200, 204) and body,
           "a manager CAN change their own employee's designation", f"HTTP {status} {body}")

        status, body = call("PATCH", f"gov_profiles?id=eq.{users['officer_a']}",
                            {"status": "deactivated"},
                            token=tok["mgr_b"], prefer="return=representation")
        ok(status >= 400 or not body,
           "a manager cannot deactivate another district's employee", f"HTTP {status} {body}")

        # -------------------------------------------- deactivation cuts access
        print("\ndeactivation withdraws access")
        call("PATCH", f"gov_profiles?id=eq.{users['analyst_a']}",
             {"status": "deactivated"}, key=SERVICE)
        seen, _ = rows_seen(tok["analyst_a"], "gov_yield_actuals")
        ok(not seen, "a deactivated account reads nothing",
           f"still saw {len(seen or [])} rows")
        seen, _ = rows_seen(tok["analyst_a"], "gov_districts")
        ok(not seen, "a deactivated account cannot even list districts")

        # ----------------------------------------------- profile visibility
        print("\nprofile visibility")
        seen, _ = rows_seen(tok["officer_a"], "gov_profiles")
        ok(seen is not None and len(seen) >= 1
           and all(r["district_id"] in (d_a["id"], None) for r in seen)
           and not any(r["tier"] == "super_admin" for r in seen),
           "an employee sees no super admin and no other district's accounts",
           f"saw {[(r['full_name'], r['tier']) for r in (seen or [])]}")

        seen, _ = rows_seen(tok["mgr_b"], "gov_profiles")
        foreign = [r for r in (seen or []) if r["district_id"] not in (d_b["id"],)]
        ok(not foreign, "manager B sees no account outside district B",
           f"leaked {[(r['full_name'], r['tier']) for r in foreign]}")

    finally:
        if args.keep:
            print("\n--keep: leaving test accounts in place")
        else:
            print("\ncleaning up")
            # ORDER MATTERS, and getting it wrong is how an earlier run left two
            # accounts and a survey behind in the real database.
            #
            # gov_field_surveys.officer_id is ON DELETE RESTRICT, so a profile
            # cannot be removed while one of its surveys exists -- and deleting
            # the auth user cascades to the profile, so that fails for the same
            # reason. The rows the test CREATED therefore have to go first, in
            # dependency order: surveys and datasets, then profiles, then logins.
            #
            # Failures are no longer swallowed either. A silent 409 here means
            # test fixtures stay in a production table, which is worse than a
            # loud error.
            problems = []

            def wipe(label, path):
                status, body = call("DELETE", path, key=SERVICE)
                if status >= 400:
                    problems.append(f"{label}: HTTP {status} {body}")

            for uid in users.values():
                wipe("surveys", f"gov_field_surveys?officer_id=eq.{uid}")
            wipe("datasets", "gov_datasets?name=like.rls-test-*")
            for uid in users.values():
                wipe("profile", f"gov_profiles?id=eq.{uid}")
            for uid in users.values():
                status, body = call("DELETE", f"admin/users/{uid}",
                                    key=SERVICE, base="auth/v1")
                if status >= 400:
                    problems.append(f"auth user {uid}: HTTP {status} {body}")

            # Prove it, rather than assuming the deletes landed. Read with the
            # service key so RLS cannot hide a surviving row and make the check
            # look clean.
            ids = ",".join(users.values())
            status, left_p = call("GET", f"gov_profiles?select=id&id=in.({ids})", key=SERVICE)
            if status == 200 and left_p:
                problems.append(f"{len(left_p)} test profile(s) still present")

            if problems:
                print("  CLEANUP INCOMPLETE -- test data remains in the database:")
                for p in problems:
                    print("    " + p)
                print("  Remove it before relying on any row count from these tables.")
                FAILS.append("cleanup left test data behind")
            else:
                print(f"  removed {len(users)} test accounts and their fixtures")

    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print("\nFAILED:")
        for f in FAILS:
            print("  - " + f)
        sys.exit(1)
    print("\nALL ACCESS-CONTROL BOUNDARIES HOLD")


if __name__ == "__main__":
    main()
