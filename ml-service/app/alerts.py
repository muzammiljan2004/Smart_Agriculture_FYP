"""Alert rules + Gmail delivery.

Two rules, both threshold comparisons against a district baseline:

  drought    farm NDWI is >15% below the district's historical mean NDWI
  low_yield  predicted yield is >20% below the district's average yield

Thresholds live in one place so they can be tuned without touching the trigger
logic, and the logic itself does not care whether the baselines came from
synthetic rows or real ones -- swapping in real data changes how often these
fire, not how they work.
"""
import os
import smtplib
from email.message import EmailMessage

from app.db import db

DROUGHT_NDWI_DROP = 0.15    # 15% below district mean NDWI
LOW_YIELD_DROP = 0.20       # 20% below district average yield


def district_mean_ndwi(district: str, exclude_farm_id: str | None = None) -> float | None:
    """Historical mean NDWI across the OTHER farms in the district.

    Excluding the farm under evaluation is not a refinement, it is required.
    Include it and a district with one farm compares that farm against itself,
    so the drop is always 0% and drought can never fire; with a handful of
    farms it still drags the baseline toward the subject and mutes the signal.

    Returns None when there are no peers -- honest, because with nothing to
    compare against there is no such thing as "below the district average".

    ponytail: this is a district-wide, all-seasons mean, not the per-growth-
    stage baseline the spec asks for -- we have no stage-tagged history yet, so
    a stage-specific average would be computed from one or two rows and would
    be noise wearing a precise-looking number. Upgrade once satellite_features
    spans several seasons: bucket rows by growth_stage(date - planting_date).
    """
    farms = db().table("farms").select("id").eq("district", district).execute()
    ids = [f["id"] for f in (farms.data or []) if f["id"] != exclude_farm_id]
    if not ids:
        return None

    rows = (
        db().table("satellite_features")
        .select("ndwi")
        .in_("farm_id", ids)
        .not_.is_("ndwi", "null")
        .execute()
    )
    vals = [r["ndwi"] for r in (rows.data or []) if r["ndwi"] is not None]
    return sum(vals) / len(vals) if vals else None


def evaluate(farm: dict, prediction, features: dict) -> list[dict]:
    """Which alerts SHOULD be open for this farm right now.

    Pure: reads baselines, returns dicts. Persisting is a separate step so the
    rules can be unit-tested without a database write.
    """
    out = []
    district = farm["district"]

    # --- drought -----------------------------------------------------------
    baseline = district_mean_ndwi(district, exclude_farm_id=farm.get("id"))
    ndwi = features.get("ndwi")
    if baseline and baseline > 0 and ndwi is not None:
        drop = (baseline - ndwi) / baseline
        if drop > DROUGHT_NDWI_DROP:
            out.append({
                "type": "drought",
                "severity": "critical" if drop > 0.30 else "warning",
                "message": (
                    f"Canopy water (NDWI {ndwi:.3f}) is {drop * 100:.0f}% below the "
                    f"{district} average of {baseline:.3f}. Check irrigation."
                ),
            })

    # --- low yield ---------------------------------------------------------
    avg = prediction.district_average
    if avg and avg > 0:
        drop = (avg - prediction.predicted_yield) / avg
        if drop > LOW_YIELD_DROP:
            out.append({
                "type": "low_yield",
                "severity": "critical" if drop > 0.35 else "warning",
                "message": (
                    f"Predicted yield {prediction.predicted_yield} t/ha is "
                    f"{drop * 100:.0f}% below the {district} average of {avg} t/ha."
                ),
            })

    return out


def sync(farm: dict, candidates: list[dict]) -> list[dict]:
    """Open new alerts, auto-resolve ones whose condition has cleared.

    Auto-resolution matters: an alert that never clears trains the farmer to
    ignore the whole feature. The partial unique index in the migration means
    re-opening an already-open alert is a no-op rather than a duplicate row.
    """
    existing = (
        db().table("alerts")
        .select("id, type")
        .eq("farm_id", farm["id"])
        .eq("resolved", False)
        .execute()
    ).data or []

    open_types = {a["type"] for a in existing}
    want_types = {c["type"] for c in candidates}

    for c in candidates:
        if c["type"] in open_types:
            continue
        row = db().table("alerts").insert({
            "farm_id": farm["id"], "type": c["type"],
            "message": c["message"], "severity": c["severity"],
        }).execute()
        send_email(farm, c)
        if row.data:
            db().table("alerts").update({"emailed_at": "now()"}).eq("id", row.data[0]["id"]).execute()

    # Condition no longer met -> close it.
    for a in existing:
        if a["type"] not in want_types:
            db().table("alerts").update(
                {"resolved": True, "resolved_at": "now()"}
            ).eq("id", a["id"]).execute()

    return (
        db().table("alerts")
        .select("*")
        .eq("farm_id", farm["id"])
        .eq("resolved", False)
        .order("triggered_at", desc=True)
        .execute()
    ).data or []


def owner_email(owner_id: str) -> str | None:
    try:
        return db().auth.admin.get_user_by_id(owner_id).user.email
    except Exception:
        return None


def send_email(farm: dict, alert: dict) -> bool:
    """Gmail SMTP. Returns False (without raising) when unconfigured.

    Alerts are stored in the database whether or not mail goes out -- an SMTP
    outage must not silently discard the alert itself, which is the part the
    dashboard reads.
    """
    user = os.getenv("GMAIL_USER")
    password = os.getenv("GMAIL_APP_PASSWORD")
    if not user or not password:
        print(f"[alerts] {alert['type']} for {farm['farmer_name']}: stored, email not sent "
              f"(GMAIL_USER / GMAIL_APP_PASSWORD not set)")
        return False

    to = os.getenv("ALERT_TO") or owner_email(farm["owner_id"])
    if not to:
        print(f"[alerts] no recipient for farm {farm['id']}; stored only")
        return False

    msg = EmailMessage()
    msg["Subject"] = f"[Smart Agriculture] {alert['type'].replace('_', ' ').title()} - {farm['farmer_name']}"
    msg["From"] = user
    msg["To"] = to
    msg.set_content(
        f"{alert['message']}\n\n"
        f"Farm:     {farm['farmer_name']}\n"
        f"District: {farm['district']}\n"
        f"Crop:     {farm['crop_type']}\n\n"
        f"This is a preliminary system running on a synthetic model. "
        f"Treat it as indicative, not as agronomic advice.\n"
    )

    try:
        # Port 587 + STARTTLS. Gmail requires an APP PASSWORD (16 chars, from
        # a Google account with 2FA on); a normal account password is rejected.
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=20) as s:
            s.starttls()
            s.login(user, password)
            s.send_message(msg)
        print(f"[alerts] emailed {alert['type']} to {to}")
        return True
    except Exception as e:
        print(f"[alerts] email failed ({e}); alert still stored")
        return False


if __name__ == "__main__":
    # Self-check for the rules only -- no database, no SMTP.
    class P:
        predicted_yield = 2.0
        district_average = 3.2

    farm = {"id": "x", "district": "Okara", "farmer_name": "T", "crop_type": "wheat", "owner_id": "o"}

    # Patch THIS module's globals, not app.alerts'. Under `python -m app.alerts`
    # this file runs as __main__, so `import app.alerts` would load a second,
    # separate copy and stubbing it would have no effect here.
    globals()["district_mean_ndwi"] = lambda d, exclude_farm_id=None: 0.30

    a = evaluate(farm, P, {"ndwi": 0.20})          # 33% below -> critical drought
    types = {x["type"]: x for x in a}
    assert "drought" in types and types["drought"]["severity"] == "critical", a
    assert "low_yield" in types, a                 # 2.0 vs 3.2 = 37.5% below

    a = evaluate(farm, P, {"ndwi": 0.29})          # 3% below -> no drought
    assert "drought" not in {x["type"] for x in a}, a

    class Q:
        predicted_yield = 3.1
        district_average = 3.2
    a = evaluate(farm, Q, {"ndwi": 0.29})          # both within threshold
    assert a == [], a

    print("alerts self-check OK")
