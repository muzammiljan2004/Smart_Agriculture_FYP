/** Charts, ported from the design's SVG builders.
 *
 * Hand-authored SVG, not a charting library. Three reasons, in order:
 *   1. The design already specifies these exact marks, and they are what the
 *      approved screenshots show.
 *   2. Recharts is not a dependency of this project, and adding it would ship
 *      ~100 kB for four chart types that are ~40 lines each.
 *   3. The farmer portal already does the same thing in
 *      src/components/NdviChart.jsx, so this matches the convention in the repo
 *      rather than introducing a second one.
 *
 * Every chart below handles a null value as a GAP, not a zero. The design's data
 * was always complete; real rows are not, and a missing season drawn as zero is
 * a reported crop failure.
 */
import { useId, useRef, useState } from 'react'
import { clamp, f1 } from './fmt'

/** Shared y axis: gridlines plus labels outside the plot. */
function AxisY({ w, h, pl, pr, pt, pb, min, max, dec, ticks = 4 }) {
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const y = pt + (h - pt - pb) * (1 - i / ticks)
    const v = min + (max - min) * (i / ticks)
    return (
      <g key={i}>
        <line x1={pl} x2={w - pr} y1={y} y2={y} className="gl" />
        <text x={pl - 6} y={y + 3} className="at" textAnchor="end">{f1(v, dec)}</text>
      </g>
    )
  })
}

const finite = (v) => Number.isFinite(Number(v))

/**
 * Vertical bars. `data` is [{ l, v, c }]; a null `v` is drawn as an absent bar
 * with the label kept, so a gap in a season series is visible as a gap.
 */
export function Bars({ data, w = 560, h = 170, max, min = 0, dec = 1, hi, vals, alt }) {
  const [hover, setHover] = useState(null)
  const pl = 34, pr = 6, pt = 8, pb = 22
  const present = data.filter((d) => finite(d.v))
  if (!present.length) return <p className="sub">No values to plot.</p>
  const mx = max ?? Math.max(...present.map((d) => Number(d.v))) * 1.18
  const mn = min
  const bw = (w - pl - pr) / data.length

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label={alt || 'Bar chart'}>
      <AxisY w={w} h={h} pl={pl} pr={pr} pt={pt} pb={pb} min={mn} max={mx} dec={dec} />
      {data.map((d, i) => {
        const x = pl + i * bw + bw * 0.17
        if (!finite(d.v)) {
          return (
            <text key={i} x={x + bw * 0.33} y={h - pb - 4} className="at" textAnchor="middle">–</text>
          )
        }
        const bh = Math.max(0, ((Number(d.v) - mn) / (mx - mn)) * (h - pt - pb))
        const fill = d.c || (i === hi ? 'var(--g900)' : 'var(--g300)')
        return (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect x={x} y={h - pb - bh} width={bw * 0.66} height={bh} rx="2.5"
                  style={{ fill, opacity: hover == null || hover === i ? 1 : 0.55 }} />
            <title>{`${d.l}: ${f1(d.v, dec)}`}</title>
            {vals && (
              <text x={x + bw * 0.33} y={h - pb - bh - 4} className="at" textAnchor="middle">
                {f1(d.v, dec)}
              </text>
            )}
          </g>
        )
      })}
      {data.map((d, i) =>
        data.length <= 14 || i % 2 === 0 ? (
          <text key={'l' + i} x={pl + i * bw + bw * 0.5} y={h - 6} className="at" textAnchor="middle">
            {d.l}
          </text>
        ) : null
      )}
    </svg>
  )
}

/** Stacked bars. `data` is [{ l, p: [..] }], `colors` one per stack layer. */
export function Stacked({ data, colors, w = 600, h = 200, alt }) {
  const pl = 40, pr = 6, pt = 8, pb = 34
  const totals = data.map((d) => d.p.reduce((a, b) => a + (Number(b) || 0), 0))
  if (!totals.some((t) => t > 0)) return <p className="sub">No values to plot.</p>
  const mx = Math.max(...totals) * 1.1
  const bw = (w - pl - pr) / data.length

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label={alt || 'Stacked bar chart'}>
      <AxisY w={w} h={h} pl={pl} pr={pr} pt={pt} pb={pb} min={0} max={mx} dec={0} />
      {data.map((d, i) => {
        const x = pl + i * bw + bw * 0.15
        let y = h - pb
        return (
          <g key={i}>
            {d.p.map((v, k) => {
              const bh = ((Number(v) || 0) / mx) * (h - pt - pb)
              y -= bh
              return <rect key={k} x={x} y={y} width={bw * 0.7} height={bh} style={{ fill: colors[k] }} />
            })}
            <text transform={`translate(${x + bw * 0.35},${h - pb + 8}) rotate(35)`} className="at">
              {d.l}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/**
 * Line chart with an optional uncertainty band and an optional hover readout.
 *
 * `series` is [{ c, v: [..], dash, area, w, name }]. A null inside `v` breaks
 * the path rather than interpolating across it: a season with no observation is
 * a hole in the series, and joining the two neighbours would draw a trend
 * through data that does not exist.
 */
export function Line({
  series, labels, band, w = 560, h = 190, min, max, dec = 2, alt, hoverFmt,
}) {
  const svgRef = useRef(null)
  const [at, setAt] = useState(null)
  const clipId = useId()
  const pl = 34, pr = 8, pt = 10, pb = 24
  const n = labels.length
  if (!n) return <p className="sub">No values to plot.</p>

  const all = series.flatMap((s) => s.v.filter(finite).map(Number))
    .concat(band ? [...band.lo, ...band.hi].filter(finite).map(Number) : [])
  if (!all.length) return <p className="sub">No values to plot.</p>
  const mn = min != null ? min : Math.min(...all) * 0.95
  const mx = max != null ? max : Math.max(...all) * 1.05
  const X = (i) => pl + (n === 1 ? (w - pl - pr) / 2 : (i * (w - pl - pr)) / (n - 1))
  const Y = (v) => pt + (h - pt - pb) * (1 - (Number(v) - mn) / (mx - mn || 1))

  function locate(e) {
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!ctm) return
    const p = svg.createSVGPoint()
    p.x = e.clientX
    p.y = e.clientY
    const vb = p.matrixTransform(ctm.inverse())
    let best = null
    let bd = Infinity
    for (let i = 0; i < n; i++) {
      const d = Math.abs(X(i) - vb.x)
      if (d < bd) { bd = d; best = i }
    }
    setAt(best)
  }

  const path = (vals) => {
    let d = ''
    let pen = false
    vals.forEach((v, i) => {
      if (!finite(v)) { pen = false; return }
      d += (pen ? 'L' : 'M') + X(i) + ',' + Y(v) + ' '
      pen = true
    })
    return d
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef} viewBox={`0 0 ${w} ${h}`} className="chart" role="img"
        aria-label={alt || 'Line chart'}
        onPointerMove={locate} onPointerLeave={() => setAt(null)}
        style={{ touchAction: 'none' }}
      >
        <AxisY w={w} h={h} pl={pl} pr={pr} pt={pt} pb={pb} min={mn} max={mx} dec={dec} />

        {band && (
          <path
            d={
              'M' + band.hi.map((v, i) => `${X(i)},${Y(v)}`).join(' L') +
              ' L' + band.lo.map((v, i) => `${X(i)},${Y(v)}`).reverse().join(' L') + ' Z'
            }
            style={{ fill: band.c || 'var(--g300)', opacity: 0.35 }}
          />
        )}

        {series.map((s, k) => {
          const first = s.v.findIndex(finite)
          const last = s.v.length - 1 - [...s.v].reverse().findIndex(finite)
          return (
            <g key={k}>
              {s.area && first >= 0 && (
                <path
                  d={`M${X(first)},${h - pb} ` +
                     s.v.map((v, i) => (finite(v) ? `L${X(i)},${Y(v)} ` : '')).join('') +
                     `L${X(last)},${h - pb} Z`}
                  style={{ fill: s.c, opacity: 0.14 }}
                  clipPath={`url(#${clipId})`}
                />
              )}
              <path
                d={path(s.v)} fill="none"
                style={{
                  stroke: s.c, strokeWidth: s.w || 2,
                  strokeDasharray: s.dash ? '4 4' : undefined,
                }}
                strokeLinejoin="round" strokeLinecap="round"
              />
              {/* A single isolated point draws no line, so mark it. */}
              {s.v.map((v, i) =>
                finite(v) && !finite(s.v[i - 1]) && !finite(s.v[i + 1]) ? (
                  <circle key={i} cx={X(i)} cy={Y(v)} r="2.4" style={{ fill: s.c }} />
                ) : null
              )}
            </g>
          )
        })}

        <defs>
          <clipPath id={clipId}>
            <rect x={pl} y={pt} width={w - pl - pr} height={h - pt - pb} />
          </clipPath>
        </defs>

        {at != null && (
          <g pointerEvents="none">
            <line x1={X(at)} x2={X(at)} y1={pt} y2={h - pb} stroke="var(--g700)"
                  strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
            {series.map((s, k) =>
              finite(s.v[at]) ? (
                <circle key={k} cx={X(at)} cy={Y(s.v[at])} r="3.6"
                        style={{ fill: s.c, stroke: 'var(--card)', strokeWidth: 1.6 }} />
              ) : null
            )}
          </g>
        )}

        {labels.map((l, i) =>
          i % Math.ceil(n / 8) === 0 ? (
            <text key={i} x={X(i)} y={h - 6} className="at" textAnchor="middle">{l}</text>
          ) : null
        )}
      </svg>

      {at != null && (
        <div
          className="leaflet-tooltip"
          style={{
            position: 'absolute', left: `${(X(at) / w) * 100}%`, top: 0,
            transform: 'translate(-50%,-100%)', zIndex: 5, whiteSpace: 'nowrap',
          }}
        >
          <b>{labels[at]}</b>
          {series.map((s, k) => (
            <div key={k} style={{ color: s.c }}>
              {s.name ? s.name + ': ' : ''}
              {finite(s.v[at]) ? (hoverFmt ? hoverFmt(s.v[at]) : f1(s.v[at], dec)) : 'no data'}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Donut. `parts` is [{ v, c }]. */
export function Donut({ parts, size = 130, center, sub }) {
  const R = size / 2 - 12
  const C = 2 * Math.PI * R
  const tot = parts.reduce((a, b) => a + (Number(b.v) || 0), 0)
  if (!tot) return <p className="sub">No values to plot.</p>
  let off = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Donut chart">
      <circle cx={size / 2} cy={size / 2} r={R} fill="none" style={{ stroke: 'var(--g50)' }} strokeWidth="14" />
      {parts.map((p, i) => {
        const l = ((Number(p.v) || 0) / tot) * C
        const el = (
          <circle
            key={i} cx={size / 2} cy={size / 2} r={R} fill="none" style={{ stroke: p.c }}
            strokeWidth="14" strokeDasharray={`${l} ${C - l}`} strokeDashoffset={-off}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )
        off += l
        return el
      })}
      {center && (
        <text x="50%" y={sub ? '49%' : '54%'} textAnchor="middle"
              style={{ font: '500 22px var(--serif)', fill: 'var(--ink)' }}>
          {center}
        </text>
      )}
      {center && sub && <text x="50%" y="63%" textAnchor="middle" className="at">{sub}</text>}
    </svg>
  )
}

/** Horizontal labelled bars: [{ l, v, t, max, c }]. Absent values show a dash. */
export function HRows({ rows, max }) {
  return rows.map((r, i) => (
    <div className="hr" key={i}>
      <span>{r.l}</span>
      <div className="t">
        {finite(r.v) && (
          <i style={{
            width: clamp((Number(r.v) / (r.max || max || 100)) * 100, 2, 100) + '%',
            background: r.c || undefined,
          }} />
        )}
      </div>
      <span className="n mono">{r.t ?? '—'}</span>
    </div>
  ))
}

export const LegendDots = ({ items }) => (
  <div className="leg">
    {items.map(([label, color]) => (
      <span key={label}><i style={{ background: color }} />{label}</span>
    ))}
  </div>
)
