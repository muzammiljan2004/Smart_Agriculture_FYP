"""Prove the researcher portal's access control against the live database.

    python -m scripts.verify_research_rls            # run, then clean up
    python -m scripts.verify_research_rls --keep     # leave the fixtures in place

Creates five throwaway accounts -- a research lead and four researchers with
every combination of the two capability flags -- signs in as each with the ANON
key exactly as a browser does, and asserts what each can and cannot read and
write. Then deletes them.

WHY THIS EXISTS, and why scripts/research-selfcheck.mjs is not enough. That one
runs offline: it proves the UI's predicates mirror what the SQL SAYS. This one
proves what Postgres DOES. A policy that reads correctly is not a policy that
works -- a NULL on either side of a comparison, a missing WITH CHECK, a
recursive subquery on research_profiles, or a revoke that landed before its
grant all produce a migration that applies cleanly and then either leaks rows or
refuses everyone.

It runs as the test users themselves, never as service_role, except to create
and delete the fixtures. A test that checked these rules with the service key
would pass no matter how broken the policies were, because service_role bypasses
RLS entirely.

THE SHARPEST CASES, the ones this script exists for:

  * a researcher holding BOTH flags still cannot promote a model
  * a researcher with can_run_models cannot insert a training row
  * nobody can insert a training row with status anything but 'candidate'
  * nobody can insert a run that is already 'completed' with metrics attached
  * nobody can update their own flags or tier, including the lead and the admin
  * a lead cannot create another lead
  * no tier can write gov_yield_predictions or gov_satellite_indices
  * a researcher cannot read public.farms at all
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
TAG = "restest-" + uuid.uuid4().hex[:8]


def call(method, path, body=None, key=None, token=None, prefer=None, base="rest/v1"):
    headers = {"apikey": key or ANON, "Content-Type": "application/json"}
    headers["Authorization"] = "Bearer " + (token or key or ANON)
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}/{base}/{path}", data=data,
                                 headers=headers, method=method)
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
        print(f"  FAIL {name}" + (f"  -- {detail}" if detail else ""))


def denied(status, body):
    """True when PostgREST refused the write.

    401/403 is an outright refusal; 404 is RLS hiding the row from an UPDATE so
    there is nothing to update; a 400 carrying a policy violation is an INSERT
    refused by WITH CHECK. Treating only 403 as "denied" would let a silent
    no-op update pass as if it had been blocked.
    """
    if status in (401, 403, 404):
        return True
    msg = json.dumps(body or {}).lower()
    return status == 400 and ("row-level security" in msg or "violates" in msg)


# ------------------------------------------------------------------ fixtures

def make_user(label):
    email = f"{TAG}-{label}@example.invalid"
    status, body = call("POST", "admin/users", {
        "email": email, "password": PASSWORD, "email_confirm": True,
    }, key=SERVICE, base="auth/v1")
    if status >= 400:
        sys.exit(f"could not create {email}: HTTP {status} {body}")
    return body["id"], email


def sign_in(email):
    status, body = call("POST", "token?grant_type=password",
                        {"email": email, "password": PASSWORD}, base="auth/v1")
    if status >= 400:
        sys.exit(f"could not sign in {email}: HTTP {status} {body}")
    return body["access_token"]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--keep", action="store_true",
                    help="leave the test accounts and rows in the database")
    args = ap.parse_args()

    # Fail fast and legibly if the policies were never applied. Without this the
    # whole run reports dozens of confusing failures that all mean one thing.
    status, body = call("GET", "research_profiles?select=id&limit=1", key=SERVICE)
    if status == 404:
        sys.exit("public.research_profiles does not exist -- apply "
                 "supabase/migrations/20261004100000_research_portal_schema.sql first")

    print(f"\nfixtures  (tag {TAG})")
    users, emails, tokens = {}, {}, {}
    for label in ("lead", "both", "runner", "trainer", "none"):
        uid, email = make_user(label)
        users[label], emails[label] = uid, email
        print(f"  created {label:8s} {uid[:8]}  {email}")

    # Profiles are seeded with the SERVICE key: provisioning is itself under
    # test later, and a fixture that depended on the policy being right could
    # not distinguish "the policy is broken" from "the fixture failed".
    rows = [
        {"id": users["lead"], "full_name": f"{TAG} lead", "tier": "research_lead",
         "can_run_models": True, "can_train_models": True, "status": "active"},
        {"id": users["both"], "full_name": f"{TAG} both", "tier": "researcher",
         "can_run_models": True, "can_train_models": True, "status": "active",
         "created_by": users["lead"]},
        {"id": users["runner"], "full_name": f"{TAG} runner", "tier": "researcher",
         "can_run_models": True, "can_train_models": False, "status": "active",
         "created_by": users["lead"]},
        {"id": users["trainer"], "full_name": f"{TAG} trainer", "tier": "researcher",
         "can_run_models": False, "can_train_models": True, "status": "active",
         "created_by": users["lead"]},
        {"id": users["none"], "full_name": f"{TAG} none", "tier": "researcher",
         "can_run_models": False, "can_train_models": False, "status": "active",
         "created_by": users["lead"]},
    ]
    st, bd = call("POST", "research_profiles", rows, key=SERVICE, prefer="return=representation")
    if st >= 400:
        sys.exit(f"could not seed profiles: HTTP {st} {bd}")

    for label, email in emails.items():
        tokens[label] = sign_in(email)

    # A validated dataset version and one trained version, as the things the
    # action tests point at. Service key again, for the same reason.
    st, ds = call("POST", "dataset_versions", {
        "description": f"{TAG} fixture dataset",
        "storage_path": f"research/{TAG}.csv",
        "record_count": 10, "schema_validated": True,
        "uploaded_by": users["lead"],
    }, key=SERVICE, prefer="return=representation")
    if st >= 400:
        sys.exit(f"could not seed dataset_version: HTTP {st} {ds}")
    dataset_id = ds[0]["id"]

    st, mv = call("POST", "model_runs", {
        "run_kind": "training", "model_type": "RandomForest",
        "version_label": f"{TAG}-v1", "status": "candidate",
        "job_status": "completed", "output_type": "regression", "r2": 0.5,
        "dataset_version_id": dataset_id, "triggered_by": users["lead"],
    }, key=SERVICE, prefer="return=representation")
    if st >= 400:
        sys.exit(f"could not seed model version: HTTP {st} {mv}")
    version_id = mv[0]["id"]
    print(f"  seeded  dataset {dataset_id[:8]}  version {version_id[:8]}")

    T = lambda label: {"token": tokens[label]}  # noqa: E731 - terse on purpose

    # --------------------------------------------------------------- reads
    print("\nreads: every active account sees the analytical tables")
    for label in ("lead", "both", "runner", "trainer", "none"):
        st, bd = call("GET", "model_runs?select=id&limit=5", **T(label))
        ok(st == 200 and isinstance(bd, list) and len(bd) >= 1,
           f"{label} reads model_runs", f"HTTP {st} {bd}")
        st, bd = call("GET", "dataset_versions?select=id&limit=5", **T(label))
        ok(st == 200 and bd, f"{label} reads dataset_versions", f"HTTP {st} {bd}")
        st, bd = call("GET", "benchmark_references?select=id&limit=1", **T(label))
        ok(st == 200, f"{label} reads benchmark_references", f"HTTP {st} {bd}")

    print("\nreads: the flagless account is not shut out of results")
    st, bd = call("GET", "model_runs?select=id,r2&limit=5", **T("none"))
    ok(st == 200 and bd, "a researcher with NEITHER flag still reads completed runs",
       f"HTTP {st} {bd}")

    print("\nreads: upstream dimensions and aggregates")
    for table in ("gov_districts", "gov_crops", "gov_seasons",
                  "gov_satellite_indices", "gov_yield_predictions"):
        st, bd = call("GET", f"{table}?select=id&limit=1", **T("none"))
        ok(st == 200, f"researcher reads {table}", f"HTTP {str(st)} {bd}")

    print("\nreads: individual farm records never cross over")
    st, bd = call("GET", "farms?select=id&limit=1", **T("lead"))
    ok(st != 200 or bd == [], "no research tier can read public.farms",
       f"HTTP {st} {bd}")

    print("\nreads: profile visibility is scoped")
    st, bd = call("GET", "research_profiles?select=id,full_name", **T("none"))
    ok(st == 200 and len(bd or []) == 1 and bd[0]["id"] == users["none"],
       "a researcher sees only their own profile row", f"HTTP {st} got {len(bd or [])}")
    st, bd = call("GET", "research_profiles?select=id", **T("lead"))
    got = {r["id"] for r in (bd or [])}
    ok(st == 200 and users["both"] in got and users["none"] in got,
       "a lead sees the researchers they created", f"HTTP {st} {bd}")

    # ------------------------------------------------------------ ACTION A
    print("\nACTION A: run/evaluate requires can_run_models")
    evaluation = {
        "run_kind": "evaluation", "model_type": "RandomForest",
        "models_selected": [version_id], "dataset_version_id": dataset_id,
        "job_status": "queued", "run_config": {"output_type": "regression"},
    }
    created_runs = []
    for label, should in (("runner", True), ("both", True), ("lead", True),
                          ("trainer", False), ("none", False)):
        body = dict(evaluation, triggered_by=users[label])
        st, bd = call("POST", "model_runs", body, prefer="return=representation", **T(label))
        if should:
            ok(st in (200, 201), f"{label} CAN queue an evaluation", f"HTTP {st} {bd}")
            if st in (200, 201) and bd:
                created_runs.append(bd[0]["id"])
        else:
            ok(denied(st, bd), f"{label} CANNOT queue an evaluation (no can_run_models)",
               f"HTTP {st} {bd}")

    print("\nACTION A: attribution cannot be forged")
    st, bd = call("POST", "model_runs", dict(evaluation, triggered_by=users["lead"]),
                  **T("runner"))
    ok(denied(st, bd), "a runner cannot attribute a run to the lead", f"HTTP {st} {bd}")

    print("\nACTION A: metrics cannot be fabricated")
    st, bd = call("POST", "model_runs",
                  dict(evaluation, triggered_by=users["runner"],
                       job_status="completed", r2=0.99, output_type="regression"),
                  **T("runner"))
    ok(denied(st, bd),
       "a completed evaluation with r2=0.99 cannot be inserted directly",
       f"HTTP {st} {bd}")
    st, bd = call("POST", "model_runs",
                  dict(evaluation, triggered_by=users["runner"], status="candidate"),
                  **T("runner"))
    ok(denied(st, bd), "an evaluation cannot be given a status", f"HTTP {st} {bd}")

    # ------------------------------------------------------------ ACTION B
    print("\nACTION B: train/retrain requires can_train_models")
    training = {
        "run_kind": "training", "model_type": "RandomForest",
        "dataset_version_id": dataset_id, "job_status": "queued",
        "status": "candidate", "run_config": {"train_split": 0.8},
    }
    for label, should in (("trainer", True), ("both", True), ("lead", True),
                          ("runner", False), ("none", False)):
        body = dict(training, triggered_by=users[label])
        st, bd = call("POST", "model_runs", body, prefer="return=representation", **T(label))
        if should:
            ok(st in (200, 201), f"{label} CAN queue a training", f"HTTP {st} {bd}")
            if st in (200, 201) and bd:
                created_runs.append(bd[0]["id"])
        else:
            ok(denied(st, bd), f"{label} CANNOT queue a training (no can_train_models)",
               f"HTTP {st} {bd}")

    print("\nACTION B: a training can only ever be a candidate")
    for bad in ("approved", "production", "archived"):
        st, bd = call("POST", "model_runs",
                      dict(training, triggered_by=users["trainer"], status=bad),
                      **T("trainer"))
        ok(denied(st, bd), f"a trainer cannot insert a training with status={bad}",
           f"HTTP {st} {bd}")

    print("\nACTION B: dataset upload tracks can_train_models")
    reg = {"description": f"{TAG} client-registered", "storage_path": f"research/{TAG}-c.csv",
           "record_count": 0, "schema_validated": False}
    st, bd = call("POST", "dataset_versions", dict(reg, uploaded_by=users["trainer"]),
                  prefer="return=representation", **T("trainer"))
    ok(st in (200, 201), "a trainer CAN register a dataset version", f"HTTP {st} {bd}")
    extra_ds = bd[0]["id"] if st in (200, 201) and bd else None
    st, bd = call("POST", "dataset_versions", dict(reg, uploaded_by=users["runner"]),
                  **T("runner"))
    ok(denied(st, bd), "a runner CANNOT register a dataset version", f"HTTP {st} {bd}")
    st, bd = call("POST", "dataset_versions",
                  dict(reg, uploaded_by=users["trainer"], schema_validated=True),
                  **T("trainer"))
    ok(denied(st, bd), "a client cannot declare its own upload schema-validated",
       f"HTTP {st} {bd}")

    # ------------------------------------------------------------ ACTION C
    print("\nACTION C: promotion is a tier, never a flag")
    for label in ("both", "runner", "trainer", "none"):
        st, bd = call("PATCH", f"model_runs?id=eq.{version_id}",
                      {"status": "approved"}, **T(label))
        # A refused UPDATE can also come back 200 with an empty array -- USING
        # hid the row, so nothing matched. Both count as denied.
        blocked = denied(st, bd) or (st in (200, 204) and bd in ([], None))
        ok(blocked, f"{label} CANNOT promote a model", f"HTTP {st} {bd}")
    st, bd = call("GET", f"model_runs?id=eq.{version_id}&select=status", key=SERVICE)
    ok(bd and bd[0]["status"] == "candidate",
       "the version is still a candidate after every refused promotion",
       f"status={bd and bd[0].get('status')}")

    st, bd = call("PATCH", f"model_runs?id=eq.{version_id}", {"status": "approved"},
                  prefer="return=representation", **T("lead"))
    ok(st in (200, 204) and (bd is None or bd), "a lead CAN promote candidate -> approved",
       f"HTTP {st} {bd}")

    print("\nACTION C: a lead may change status and nothing else")
    st, bd = call("PATCH", f"model_runs?id=eq.{version_id}", {"r2": 0.99}, **T("lead"))
    ok(denied(st, bd) or st == 400,
       "a lead CANNOT rewrite a metric (column grant is status-only)", f"HTTP {st} {bd}")
    st, bd = call("GET", f"model_runs?id=eq.{version_id}&select=r2", key=SERVICE)
    ok(bd and abs(float(bd[0]["r2"]) - 0.5) < 1e-9, "r2 is unchanged at 0.5",
       f"r2={bd and bd[0].get('r2')}")

    print("\nACTION C: the audit trail is written by the trigger")
    st, bd = call("GET", f"model_status_history?model_run_id=eq.{version_id}"
                         "&select=old_status,new_status,changed_by", key=SERVICE)
    ok(st == 200 and any(r["new_status"] == "approved" for r in bd or []),
       "the promotion was recorded in model_status_history", f"HTTP {st} {bd}")
    ok(any(r.get("changed_by") == users["lead"] for r in bd or []),
       "the trail attributes the change to the lead who made it", f"{bd}")
    st, bd = call("POST", "model_status_history",
                  {"model_run_id": version_id, "new_status": "production"}, **T("lead"))
    ok(denied(st, bd), "nobody can write the audit trail by hand", f"HTTP {st} {bd}")

    print("\nACTION C: an evaluation can never be promoted")
    if created_runs:
        st, bd = call("GET", f"model_runs?id=eq.{created_runs[0]}&select=run_kind", key=SERVICE)
        if bd and bd[0]["run_kind"] == "evaluation":
            st, bd = call("PATCH", f"model_runs?id=eq.{created_runs[0]}",
                          {"status": "approved"}, **T("lead"))
            blocked = denied(st, bd) or (st in (200, 204) and bd in ([], None))
            ok(blocked, "even a lead cannot give an evaluation row a status",
               f"HTTP {st} {bd}")

    # ------------------------------------------------------- self-escalation
    print("\nnobody edits their own account")
    for label in ("none", "runner", "trainer", "both", "lead"):
        st, bd = call("PATCH", f"research_profiles?id=eq.{users[label]}",
                      {"can_train_models": True, "can_run_models": True}, **T(label))
        blocked = denied(st, bd) or (st in (200, 204) and bd in ([], None))
        ok(blocked, f"{label} cannot grant themselves flags", f"HTTP {st} {bd}")
        st, bd = call("PATCH", f"research_profiles?id=eq.{users[label]}",
                      {"tier": "super_admin"}, **T(label))
        blocked = denied(st, bd) or (st in (200, 204) and bd in ([], None))
        ok(blocked, f"{label} cannot raise their own tier", f"HTTP {st} {bd}")

    st, bd = call("GET", f"research_profiles?id=eq.{users['none']}"
                         "&select=can_run_models,can_train_models,tier", key=SERVICE)
    r = (bd or [{}])[0]
    ok(r.get("can_run_models") is False and r.get("can_train_models") is False
       and r.get("tier") == "researcher",
       "the flagless account still has no flags and is still a researcher", f"{r}")

    # ----------------------------------------------------------- provisioning
    print("\nprovisioning respects the hierarchy")
    newbie, newbie_email = make_user("newbie")
    st, bd = call("POST", "research_profiles", {
        "id": newbie, "full_name": f"{TAG} newbie", "tier": "researcher",
        "can_run_models": True, "can_train_models": False,
        "created_by": users["lead"], "status": "active",
    }, prefer="return=representation", **T("lead"))
    ok(st in (200, 201), "a lead CAN create a researcher", f"HTTP {st} {bd}")

    st, bd = call("POST", "research_profiles", {
        "id": newbie, "full_name": "x", "tier": "research_lead",
        "can_run_models": True, "can_train_models": True,
        "created_by": users["lead"], "status": "active",
    }, **T("lead"))
    ok(denied(st, bd) or st == 409, "a lead CANNOT create another lead", f"HTTP {st} {bd}")

    st, bd = call("POST", "research_profiles", {
        "id": newbie, "full_name": "x", "tier": "researcher",
        "created_by": users["lead"], "status": "active",
    }, **T("both"))
    ok(denied(st, bd) or st == 409, "a researcher CANNOT create an account",
       f"HTTP {st} {bd}")

    print("\nupstream tables are read-only from this portal")
    for table, row in (
        ("gov_yield_predictions", {"predicted_yield": 1}),
        ("gov_satellite_indices", {"ndvi": 0.5}),
    ):
        st, bd = call("GET", f"{table}?select=id&limit=1", key=SERVICE)
        if st == 200 and bd:
            rid = bd[0]["id"]
            st, bd = call("PATCH", f"{table}?id=eq.{rid}", row, **T("lead"))
            blocked = denied(st, bd) or (st in (200, 204) and bd in ([], None))
            ok(blocked, f"a lead cannot write {table}", f"HTTP {st} {bd}")

    print("\nanon sees nothing")
    for table in ("research_profiles", "model_runs", "dataset_versions",
                  "model_status_history"):
        st, bd = call("GET", f"{table}?select=id&limit=1")
        ok(st != 200 or bd == [], f"anon reads nothing from {table}", f"HTTP {st} {bd}")

    # ------------------------------------------------------------- cleanup
    if args.keep:
        print(f"\n--keep: fixtures left in place, tag {TAG}, password {PASSWORD}")
    else:
        print("\ncleanup")
        problems = []

        def wipe(label, path):
            st, bd = call("DELETE", path, key=SERVICE)
            if st >= 400:
                problems.append(f"{label}: HTTP {st} {bd}")

        ids = list(users.values()) + [newbie]
        # ORDER MATTERS. model_runs.dataset_version_id is ON DELETE RESTRICT, so
        # every run has to go before the datasets it points at. Logs and status
        # history cascade from model_runs and need no separate delete.
        for rid in created_runs + [version_id]:
            wipe("run", f"model_runs?id=eq.{rid}")
        wipe("extra runs", f"model_runs?version_label=like.{TAG}*")
        if extra_ds:
            wipe("dataset", f"dataset_versions?id=eq.{extra_ds}")
        wipe("dataset", f"dataset_versions?description=like.{TAG}*")
        for uid in ids:
            wipe("profile", f"research_profiles?id=eq.{uid}")
        for uid in ids:
            st, bd = call("DELETE", f"admin/users/{uid}", key=SERVICE, base="auth/v1")
            if st >= 400:
                problems.append(f"auth user {uid[:8]}: HTTP {st} {bd}")

        # VERIFY the cleanup, with the service key. An earlier version of the
        # government portal's script swallowed its delete errors and left test
        # accounts in the live database; the failure was invisible because
        # nothing read back afterwards.
        st, left = call("GET", f"research_profiles?full_name=like.{TAG}*&select=id", key=SERVICE)
        if left:
            problems.append(f"{len(left)} research_profiles row(s) still present")
        st, left = call("GET", f"dataset_versions?description=like.{TAG}*&select=id", key=SERVICE)
        if left:
            problems.append(f"{len(left)} dataset_versions row(s) still present")

        if problems:
            for p in problems:
                print(f"  FAIL cleanup -- {p}")
            FAILS.extend(f"cleanup: {p}" for p in problems)
        else:
            print("  ok   every fixture removed, verified by read-back")

    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print("\nfailures:")
        for f in FAILS:
            print("  - " + f)
        print("\nIf nearly everything failed, the RLS migration is probably not applied:\n"
              "  supabase/migrations/20261004100100_research_portal_rls.sql")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
