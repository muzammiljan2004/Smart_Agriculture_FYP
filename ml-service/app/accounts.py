"""Create portal accounts — login and profile together, in one call.

WHY THIS LIVES SERVER-SIDE AND CANNOT LIVE ANYWHERE ELSE.

Creating a Supabase login needs the Auth Admin API, which needs the
service_role key. That key bypasses RLS entirely and must never reach a browser
bundle: shipping one so a form could create users would hand anyone who opens
the page the ability to mint accounts at any tier. So the browser posts here,
and this module holds the key.

THE COST OF HOLDING THE KEY IS THAT RLS NO LONGER PROTECTS ANYTHING HERE.

Every insert below bypasses the policies that would otherwise enforce the
hierarchy. So the hierarchy is enforced in Python instead, in `_rules()`, and
the rules are a deliberate transcription of the policies they stand in for:

  gov_profiles     "gov super admin provisions managers"  super_admin -> district_manager
                   "gov managers provision employees"     district_manager -> employee (own district)
  research_profiles "research super admin provisions leads" super_admin -> research_lead | researcher
                   "research leads provision researchers"  research_lead -> researcher

If a policy changes, this file has to change with it. `verify_gov_rls.py` and
`verify_research_rls.py` both assert the two agree, because a divergence here is
a privilege escalation that no amount of RLS would catch.

ROLLBACK MATTERS. The login and the profile are two writes against two
different systems, and there is no transaction spanning them. If the profile
insert fails, the auth user is DELETED again -- otherwise a failed attempt
leaves an orphan login that can authenticate, has no profile, and will be
refused by both portals while still occupying the email address, so retrying
with the same address fails too.
"""
from __future__ import annotations

import re

from app.db import db

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Supabase's own default minimum is 6. Eight is the floor here because these are
# administrative accounts for a government and a research portal, and the first
# password an admin types into a form is the one that tends to survive.
MIN_PASSWORD = 8

GOV_DESIGNATIONS = ("agriculture_officer", "district_officer", "analyst")


class AccountError(Exception):
    """A refusal that is safe and useful to show the person who asked."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _caller(portal: str, caller_id: str) -> dict:
    """The caller's own profile in the portal they are provisioning for.

    A government super admin counts as a research super admin -- the shared
    tier that research_is_super_admin() implements in SQL -- so the research
    branch falls back to gov_profiles exactly as that function does.
    """
    table = "gov_profiles" if portal == "gov" else "research_profiles"
    rows = db().table(table).select("*").eq("id", caller_id).execute().data or []
    me = rows[0] if rows else None

    if (not me or me["status"] != "active") and portal == "research":
        gov = (db().table("gov_profiles").select("id, tier, status, full_name")
               .eq("id", caller_id).execute().data or [])
        if gov and gov[0]["status"] == "active" and gov[0]["tier"] == "super_admin":
            return {"id": caller_id, "tier": "super_admin", "status": "active",
                    "full_name": gov[0]["full_name"], "mirrored": True}

    if not me:
        raise AccountError(f"You have no {portal} portal account.", 403)
    if me["status"] != "active":
        raise AccountError("Your account is deactivated.", 403)
    return me


def _rules(portal: str, me: dict, tier: str) -> None:
    """Refuse anything the matching RLS insert policy would refuse."""
    if portal == "gov":
        allowed = {"super_admin": ["district_manager"],
                   "district_manager": ["employee"]}.get(me["tier"], [])
    else:
        allowed = {"super_admin": ["research_lead", "researcher"],
                   "research_lead": ["researcher"]}.get(me["tier"], [])

    if not allowed:
        raise AccountError(
            f"A {me['tier'].replace('_', ' ')} cannot create accounts.", 403)
    if tier not in allowed:
        raise AccountError(
            f"A {me['tier'].replace('_', ' ')} may create: "
            f"{', '.join(a.replace('_', ' ') for a in allowed)}. Not {tier.replace('_', ' ')}.",
            403,
        )


def _validate(email: str, password: str, full_name: str) -> None:
    if not EMAIL_RE.match(email or ""):
        raise AccountError("That does not look like an email address.", 422)
    if len(password or "") < MIN_PASSWORD:
        raise AccountError(
            f"The password must be at least {MIN_PASSWORD} characters.", 422)
    if not (full_name or "").strip():
        raise AccountError("A full name is required.", 422)


def create_account(portal: str, caller_id: str, *, email: str, password: str,
                   full_name: str, tier: str, designation: str | None = None,
                   district_id: str | None = None,
                   can_run_models: bool = False,
                   can_train_models: bool = False) -> dict:
    """Create the login and the profile. Returns the profile row."""
    if portal not in ("gov", "research"):
        raise AccountError(f"unknown portal {portal!r}", 400)

    email = (email or "").strip().lower()
    full_name = (full_name or "").strip()
    _validate(email, password, full_name)

    me = _caller(portal, caller_id)
    _rules(portal, me, tier)

    # ---------------------------------------------------- shape, per portal
    if portal == "gov":
        if tier == "employee":
            if designation not in GOV_DESIGNATIONS:
                raise AccountError(
                    "An employee needs a designation: "
                    + ", ".join(GOV_DESIGNATIONS), 422)
        else:
            designation = None

        # A district manager may only provision into their OWN district. The
        # value is forced rather than validated, so a crafted request that
        # names another district silently lands in the caller's own -- the same
        # outcome the RLS policy's `district_id = gov_district_id()` produces.
        if me["tier"] == "district_manager":
            district_id = me["district_id"]
        if not district_id:
            raise AccountError("A district is required for this tier.", 422)

        profile = {
            "full_name": full_name, "tier": tier, "designation": designation,
            "district_id": district_id, "created_by": me["id"], "status": "active",
        }
        table = "gov_profiles"
    else:
        # A lead carries both flags as a table constraint, so the toggles only
        # apply to a researcher.
        profile = {
            "full_name": full_name, "tier": tier,
            "can_run_models": True if tier != "researcher" else bool(can_run_models),
            "can_train_models": True if tier != "researcher" else bool(can_train_models),
            # A mirrored government super admin has no research_profiles row, so
            # created_by would violate its foreign key. Null is honest: the
            # account was provisioned out of band as far as this table knows.
            "created_by": None if me.get("mirrored") else me["id"],
            "status": "active",
        }
        table = "research_profiles"

    # --------------------------------------------------------- the login
    try:
        res = db().auth.admin.create_user({
            "email": email,
            "password": password,
            # No confirmation mail: an administrator just set this password and
            # handed it over, so there is nothing for the user to confirm.
            "email_confirm": True,
        })
    except Exception as e:  # noqa: BLE001 - the message is what the admin needs
        msg = str(e)
        if "already" in msg.lower() or "registered" in msg.lower():
            raise AccountError(
                f"{email} already has a login. If they need a profile in this "
                "portal, it has to be added against their existing user id.", 409
            ) from e
        raise AccountError(f"Could not create the login: {msg}", 400) from e

    uid = getattr(res.user, "id", None) if getattr(res, "user", None) else None
    if not uid:
        raise AccountError("Supabase created no user id.", 500)

    # --------------------------------------------------------- the profile
    try:
        row = db().table(table).insert({"id": uid, **profile}).execute().data[0]
    except Exception as e:  # noqa: BLE001
        # ROLLBACK. Without this a failed insert leaves a login that can
        # authenticate, has no profile, and holds the email address hostage.
        try:
            db().auth.admin.delete_user(uid)
            undone = " The login was removed, so you can retry with the same address."
        except Exception:  # noqa: BLE001
            undone = (f" WARNING: the login {email} was created and could NOT be "
                      f"removed (id {uid}). Delete it in Studio before retrying.")
        raise AccountError(f"Could not create the profile: {e}.{undone}", 400) from e

    return {**row, "email": email}
