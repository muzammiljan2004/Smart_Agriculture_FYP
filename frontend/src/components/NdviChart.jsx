import { useMemo, useRef, useState } from 'react'
import { fmtDate } from '../lib/format'

/* Hand-authored SVG rather than a charting library.
 *
 * The whole chart is one line, two axes and a hover readout. Recharts or
 * Chart.js would add ~50-150 kB to a bundle that already ships Leaflet, for
 * features this does not use. If a second, genuinely different chart type
 * shows up later, that is the moment to reconsider -- not before. */

const W = 900
const H = 280
// Left margin carries the NDVI labels, bottom carries the month ticks. The
// first version drew labels at x=4 straight over the plot area, which is what
// made the axis look like decoration rather than a scale.
const M = { top: 14, right: 18, bottom: 38, left: 46 }
const PW = W - M.left - M.right
const PH = H - M.top - M.bottom

const Y_TICKS = [0, 0.2, 0.4, 0.6, 0.8, 1.0]

const monthLabel = (d) => ({
  t: d.getTime(),
  label: d.toLocaleDateString('en-GB', { month: 'short' }),
  // Year only where it changes, so "Jan" is not ambiguous across a rabi
  // season that straddles two calendar years.
  year: d.getMonth() === 0 ? String(d.getFullYear()).slice(2) : null,
})

/** Month boundaries inside the series, for the x axis. */
function monthTicks(t0, t1) {
  const out = []
  const first = new Date(t0)
  first.setDate(1)
  first.setHours(0, 0, 0, 0)
  const d = new Date(first)
  if (d.getTime() < t0) d.setMonth(d.getMonth() + 1)

  // The series rarely begins on the 1st, so the month it starts in would
  // otherwise go unlabelled -- a rabi curve starting 2 Nov had its first four
  // weeks sitting under no tick at all. Label the partial month at the axis
  // origin, anchored left so it cannot clip off the edge.
  if (d.getTime() > t0) out.push({ ...monthLabel(first), t: t0, partial: true })

  while (d.getTime() <= t1) {
    out.push(monthLabel(d))
    d.setMonth(d.getMonth() + 1)
  }
  return out
}

/**
 * NDVI over a season, from the stored field time series.
 *
 * ONE LINE ONLY. The design puts a district average alongside it, and that
 * series does not exist: /timeseries reduces this field's own geometry and
 * nothing in the API returns a per-date district mean. A second line would
 * have to be invented, so none is drawn.
 */
export default function NdviChart({ points, sownDate }) {
  const svgRef = useRef(null)
  const [hover, setHover] = useState(null)

  const g = useMemo(() => {
    const pts = points
      .map((p) => ({ ...p, t: new Date(p.date + 'T00:00:00').getTime() }))
      .sort((a, b) => a.t - b.t)
    const t0 = pts[0].t
    const t1 = pts[pts.length - 1].t
    const span = Math.max(1, t1 - t0)
    const x = (t) => M.left + ((t - t0) / span) * PW
    const y = (v) => M.top + (1 - Math.max(0, Math.min(1, v))) * PH
    // A field's own median tells us what "fully seen" looks like for it, which
    // varies with area. Anything under half of that saw a fraction of the
    // field and is drawn hollow rather than passed off as a clean reading.
    const px = pts.map((p) => p.valid_px || 0).sort((a, b) => a - b)
    const medianPx = px[Math.floor(px.length / 2)] || 0
    const thin = (p) => medianPx > 0 && (p.valid_px || 0) < medianPx * 0.5
    return { pts, t0, t1, span, x, y, medianPx, thin }
  }, [points])

  const { pts, t0, t1, x, y, thin } = g
  const line = pts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.ndvi).toFixed(1)).join(' ')
  const area = `${line} L ${x(t1).toFixed(1)} ${M.top + PH} L ${x(t0).toFixed(1)} ${M.top + PH} Z`
  const ticks = monthTicks(t0, t1)
  const sownT = sownDate ? new Date(sownDate + 'T00:00:00').getTime() : null

  /** Pointer position -> nearest observation.
   *
   * getScreenCTM().inverse() rather than arithmetic on getBoundingClientRect:
   * the SVG scales with its container and the ratio method drifts as soon as
   * the rendered aspect differs from the viewBox, which is exactly when a
   * tooltip pointing at the wrong day is hardest to notice.
   */
  function locate(e) {
    const svg = svgRef.current
    if (!svg) return
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const p = svg.createSVGPoint()
    p.x = e.clientX
    p.y = e.clientY
    const vb = p.matrixTransform(ctm.inverse())
    let best = null
    let bestD = Infinity
    for (const pt of pts) {
      const d = Math.abs(x(pt.t) - vb.x)
      if (d < bestD) { bestD = d; best = pt }
    }
    setHover(best)
  }

  const hx = hover ? x(hover.t) : 0
  const hy = hover ? y(hover.ndvi) : 0

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-64 w-full touch-none"
        role="img"
        aria-label={`NDVI for this field, ${pts.length} observations from ${pts[0].date} to ${pts[pts.length - 1].date}`}
        onPointerMove={locate}
        onPointerLeave={() => setHover(null)}
      >
        {/* Y axis */}
        {Y_TICKS.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + PW} y1={y(v)} y2={y(v)}
                  stroke="#dcf2e4" strokeWidth="1" />
            <text x={M.left - 10} y={y(v) + 4} textAnchor="end" fontSize="12" fill="#66756b">
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + PH} stroke="#bfe5cc" strokeWidth="1" />
        <text x={12} y={M.top + PH / 2} fontSize="12" fill="#66756b" textAnchor="middle"
              transform={`rotate(-90 12 ${M.top + PH / 2})`}>NDVI</text>

        {/* X axis */}
        <line x1={M.left} x2={M.left + PW} y1={M.top + PH} y2={M.top + PH}
              stroke="#bfe5cc" strokeWidth="1" />
        {ticks.map((t) => (
          <g key={t.t}>
            {!t.partial && (
              <line x1={x(t.t)} x2={x(t.t)} y1={M.top + PH} y2={M.top + PH + 5}
                    stroke="#bfe5cc" strokeWidth="1" />
            )}
            <text x={x(t.t)} y={M.top + PH + 19}
                  textAnchor={t.partial ? 'start' : 'middle'} fontSize="12" fill="#66756b">
              {t.label}
            </text>
            {t.year && (
              <text x={x(t.t)} y={M.top + PH + 32}
                    textAnchor={t.partial ? 'start' : 'middle'} fontSize="11" fill="#9aa8a0">
                {t.year}
              </text>
            )}
          </g>
        ))}

        {/* Sowing marker, when the farmer gave a date and it falls in range */}
        {sownT != null && sownT >= t0 && sownT <= t1 && (
          <g>
            <line x1={x(sownT)} x2={x(sownT)} y1={M.top} y2={M.top + PH}
                  stroke="#b9821c" strokeWidth="1" strokeDasharray="4 4" />
            <text x={x(sownT) + 5} y={M.top + 12} fontSize="11" fill="#b9821c">sown</text>
          </g>
        )}

        <path d={area} fill="#2f9a62" opacity="0.10" />
        <path d={line} fill="none" stroke="#1a7f4b" strokeWidth="2.2"
              strokeLinejoin="round" strokeLinecap="round" />

        {/* Every observation is a point, so the reader can see where a reading
            actually exists and where the line is just joining a gap. Hollow =
            most of the field was cloud-masked on that date. */}
        {pts.map((p) => (
          <circle key={p.date} cx={x(p.t)} cy={y(p.ndvi)} r={thin(p) ? 3.4 : 2.6}
                  fill={thin(p) ? '#fff' : '#1a7f4b'}
                  stroke={thin(p) ? '#b9821c' : 'none'} strokeWidth="1.6" />
        ))}

        {hover && (
          <g pointerEvents="none">
            <line x1={hx} x2={hx} y1={M.top} y2={M.top + PH} stroke="#1a7f4b"
                  strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
            <circle cx={hx} cy={hy} r="5.5" fill="#1a7f4b" stroke="#fff" strokeWidth="2" />
          </g>
        )}
      </svg>

      {/* Tooltip as HTML, not SVG text: it wraps, it uses the same type scale
          as the rest of the app, and it needs no manual box sizing. Positioned
          by the point's fraction across the viewBox, which survives scaling. */}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 w-max -translate-x-1/2 -translate-y-full
                     rounded-xl bg-card px-3 py-2 text-xs text-ink shadow-lg ring-1 ring-leaf-100"
          style={{ left: `${(hx / W) * 100}%`, top: `calc(${(hy / H) * 100}% - 10px)` }}
        >
          <p className="font-semibold">{fmtDate(hover.date)}</p>
          <p className="tnum mt-1">
            NDVI <span className="font-semibold">{hover.ndvi.toFixed(4)}</span>
          </p>
          {['evi', 'ndwi', 'savi', 'nbr'].some((k) => hover[k] != null) && (
            <p className="tnum mt-0.5 text-muted">
              {['evi', 'ndwi', 'savi', 'nbr']
                .filter((k) => hover[k] != null)
                .map((k) => `${k.toUpperCase()} ${hover[k].toFixed(3)}`)
                .join(' · ')}
            </p>
          )}
          <p className="tnum mt-1 text-muted">
            {hover.cloud_pct != null && `cloud ${hover.cloud_pct}%`}
            {hover.valid_px != null && ` · ${hover.valid_px} px`}
            {hover.source && ` · ${hover.source}`}
          </p>
          {thin(hover) && (
            <p className="mt-1 max-w-60 text-wheat-500">
              Most of the field was cloud-masked on this date — this reading comes from a
              fraction of it.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
