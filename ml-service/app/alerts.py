"""Alert rules + Gmail delivery.

Two rules, both threshold comparisons against a district baseline:

  drought    farm NDWI is >0.15 INDEX UNITS below the district's mean NDWI
  low_yield  predicted yield is >20% below the district's average yield

The two are measured differently on purpose. Yield is t/ha: a ratio scale with
a true zero, where "20% below" means something. NDWI is a signed index whose
zero is a physical boundary rather than an absence, so a percentage of it is
undefined near zero -- see the comment on the drought rule.

Thresholds live in one place so they can be tuned without touching the trigger
logic, and the logic itself does not care whether the baselines came from
synthetic rows or real ones -- swapping in real data changes how often these
fire, not how they work.
"""
import os
import smtplib
from email.message import EmailMessage

from app.db import db

DROUGHT_NDWI_GAP = 0.15     # absolute NDWI units below the district mean
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
    #
    # MEASURED AS A GAP IN INDEX UNITS, NOT AS A PERCENTAGE. NDWI is a signed
    # index on [-1, 1] whose zero is a real physical value (roughly the
    # water/non-water boundary), not an absence. Dividing by it is only
    # meaningful on a ratio scale, and against a district mean near zero it
    # produces absurdities: a farm at -0.050 against a baseline of 0.002 read as
    # "3074% below", which tells a farmer nothing and discredits every other
    # number on the card. The old guard `baseline > 0` did not catch it because
    # 0.002 is greater than zero.
    #
    # A gap of 0.15 NDWI is a large, real difference -- a season spans roughly
    # -0.3 to 0.5 -- so the threshold keeps its value while its MEANING changes
    # from "15% of the baseline" to "0.15 index units below it".
    baseline = district_mean_ndwi(district, exclude_farm_id=farm.get("id"))
    ndwi = features.get("ndwi")
    if baseline is not None and ndwi is not None:
        gap = baseline - ndwi
        if gap > DROUGHT_NDWI_GAP:
            out.append({
                "type": "drought",
                "severity": "critical" if gap > 0.30 else "warning",
                "message": (
                    f"Canopy water (NDWI {ndwi:.3f}) is {gap:.3f} below the "
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

    # --- weather, scored against the crop's current growth stage -----------
    #
    # The two rules above look BACKWARDS at what the satellite already saw.
    # These look forwards, which is the only kind of warning a farmer can act
    # on -- and severity comes from the stage, so the same forecast is `info`
    # during tillering and `critical` while the grain is filling.
    out.extend(weather_alerts(farm))

    return out


def weather_alerts(farm: dict) -> list[dict]:
    """Forecast hazards for this farm's crop at its current stage.

    Returns [] on any failure. A weather API outage must not take the
    dashboard down with it: a missing alert is better than a 500, and the
    satellite-based rules above are unaffected.
    """
    from datetime import date

    from app.growth import growth_stage
    from app.weather import for_farm

    lat, lng = farm.get("gps_lat"), farm.get("gps_lng")
    crop = farm.get("crop_type")
    if lat is None or lng is None or not crop:
        return []

    planted = farm.get("planting_date")
    if isinstance(planted, str) and planted:
        try:
            planted = date.fromisoformat(planted[:10])
        except ValueError:
            planted = None
    else:
        planted = None

    try:
        stage = growth_stage(crop, planted)["stage"]
    except (ValueError, KeyError):
        return []          # no phenology table for this crop yet
    # Nothing is growing, so nothing is at risk.
    if stage in ("Not yet sown",):
        return []

    return for_farm(lat, lng, crop, stage)


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
        # STAMP ONLY ON SUCCESS. send_email returns False -- without raising --
        # when GMAIL_USER/GMAIL_APP_PASSWORD are unset, when the owner has no
        # resolvable address, and when SMTP fails. Discarding that result and
        # stamping emailed_at regardless made every alert claim "Emailed" on a
        # deployment with no mail configured at all. The screens already render
        # the other case honestly ("In app only" / "Not sent"); they were being
        # fed a column that was never false.
        if send_email(farm, c) and row.data:
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

    a = evaluate(farm, P, {"ndwi": -0.05})         # gap 0.35 -> critical drought
    types = {x["type"]: x for x in a}
    assert "drought" in types and types["drought"]["severity"] == "critical", a
    assert "low_yield" in types, a                 # 2.0 vs 3.2 = 37.5% below

    a = evaluate(farm, P, {"ndwi": 0.20})          # gap 0.10 -> under threshold
    assert "drought" not in {x["type"] for x in a}, a

    a = evaluate(farm, P, {"ndwi": 0.10})          # gap 0.20 -> warning, not critical
    assert {x["type"]: x for x in a}["drought"]["severity"] == "warning", a

    # THE 3074% BUG. A district mean near zero used to be divided into, which
    # turned a 0.052 gap into "3074% below". The message must now read in index
    # units, and must contain no percentage at all.
    globals()["district_mean_ndwi"] = lambda d, exclude_farm_id=None: 0.002
    a = evaluate(farm, P, {"ndwi": -0.050})        # gap 0.052 -> under 0.15
    assert "drought" not in {x["type"] for x in a}, a

    globals()["district_mean_ndwi"] = lambda d, exclude_farm_id=None: 0.02
    a = evaluate(farm, P, {"ndwi": -0.40})         # gap 0.42 against a tiny baseline
    msg = {x["type"]: x for x in a}["drought"]["message"]
    assert "%" not in msg, msg
    assert "0.420 below" in msg, msg

    # A negative district mean is a real reading (open water, flooded field),
    # and used to be rejected outright by the `baseline > 0` guard.
    globals()["district_mean_ndwi"] = lambda d, exclude_farm_id=None: -0.10
    a = evaluate(farm, P, {"ndwi": -0.40})         # gap 0.30
    assert "drought" in {x["type"] for x in a}, a

    globals()["district_mean_ndwi"] = lambda d, exclude_farm_id=None: 0.30

    class Q:
        predicted_yield = 3.1
        district_average = 3.2
    a = evaluate(farm, Q, {"ndwi": 0.29})          # both within threshold
    assert a == [], a

    print("alerts self-check OK")
