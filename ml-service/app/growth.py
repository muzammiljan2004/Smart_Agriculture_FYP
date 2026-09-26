"""Phenological stage from days since sowing.

Stage tables and conventional sowing dates come from data/crop_stages.csv and
data/crops.csv via app.crops -- adding a crop is a CSV row, not a code change.

Calendar-based only -- no satellite confirmation. That is a real limitation:
a cold spell stretches tillering by a week or two and this will not notice.
The durations are rough Punjab norms; they are the tuning knob to adjust once
field observations exist, and nothing else needs to change.
"""
from datetime import date, timedelta

from app.crops import DEFAULT_SOWING, DURATION_DAYS, STAGES, harvest_style  # noqa: F401


# Days past the expected harvest date before a crop stops being "late" and
# starts being "gone". A single-cut crop is off the field within ~10 days;
# 30 allows for a farmer who sowed later than the calendar assumes without
# ever claiming a crop is standing half a year after it ripened.
HARVEST_GRACE_DAYS = 30


def season_state(crop_type: str, days_since_sowing: int, estimated: bool) -> str:
    """'not_yet_sown' | 'growing' | 'overdue' | 'complete'.

    WHY 'complete' EXISTS. Without it, a rabi crop asked about in September
    reports as 166 days overdue -- because default_sowing_date() returns the
    most recent conventional sowing date ON OR BEFORE today, which between
    seasons is LAST season's. The arithmetic is right and the meaning is
    nonsense: nobody's wheat is five months late, that season ended.

    Nothing here observes a harvest. The system has no 'I harvested' input and
    does not check imagery for a cleared field, so this is an inference from
    the calendar alone. 'complete' says the season is over, not that the
    farmer definitely cut it -- which is the strongest claim the data
    supports.

    An ESTIMATED sowing date past harvest is always 'complete': we invented
    the date from the season, so treating it as a real crop running late would
    be compounding a guess. A date the farmer actually entered gets the grace
    period, because there it is their claim, not ours.
    """
    if days_since_sowing < 0:
        return "not_yet_sown"
    overrun = days_since_sowing - DURATION_DAYS[crop_type]
    if overrun <= 0:
        return "growing"
    if estimated or overrun > HARVEST_GRACE_DAYS:
        return "complete"
    return "overdue"


def harvest_window(crop_type: str, sown: date) -> dict:
    """When this crop comes off the field.

    duration_days, NOT the last stage's start day. The final stage in
    crop_stages.csv is the one DURING which harvest happens -- it begins when
    the crop starts ripening, which for wheat is about three weeks before the
    combine arrives. Reporting the stage start as the harvest date would send
    every farmer to the field early.

    For a multi-pick crop (tomato, chilli, brinjal) `from` is the FIRST pick,
    not the only one, and picking continues at pick_interval_days until the
    plant stops bearing. A single date would be actively misleading there, so
    the interval is returned alongside it.
    """
    style, gap = harvest_style(crop_type)
    first = sown + timedelta(days=DURATION_DAYS[crop_type])
    return {
        "harvest_date": first.isoformat(),
        "harvest_style": style,
        "pick_interval_days": gap,
        # A single-harvest crop is cut over a few days, not one; a picked crop
        # keeps going. Neither is a point in time, so do not render one.
        "harvest_window_days": 10 if style == "single" else None,
    }


def default_sowing_date(crop_type: str, today: date) -> date:
    """Most recent conventional sowing date for this crop, on or before today."""
    month, day = DEFAULT_SOWING[crop_type]
    candidate = date(today.year, month, day)
    # Sowing later this year hasn't happened yet -- use last year's.
    return candidate if candidate <= today else date(today.year - 1, month, day)


def growth_stage(crop_type: str, planting_date: date | None, today: date | None = None) -> dict:
    """Current stage, days elapsed, and days to the next stage."""
    if crop_type not in STAGES:
        raise ValueError(f"no growth model for {crop_type!r}")

    today = today or date.today()
    estimated = planting_date is None
    sown = planting_date or default_sowing_date(crop_type, today)
    days = (today - sown).days

    stages = STAGES[crop_type]
    total = stages[-1][1]

    if days < 0:
        # Sowing date in the future: pre-season, not "day 0 of sowing".
        return {
            "crop_type": crop_type, "planting_date": sown.isoformat(),
            "planting_date_estimated": estimated, "days_since_sowing": days,
            "stage": "Not yet sown", "stage_index": -1,
            "next_stage": stages[0][0], "days_to_next_stage": -days,
            "progress_pct": 0.0, "stages": [s for s, _ in stages],
            "days_to_harvest": DURATION_DAYS[crop_type] - days,
            "season_state": season_state(crop_type, days, estimated),
            **harvest_window(crop_type, sown),
        }

    idx = 0
    for i, (_, start) in enumerate(stages):
        if days >= start:
            idx = i

    stage = stages[idx][0]
    if idx + 1 < len(stages):
        next_stage, days_to_next = stages[idx + 1][0], stages[idx + 1][1] - days
    else:
        # Past harvest: the season is over, there is no next stage.
        next_stage, days_to_next = None, None

    return {
        "crop_type": crop_type,
        "planting_date": sown.isoformat(),
        "planting_date_estimated": estimated,
        "days_since_sowing": days,
        "stage": stage,
        "stage_index": idx,
        "next_stage": next_stage,
        "days_to_next_stage": days_to_next,
        "progress_pct": round(min(100.0, days / total * 100), 1),
        "stages": [s for s, _ in stages],
        # Negative once the crop is overdue -- that is information, not a bug:
        # a farmer past harvest date needs to be told so, not shown a zero.
        "days_to_harvest": DURATION_DAYS[crop_type] - days,
        "season_state": season_state(crop_type, days, estimated),
        **harvest_window(crop_type, sown),
    }


if __name__ == "__main__":
    d = date(2025, 1, 10)

    g = growth_stage("wheat", date(2024, 11, 15), today=d)
    assert g["days_since_sowing"] == 56, g
    assert g["stage"] == "Jointing", g            # 56 days -> jointing starts at 55
    assert g["next_stage"] == "Heading"
    assert g["days_to_next_stage"] == 85 - 56
    assert not g["planting_date_estimated"]

    g = growth_stage("wheat", None, today=d)      # falls back to 15 Nov
    assert g["planting_date_estimated"]
    assert g["planting_date"] == "2024-11-15", g

    g = growth_stage("wheat", date(2024, 11, 15), today=date(2025, 5, 1))
    assert g["stage"] == "Harvest" and g["next_stage"] is None, g
    assert g["progress_pct"] == 100.0

    g = growth_stage("wheat", date(2025, 11, 15), today=d)   # future sowing
    assert g["stage"] == "Not yet sown" and g["days_to_next_stage"] > 0, g

    g = growth_stage("rice", date(2025, 6, 25), today=date(2025, 9, 20))
    assert g["stage"] == "Grain filling", g

    # --- harvest timing ----------------------------------------------------
    g = growth_stage("wheat", date(2024, 11, 15), today=d)
    assert g["harvest_date"] == "2025-04-14", g      # 15 Nov + 150d
    assert g["days_to_harvest"] == 150 - 56, g
    assert g["harvest_style"] == "single" and g["pick_interval_days"] is None

    # The harvest date must come from duration_days, NOT the last stage's
    # start -- wheat starts ripening ~3 weeks before the combine arrives.
    last_stage_start = STAGES["wheat"][-1][1]
    assert DURATION_DAYS["wheat"] > last_stage_start, \
        "duration must outrun the final stage's start, or harvest_date is early"

    # Overdue reads negative rather than clamping to zero.
    g = growth_stage("wheat", date(2024, 11, 15), today=date(2025, 6, 1))
    assert g["days_to_harvest"] < 0, g

    # A picked crop returns its interval; a single-cut crop must not.
    g = growth_stage("tomato", date(2025, 8, 25), today=d)
    assert g["harvest_style"] == "multi" and g["pick_interval_days"] == 7, g
    assert g["harvest_window_days"] is None, g

    # --- season_state -------------------------------------------------------
    # The case that prompted this: a rabi crop asked about in September. The
    # default sowing date is LAST November, so the arithmetic says 166 days
    # overdue. Nobody's wheat is five months late; that season ended.
    g = growth_stage("wheat", None, today=date(2026, 9, 27))
    assert g["planting_date_estimated"] and g["days_to_harvest"] < -100, g
    assert g["season_state"] == "complete", g

    # An estimated date past harvest is never "overdue": we invented the date,
    # so calling the crop late would be compounding a guess.
    g = growth_stage("wheat", None, today=date(2026, 4, 25))
    assert g["season_state"] == "complete", g

    # A date the farmer entered gets the grace period -- there, late is their
    # claim rather than ours.
    g = growth_stage("wheat", date(2025, 11, 15), today=date(2026, 4, 25))
    assert g["season_state"] == "overdue", g          # 11 days past
    g = growth_stage("wheat", date(2025, 11, 15), today=date(2026, 9, 27))
    assert g["season_state"] == "complete", g         # 166 days past

    g = growth_stage("wheat", date(2025, 12, 1), today=date(2026, 2, 1))
    assert g["season_state"] == "growing", g
    g = growth_stage("wheat", date(2026, 11, 15), today=date(2026, 9, 27))
    assert g["season_state"] == "not_yet_sown", g

    print("growth self-check OK")
