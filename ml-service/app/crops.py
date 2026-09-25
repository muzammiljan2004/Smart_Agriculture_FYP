"""Crop registry, loaded from data/crops*.csv rather than hardcoded.

    python -m app.crops        # self-check

Adding a crop is a CSV row, not a code change. One column is the exception and
it is deliberate: `model_order`.

WHY model_order EXISTS. The crop one-hot is part of the trained model's feature
vector, so its width and column order are baked into model.pkl. If CROPS were
simply "every row in crops.csv", adding sugarcane to the registry would widen
the vector from 7 to 8 and every prediction would silently misalign against a
model trained on 7. So the registry and the model's feature space are separate:
a crop enters the registry freely, and enters CROPS only when someone fills in
model_order and retrains. Blank means "known to the system, not a model input".

The three files:
    crops.csv           one row per crop: windows, calendar, requirements
    crop_stages.csv     phenology, one row per (crop, stage)
    crop_rotation.csv   sequence constraints, by crop pair or by family

STATUS COLUMN. Rows marked `seed` carry agronomic values that have NOT been
checked against a Punjab source -- they are plausible starting points, not
authority. `verified-window` means the observation window is the one already
used to build the training set, so changing it invalidates the fetched rows.
"""
import csv
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "data"


def _rows(name):
    with (DATA / name).open(newline="", encoding="utf-8-sig") as fh:
        return [r for r in csv.DictReader(fh) if (r.get("crop") or r.get("scope"))]


def _num(v, cast=float):
    v = (v or "").strip()
    return cast(v) if v else None


def _md(v):
    """'12-01' -> (12, 1)."""
    m, d = str(v).split("-")
    return int(m), int(d)


# ---------------------------------------------------------------- load
CROP_ROWS = {r["crop"]: r for r in _rows("crops.csv")}

#: Every crop the system knows about, alphabetical.
ALL_CROPS = tuple(sorted(CROP_ROWS))

#: Crops in the model's feature vector, ordered by model_order. Load-bearing:
#: this fixes the one-hot column order. See the module docstring.
CROPS = tuple(
    c for c, _ in sorted(
        ((c, _num(r["model_order"], int)) for c, r in CROP_ROWS.items()
         if (r["model_order"] or "").strip()),
        key=lambda t: t[1],
    )
)

CROP_SEASON = {c: r["season"] for c, r in CROP_ROWS.items()}

SEASON_WINDOWS = {
    c: {"start": _md(r["obs_start"]), "end": _md(r["obs_end"])}
    for c, r in CROP_ROWS.items()
}

#: Conventional sowing date per crop, (month, day), used when a farm gives none.
#: NOT sow_start: that is when the window OPENS, which is up to six weeks
#: earlier. Guessing the window's opening date would report every farm as
#: further through the season than it is.
DEFAULT_SOWING = {c: _md(r["sow_typical"]) for c, r in CROP_ROWS.items()}

#: When the sowing window opens and closes -- drives "sowing opens in N days".
SOW_WINDOW = {c: (_md(r["sow_start"]), _md(r["sow_end"])) for c, r in CROP_ROWS.items()}

DURATION_DAYS = {c: _num(r["duration_days"], int) for c, r in CROP_ROWS.items()}

STAGES = {}
for _r in _rows("crop_stages.csv"):
    STAGES.setdefault(_r["crop"], []).append(
        (_r["stage"], int(_r["days_after_sowing"]))
    )
for _c in STAGES:
    STAGES[_c].sort(key=lambda t: t[1])

_ROT_PAIR, _ROT_FAMILY = {}, {}
for _r in _rows("crop_rotation.csv"):
    _target = _ROT_FAMILY if _r["scope"] == "family" else _ROT_PAIR
    _target[(_r["prev"], _r["next"])] = (_r["effect"], _r["reason"])

REQUIREMENT_FIELDS = (
    "ph_min", "ph_max", "temp_min_c", "temp_opt_c", "temp_max_c",
    "water_mm_min", "water_mm_max", "salinity_ece_max",
)

INDEX_FEATURES = ["ndvi", "evi", "ndwi", "savi", "nbr"]
FEATURE_NAMES = INDEX_FEATURES + [f"crop_{c}" for c in CROPS]


# ---------------------------------------------------------------- api
def season_window(crop, season):
    """Observation window for a crop-season, as (start, end) ISO dates.

    Accepts either label form: "2020-21" (crop year) or "2020" (single year).

    Sampling every crop in the same months would be the obvious mistake: a rice
    field in February is bare soil, so its NDVI would read as a failed wheat
    crop rather than as no crop at all.
    """
    if crop not in SEASON_WINDOWS:
        raise ValueError(f"unknown crop {crop!r}; expected one of {ALL_CROPS}")
    try:
        y0 = int(str(season).split("-")[0])
    except (ValueError, IndexError):
        raise ValueError(f"cannot read a start year from season {season!r}")

    (sm, sd), (em, ed) = SEASON_WINDOWS[crop]["start"], SEASON_WINDOWS[crop]["end"]
    # A window whose end month is earlier than its start month has crossed into
    # the next calendar year (wheat: Dec -> Mar). One that hasn't, hasn't (rice).
    y_end = y0 + 1 if em < sm else y0
    return f"{y0}-{sm:02d}-{sd:02d}", f"{y_end}-{em:02d}-{ed:02d}"


def one_hot(crop):
    """Crop as fixed-width one-hot, ordered by CROPS."""
    if crop not in CROPS:
        raise ValueError(
            f"{crop!r} is not a model input crop. Known crops: {ALL_CROPS}. "
            f"Model crops: {CROPS}. Give it a model_order in crops.csv and retrain."
        )
    return [1.0 if c == crop else 0.0 for c in CROPS]


def requirements(crop):
    """Environmental tolerances for one crop, as floats (None where unset)."""
    r = CROP_ROWS[crop]
    out = {k: _num(r[k]) for k in REQUIREMENT_FIELDS}
    out["family"] = r["family"]
    out["status"] = r["status"]
    return out


def harvest_style(crop):
    """('single', None) or ('multi', pick_interval_days).

    Tomato, brinjal and chilli are picked every few days for months. Showing
    those a single harvest DATE is wrong, so callers have to branch on this.
    """
    r = CROP_ROWS[crop]
    return r["harvest_style"], _num(r["pick_interval_days"], int)


def rotation(prev_crop, next_crop):
    """(effect, reason) for growing next_crop after prev_crop.

    effect is 'good', 'caution', 'avoid' or 'neutral'. An explicit pair beats
    the family rule, so rice -> wheat stays good even though both are grasses:
    a blanket same-family ban would forbid the standard Punjab rotation.
    """
    if not prev_crop or prev_crop not in CROP_ROWS or next_crop not in CROP_ROWS:
        return "neutral", ""
    hit = _ROT_PAIR.get((prev_crop, next_crop))
    if hit:
        return hit
    fam = CROP_ROWS[prev_crop]["family"]
    if fam == CROP_ROWS[next_crop]["family"]:
        hit = _ROT_FAMILY.get((fam, fam))
        if hit:
            return hit
    return "neutral", ""


if __name__ == "__main__":
    # one-hot width must match what a trained model expects
    assert CROPS == ("wheat", "rice"), CROPS
    assert len(FEATURE_NAMES) == 7, FEATURE_NAMES
    assert one_hot("wheat") == [1.0, 0.0] and one_hot("rice") == [0.0, 1.0]

    # a registry crop with no model_order is known but not a model input
    assert "sugarcane" in ALL_CROPS and "sugarcane" not in CROPS
    try:
        one_hot("sugarcane")
        raise AssertionError("one_hot must refuse a non-model crop")
    except ValueError:
        pass

    # windows: wheat crosses the year boundary, kharif crops do not
    assert season_window("wheat", "2024-25") == ("2024-12-01", "2025-03-15")
    assert season_window("wheat", "2024") == ("2024-12-01", "2025-03-15")
    assert season_window("rice", "2020-21") == ("2020-06-15", "2020-10-15")
    assert season_window("potato", "2024-25") == ("2024-10-15", "2025-02-15")
    assert season_window("sugarcane", "2024-25") == ("2024-03-01", "2024-11-30")

    # every crop must be internally consistent
    for c in ALL_CROPS:
        assert c in STAGES, f"{c}: no rows in crop_stages.csv"
        assert STAGES[c][0][1] == 0, f"{c}: first stage must start at day 0"
        assert STAGES[c][-1][1] <= DURATION_DAYS[c], \
            f"{c}: last stage {STAGES[c][-1][1]}d outruns duration {DURATION_DAYS[c]}d"
        req = requirements(c)
        assert req["ph_min"] < req["ph_max"], f"{c}: ph range inverted"
        assert req["temp_min_c"] < req["temp_opt_c"] < req["temp_max_c"], f"{c}: temp range"
        assert req["water_mm_min"] < req["water_mm_max"], f"{c}: water range inverted"
        (ss, se), st = SOW_WINDOW[c], _md(CROP_ROWS[c]["sow_typical"])
        assert ss <= st <= se or ss > se, f"{c}: sow_typical outside the sowing window"
        style, gap = harvest_style(c)
        assert style in ("single", "multi"), f"{c}: bad harvest_style"
        assert (gap is None) == (style == "single"), \
            f"{c}: multi-pick crops need a pick interval, single-cut crops must not have one"

    # rotation: the explicit pair must win over the family rule
    assert rotation("rice", "wheat")[0] == "good", rotation("rice", "wheat")
    assert rotation("wheat", "wheat")[0] == "avoid"
    assert rotation("potato", "tomato")[0] == "avoid"   # both solanaceae
    assert rotation("wheat", "potato")[0] == "neutral"
    assert rotation(None, "wheat")[0] == "neutral"

    print(f"crops self-check OK -- {len(ALL_CROPS)} crops, {len(CROPS)} in the model")
