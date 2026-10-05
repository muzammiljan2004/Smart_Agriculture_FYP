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
 *
 * DRAWN AT THE CONTAINER'S REAL WIDTH. These used to be a fixed viewBox
 * (e.g. 560 x 170) stretched to 100% of the card, so in a wide card the whole
 * drawing -- bars, strokes and 10px axis text -- scaled up two or three times.
 * Now each chart measures its container (ResizeObserver) and draws at that
 * width in real pixels, so `h` is an actual height and text stays text-sized.
 * The `w` prop survives only as the width used before the first measurement.
 */
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { clamp, f1 } from './fmt'

/** Width of the element the ref is attached to, kept current on resize. A
 *  callback ref, so a chart that first renders "No values" and only later gets
 *  data still starts measuring once its wrapper exists. */
function useWidth(fallback) {
  const [el, setEl] = useState(null)
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    if (!el) return
    const read = () => { const cw = Math.round(el.getBoundingClientRect().width); if (cw > 0) setW(cw) }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [useCallback((node) => setEl(node), []), w]
}

/** Shared y axis: light dashed gridlines, a solid baseline, labels outside. */
function AxisY({ w, h, pl, pr, pt, pb, min, max, dec, ticks = 4 }) {
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const y = pt + (h - pt - pb) * (1 - i / ticks)
    const v = min + (max - min) * (i / ticks)
    return (
      <g key={i}>
        <line x1={pl} x2={w - pr} y1={y} y2={y} className={i === 0 ? 'gl base' : 'gl'} />
        <text x={pl - 8} y={y + 3.5} className="at" textAnchor="end">{f1(v, dec)}</text>
      </g>
    )
  })
}

// null/undefined/'' are GAPS. Number(null) is 0, so a bare Number.isFinite(Number(v))
// used to plot every missing value as a zero -- the exact failure the header
// comment warns about.
const finite = (v) => v != null && v !== '' && Number.isFinite(Number(v))

/** Round axis bounds and step (1, 2, 2.5 or 5 x 10^k) so ticks read 0.2, 0.4 ...
 *  rather than 0.207, 0.414. Only used where the caller did not fix the bound. */
function nice(lo, hi, ticks = 4) {
  if (!(hi > lo)) hi = lo + 1
  const raw = (hi - lo) / ticks
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)
  const nlo = Math.floor(lo / step) * step
  return { lo: nlo, hi: nlo + step * Math.ceil((hi - nlo) / step - 1e-9), step }
}

/** A bar with only its top corners rounded, so it sits flat on the baseline. */
function topRounded(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} ` +
         `Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`
}

/** Shorten a label to what fits in `px` at the axis font size. */
function fit(label, px) {
  const s = String(label ?? '')
  const max = Math.max(3, Math.floor(px / 6.4))
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** HTML tooltip anchored at fraction `fx` across the chart, kept inside it. */
function Tip({ fx, children }) {
  const shift = fx < 0.18 ? '0%' : fx > 0.82 ? '-100%' : '-50%'
  return (
    <div className="ctip" style={{ left: `${fx * 100}%`, transform: `translate(${shift}, -100%)` }}>
      {children}
    </div>
  )
}

/**
 * Vertical bars. `data` is [{ l, v, c }]; a null `v` is drawn as an absent bar
 * with the label kept, so a gap in a season series is visible as a gap.
 * Bars are capped in width, so three runs in a wide card are three neat bars
 * rather than three slabs; values are printed on the bars when there are few.
 */
export function Bars({ data, w: w0 = 560, h = 200, max, min = 0, dec = 1, hi, vals, alt }) {
  const [ref, w] = useWidth(w0)
  const [hover, setHover] = useState(null)
  const gid = useId()
  const pl = 40, pr = 8, pt = 18, pb = 26
  const present = data.filter((d) => finite(d.v))
  if (!present.length) return <p className="sub">No values to plot.</p>
  const mn = min
  const mx = max ?? nice(mn, Math.max(...present.map((d) => Number(d.v))) * 1.08).hi
  const ticks = max != null ? 4 : Math.round((mx - mn) / nice(mn, mx).step) || 4
  const slot = (w - pl - pr) / data.length
  const bw = Math.min(slot * 0.62, 46)
  const showVals = vals || data.length <= 10
  const labelEvery = slot < 34 ? Math.ceil(34 / slot) : 1

  return (
    <div className="chart-wrap" ref={ref}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} className="chart" role="img"
           aria-label={alt || 'Bar chart'} onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--g500)' }} />
            <stop offset="1" style={{ stopColor: 'var(--g300)' }} />
          </linearGradient>
        </defs>
        <AxisY w={w} h={h} pl={pl} pr={pr} pt={pt} pb={pb} min={mn} max={mx} dec={dec}
               ticks={clamp(ticks, 2, 6)} />
        {data.map((d, i) => {
          const cx = pl + i * slot + slot / 2
          const x = cx - bw / 2
          if (!finite(d.v)) {
            return <text key={i} x={cx} y={h - pb - 5} className="at" textAnchor="middle">–</text>
          }
          const bh = Math.max(0, ((Number(d.v) - mn) / (mx - mn)) * (h - pt - pb))
          const fill = d.c || (i === hi ? 'var(--g700)' : `url(#${gid})`)
          const dim = hover != null && hover !== i
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              {/* Full-height hit area, so thin or short bars are easy to hover. */}
              <rect x={pl + i * slot} y={pt} width={slot} height={h - pt - pb}
                    className={hover === i ? 'colhi' : 'colhit'} />
              <path d={topRounded(x, h - pb - bh, bw, bh, 5)}
                    style={{ fill, opacity: dim ? 0.45 : 1, transition: 'opacity .15s' }} />
              {showVals && (
                <text x={cx} y={h - pb - bh - 6} className="at val" textAnchor="middle">
                  {f1(d.v, dec)}
                </text>
              )}
            </g>
          )
        })}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={'l' + i} x={pl + i * slot + slot / 2} y={h - 8} className="at" textAnchor="middle">
              {fit(d.l, slot * labelEvery - 4)}
            </text>
          ) : null
        )}
      </svg>
      {hover != null && finite(data[hover]?.v) && (
        <Tip fx={(pl + hover * slot + slot / 2) / w}>
          <b>{data[hover].l}</b>
          <span className="ctip-row"><i style={{ background: data[hover].c || 'var(--g500)' }} />{f1(data[hover].v, dec)}</span>
        </Tip>
      )}
    </div>
  )
}

/** Stacked bars. `data` is [{ l, p: [..] }], `colors` one per stack layer. */
export function Stacked({ data, colors, w: w0 = 600, h = 220, alt }) {
  const [ref, w] = useWidth(w0)
  const pl = 44, pr = 8, pt = 10, pb = 40
  const totals = data.map((d) => d.p.reduce((a, b) => a + (Number(b) || 0), 0))
  if (!totals.some((t) => t > 0)) return <p className="sub">No values to plot.</p>
  const mx = Math.max(...totals) * 1.1
  const slot = (w - pl - pr) / data.length
  const bw = Math.min(slot * 0.66, 40)

  return (
    <div className="chart-wrap" ref={ref}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} className="chart" role="img"
           aria-label={alt || 'Stacked bar chart'}>
        <AxisY w={w} h={h} pl={pl} pr={pr} pt={pt} pb={pb} min={0} max={mx} dec={0} />
        {data.map((d, i) => {
          const cx = pl + i * slot + slot / 2
          const x = cx - bw / 2
          let y = h - pb
          const top = d.p.map((v) => Number(v) || 0).reduce((last, v, k) => (v > 0 ? k : last), -1)
          return (
            <g key={i}>
              <title>{`${d.l}: ${f1(totals[i], 0)}`}</title>
              {d.p.map((v, k) => {
                const bh = ((Number(v) || 0) / mx) * (h - pt - pb)
                y -= bh
                return k === top
                  ? <path key={k} d={topRounded(x, y, bw, bh, 4)} style={{ fill: colors[k] }} />
                  : <rect key={k} x={x} y={y} width={bw} height={bh} style={{ fill: colors[k] }} />
              })}
              <text transform={`translate(${cx},${h - pb + 10}) rotate(35)`} className="at">
                {fit(d.l, 70)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
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
  series, labels, band, w: w0 = 560, h = 210, min, max, dec = 2, alt, hoverFmt,
}) {
  const [ref, w] = useWidth(w0)
  const svgRef = useRef(null)
  const [at, setAt] = useState(null)
  const clipId = useId()
  const gradId = useId()
  const pl = 42, pr = 12, pt = 14, pb = 28
  const n = labels.length
  if (!n) return <p className="sub">No values to plot.</p>

  const all = series.flatMap((s) => s.v.filter(finite).map(Number))
    .concat(band ? [...band.lo, ...band.hi].filter(finite).map(Number) : [])
  if (!all.length) return <p className="sub">No values to plot.</p>
  const lo = Math.min(...all), hi = Math.max(...all)
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.06
  const ns = nice(min != null ? min : lo - pad, max != null ? max : hi + pad)
  const mn = min != null ? min : ns.lo
  const mx = max != null ? max : ns.hi
  const ticks = min != null && max != null ? 4 : clamp(Math.round((mx - mn) / ns.step), 2, 6)
  const X = (i) => pl + (n === 1 ? (w - pl - pr) / 2 : (i * (w - pl - pr)) / (n - 1))
  const Y = (v) => pt + (h - pt - pb) * (1 - (Number(v) - mn) / (mx - mn || 1))
  const dots = n <= 30
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((w - pl - pr) / 64))))

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
    <div className="chart-wrap" ref={ref}>
      <svg
        ref={svgRef} viewBox={`0 0 ${w} ${h}`} width="100%" height={h} className="chart" role="img"
        aria-label={alt || 'Line chart'}
        onPointerMove={locate} onPointerLeave={() => setAt(null)}
        style={{ touchAction: 'none' }}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={pl} y={pt} width={w - pl - pr} height={h - pt - pb} />
          </clipPath>
          {series.map((s, k) => (
            <linearGradient key={k} id={gradId + k} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: s.c, stopOpacity: 0.22 }} />
              <stop offset="1" style={{ stopColor: s.c, stopOpacity: 0 }} />
            </linearGradient>
          ))}
        </defs>

        <AxisY w={w} h={h} pl={pl} pr={pr} pt={pt} pb={pb} min={mn} max={mx} dec={dec} ticks={ticks} />

        {band && (
          <path
            d={
              'M' + band.hi.map((v, i) => `${X(i)},${Y(v)}`).join(' L') +
              ' L' + band.lo.map((v, i) => `${X(i)},${Y(v)}`).reverse().join(' L') + ' Z'
            }
            style={{ fill: band.c || 'var(--g300)', opacity: 0.28 }}
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
                  style={{ fill: `url(#${gradId + k})` }}
                  clipPath={`url(#${clipId})`}
                />
              )}
              <path
                d={path(s.v)} fill="none"
                style={{
                  stroke: s.c, strokeWidth: s.w || 2.2,
                  strokeDasharray: s.dash ? '5 5' : undefined,
                }}
                strokeLinejoin="round" strokeLinecap="round"
              />
              {/* Points on short series; a lone point (no neighbours) is always
                  marked, because it draws no line on its own. */}
              {s.v.map((v, i) =>
                finite(v) && (dots && !s.dash || (!finite(s.v[i - 1]) && !finite(s.v[i + 1]))) ? (
                  <circle key={i} cx={X(i)} cy={Y(v)} r="2.8"
                          style={{ fill: 'var(--card)', stroke: s.c, strokeWidth: 1.8 }} />
                ) : null
              )}
            </g>
          )
        })}

        {at != null && (
          <g pointerEvents="none">
            <line x1={X(at)} x2={X(at)} y1={pt} y2={h - pb} stroke="var(--g700)"
                  strokeWidth="1" strokeDasharray="3 3" opacity="0.45" />
            {series.map((s, k) =>
              finite(s.v[at]) ? (
                <circle key={k} cx={X(at)} cy={Y(s.v[at])} r="4.5"
                        style={{ fill: s.c, stroke: 'var(--card)', strokeWidth: 2 }} />
              ) : null
            )}
          </g>
        )}

        {labels.map((l, i) =>
          i % labelEvery === 0 ? (
            <text key={i} x={X(i)} y={h - 9} className="at"
                  textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}>
              {fit(l, 64 * labelEvery)}
            </text>
          ) : null
        )}
      </svg>

      {at != null && (
        <Tip fx={X(at) / w}>
          <b>{labels[at]}</b>
          {series.map((s, k) => (
            <span key={k} className="ctip-row">
              <i style={{ background: s.c }} />
              {s.name ? s.name + ': ' : ''}
              <strong>{finite(s.v[at]) ? (hoverFmt ? hoverFmt(s.v[at]) : f1(s.v[at], dec)) : 'no data'}</strong>
            </span>
          ))}
        </Tip>
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
      <circle cx={size / 2} cy={size / 2} r={R} fill="none" style={{ stroke: 'var(--g50)' }} strokeWidth="12" />
      {parts.map((p, i) => {
        const l = ((Number(p.v) || 0) / tot) * C
        const el = (
          <circle
            key={i} cx={size / 2} cy={size / 2} r={R} fill="none" style={{ stroke: p.c }}
            strokeWidth="12" strokeDasharray={`${l} ${C - l}`} strokeDashoffset={-off}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )
        off += l
        return el
      })}
      {center && (
        <text x="50%" y={sub ? '49%' : '54%'} textAnchor="middle"
              style={{ font: '700 22px var(--display)', fill: 'var(--ink)' }}>
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
      <span title={r.l}>{r.l}</span>
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
