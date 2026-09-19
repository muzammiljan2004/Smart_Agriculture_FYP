"""One-page PDF farm report.

fpdf2 rather than reportlab: no system dependencies, pure Python, ~1MB. The
core fonts it uses are latin-1 only, so every string reaching this module must
be ASCII -- that is why the caveat text in main.py uses plain hyphens. ascii()
below is the backstop for anything a farmer typed.
"""
from datetime import date, datetime

from fpdf import FPDF

LEAF = (27, 77, 53)
MUTED = (108, 122, 113)
WHEAT = (200, 154, 54)
RULE = (214, 233, 221)


def ascii_only(s) -> str:
    """Core fonts are latin-1; a farmer's name in Urdu script would raise.
    Replace rather than crash -- a report with '?' beats no report."""
    return str(s).encode("latin-1", "replace").decode("latin-1")


class Report(FPDF):
    def header(self):
        self.set_fill_color(*LEAF)
        self.rect(0, 0, 210, 26, "F")
        self.set_text_color(255, 255, 255)
        self.set_font("Helvetica", "B", 15)
        self.set_xy(14, 8)
        self.cell(0, 8, "Smart Agriculture - Yield Report")
        self.set_font("Helvetica", "", 9)
        self.set_xy(14, 16)
        self.cell(0, 5, "Sentinel-2 + Random Forest  |  Sheikhupura / Okara / Sahiwal")
        self.set_text_color(0, 0, 0)
        self.set_y(34)

    def footer(self):
        self.set_y(-14)
        self.set_font("Helvetica", "", 7.5)
        self.set_text_color(*MUTED)
        self.cell(
            0, 4,
            f"Generated {datetime.now():%Y-%m-%d %H:%M}  |  Preliminary system - "
            f"not validated agronomic advice.",
            align="C",
        )

    def section(self, title):
        self.set_font("Helvetica", "B", 10.5)
        self.set_text_color(*LEAF)
        self.cell(0, 6, ascii_only(title), new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(*RULE)
        self.line(14, self.get_y(), 196, self.get_y())
        self.ln(2.5)
        self.set_text_color(0, 0, 0)

    def kv(self, label, value, w=44):
        self.set_font("Helvetica", "", 9)
        self.set_text_color(*MUTED)
        self.cell(w, 5.5, ascii_only(label))
        self.set_text_color(0, 0, 0)
        self.set_font("Helvetica", "B", 9)
        self.cell(0, 5.5, ascii_only(value), new_x="LMARGIN", new_y="NEXT")


def build(farm: dict, pred: dict) -> bytes:
    pdf = Report()
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.set_margins(14, 34, 14)
    pdf.add_page()

    # --- farm --------------------------------------------------------------
    pdf.section("Farm details")
    pdf.kv("Farmer", farm.get("farmer_name", "-"))
    pdf.kv("District", farm.get("district", "-"))
    pdf.kv("Crop / season", f"{farm.get('crop_type', '-')} / {farm.get('season', '-')}")
    pdf.kv("Location", f"{farm.get('gps_lat'):.4f}, {farm.get('gps_lng'):.4f}"
           if farm.get("gps_lat") is not None else "-")
    pdf.ln(3)

    # --- yield -------------------------------------------------------------
    pdf.section("Yield forecast")
    ci = pred.get("confidence_interval") or []
    unit = pred.get("unit", "t/ha")

    pdf.set_font("Helvetica", "B", 26)
    pdf.set_text_color(*LEAF)
    pdf.cell(0, 12, f"{pred.get('predicted_yield', '-')} {unit}", new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)
    pdf.ln(1)

    if len(ci) == 2:
        pdf.kv("Confidence range", f"{ci[0]} - {ci[1]} {unit}  (model spread)")
    if pred.get("district_average") is not None:
        vs = pred.get("vs_district_pct")
        arrow = "above" if (vs or 0) >= 0 else "below"
        pdf.kv("District average", f"{pred['district_average']} {unit}"
               + (f"   ({abs(vs):.1f}% {arrow})" if vs is not None else ""))
    if pred.get("trend_pct") is not None:
        d = "up" if pred["trend_pct"] >= 0 else "down"
        pdf.kv("Season-on-season", f"{d} {abs(pred['trend_pct']):.1f}% vs previous season")
    pdf.kv("Model", f"{pred.get('model_used', '-')}  [{pred.get('model_status', '-')}]")
    if pred.get("feature_date"):
        pdf.kv("Imagery date", pred["feature_date"])
    pdf.ln(3)

    # --- growth ------------------------------------------------------------
    g = pred.get("growth")
    if g:
        pdf.section("Growth stage")
        pdf.kv("Current stage", g.get("stage", "-"))
        pdf.kv("Days since sowing", str(g.get("days_since_sowing", "-")))
        if g.get("next_stage"):
            pdf.kv("Next stage", f"{g['next_stage']} in ~{g.get('days_to_next_stage')} days")
        pdf.kv("Sowing date",
               f"{g.get('planting_date', '-')}"
               + ("  (estimated from season)" if g.get("planting_date_estimated") else ""))

        # Progress bar across the stage sequence.
        y = pdf.get_y() + 2
        pdf.set_fill_color(*RULE)
        pdf.rect(14, y, 182, 3, "F")
        pdf.set_fill_color(*LEAF)
        pdf.rect(14, y, 182 * min(1.0, (g.get("progress_pct") or 0) / 100), 3, "F")
        pdf.set_y(y + 6)

        pdf.set_font("Helvetica", "", 7)
        pdf.set_text_color(*MUTED)
        pdf.cell(0, 4, ascii_only(" > ".join(g.get("stages", []))), new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(0, 0, 0)
        pdf.ln(3)

    # --- alerts ------------------------------------------------------------
    pdf.section("Active alerts")
    active = pred.get("alerts") or []
    if not active:
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(*MUTED)
        pdf.cell(0, 5.5, "None.", new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(0, 0, 0)
    else:
        for a in active:
            pdf.set_font("Helvetica", "B", 9)
            pdf.set_text_color(*WHEAT)
            pdf.cell(0, 5, ascii_only(
                f"{a.get('type', '').replace('_', ' ').title()} "
                f"({a.get('severity', 'warning')})"), new_x="LMARGIN", new_y="NEXT")
            pdf.set_text_color(0, 0, 0)
            pdf.set_font("Helvetica", "", 8.5)
            pdf.multi_cell(0, 4.5, ascii_only(a.get("message", "")))
            pdf.ln(1.5)
    pdf.ln(2)

    # --- caveats -----------------------------------------------------------
    caveats = pred.get("caveats") or []
    if caveats:
        pdf.section("Limitations")
        pdf.set_font("Helvetica", "", 8.5)
        for c in caveats:
            pdf.multi_cell(0, 4.5, ascii_only("- " + c))
            pdf.ln(0.5)

    out = pdf.output()
    return bytes(out)


if __name__ == "__main__":
    farm = {
        "farmer_name": "Muhammad Aslam", "district": "Sheikhupura",
        "crop_type": "wheat", "season": "rabi", "gps_lat": 31.7131, "gps_lng": 73.9783,
    }
    pred = {
        "predicted_yield": 3.65, "confidence_interval": [3.42, 3.85], "unit": "t/ha",
        "model_used": "RandomForest-v2", "model_status": "preliminary",
        "district_average": 3.19, "vs_district_pct": 14.6, "trend_pct": -5.6,
        "feature_date": "2025-02-20",
        "growth": {
            "stage": "Jointing", "days_since_sowing": 56, "next_stage": "Heading",
            "days_to_next_stage": 29, "planting_date": "2024-11-15",
            "planting_date_estimated": True, "progress_pct": 41.5,
            "stages": ["Sowing", "Tillering", "Jointing", "Heading", "Grain filling", "Harvest"],
        },
        "alerts": [{"type": "low_yield", "severity": "warning",
                    "message": "Predicted yield 2.4 t/ha is 25% below the district average."}],
        "caveats": ["Model trained on synthetic data - illustrative only."],
    }
    data = build(farm, pred)
    assert data[:4] == b"%PDF", "not a PDF"
    assert len(data) > 1500, f"suspiciously small: {len(data)} bytes"
    out = date.today().isoformat() + "-sample-report.pdf"
    with open(out, "wb") as fh:
        fh.write(data)
    print(f"report self-check OK - {len(data)} bytes -> {out}")
