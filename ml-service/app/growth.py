"""Phenological stage from days since sowing.

Calendar-based only -- no satellite confirmation. That is a real limitation:
a cold spell stretches tillering by a week or two and this will not notice.
The durations below are rough Punjab norms; they are the tuning knob to adjust
once field observations exist, and nothing else needs to change.
"""
from datetime import date

# (stage, days_after_sowing at which this stage STARTS). Wheat, rabi Punjab:
# sown Nov, harvested Apr, ~150 days total.
WHEAT_STAGES = [
    ("Sowing", 0),
    ("Tillering", 21),
    ("Jointing", 55),
    ("Heading", 85),
    ("Grain filling", 105),
    ("Harvest", 135),
]

# Kharif rice, transplanted Jun/Jul, harvested Oct: ~120 days.
RICE_STAGES = [
    ("Transplanting", 0),
    ("Tillering", 15),
    ("Panicle initiation", 45),
    ("Heading", 70),
    ("Grain filling", 85),
    ("Harvest", 110),
]

STAGES = {"wheat": WHEAT_STAGES, "rice": RICE_STAGES}

# Conventional sowing dates, used when a farm has no planting_date. Guessing is
# better than showing nothing, but the response says which was used so the UI
# can admit it rather than implying the farmer told us.
DEFAULT_SOWING = {"wheat": (11, 15), "rice": (6, 25)}   # (month, day)


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

    print("growth self-check OK")
