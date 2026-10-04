/** UI atoms, matching the design's class names one-for-one. */
import { useEffect, useState } from 'react'
import Icon from './icons'

export const Card = ({ title, sub, right, children, className = '', style }) => (
  <section className={'card ' + className} style={style}>
    {(title || right) && (
      <div className="ch">
        <div>
          {title && <h3>{title}</h3>}
          {sub && <p className="sub">{sub}</p>}
        </div>
        {right}
      </div>
    )}
    {children}
  </section>
)

export const Kpi = ({ label, value, sub }) => (
  <div className="card kpi">
    <div className="lbl">{label}</div>
    <div className="v">{value}</div>
    <div className="sub">{sub || ''}</div>
  </div>
)

export const Chip = ({ children, tone, style }) => (
  <span className={'chip ' + (tone || '')} style={style}>{children}</span>
)

/** Risk wording -> the design's chip tones. */
export const RiskChip = ({ level }) => (
  <Chip tone={level === 'high' || level === 'High' ? 'r'
    : level === 'medium' || level === 'Moderate' ? 'a' : ''}>
    {typeof level === 'string' ? level.charAt(0).toUpperCase() + level.slice(1) : level}
  </Chip>
)

export const PageHead = ({ title, sub, children }) => (
  <div className="ph">
    <div>
      <h1>{title}</h1>
      <p>{sub}</p>
    </div>
    <div className="row">{children}</div>
  </div>
)

export const Tabs = ({ items, value, onChange }) => (
  <div className="tabs" role="tablist">
    {items.map((i) => {
      const [v, l] = Array.isArray(i) ? i : [i, i]
      return (
        <button key={v} className={'tab ' + (String(value) === String(v) ? 'on' : '')}
                role="tab" aria-selected={String(value) === String(v)}
                onClick={() => onChange(v)}>
          {l}
        </button>
      )
    })}
  </div>
)

export const Button = ({ children, variant, size, ...rest }) => (
  <button className={'btn' + (variant === 'dark' ? ' dark' : '') + (size === 'sm' ? ' sm' : '')} {...rest}>
    {children}
  </button>
)

/** Growth-stage rail. `stages` is a list, `current` an index. */
export const Stages = ({ stages, current }) => (
  <div className="stages">
    {stages.map((s, i) => (
      <div key={s} className={i < current ? 'done' : i === current ? 'cur' : ''}>
        <i />
        {s}
      </div>
    ))}
  </div>
)

/* ------------------------------------------------------- data-state atoms
 *
 * The three states the design never had to render, because its data was
 * generated in the page and was therefore always present and always complete.
 */

export const Skeleton = ({ h = 120 }) => (
  <div className="skel" style={{ height: h }} aria-busy="true" aria-label="Loading" />
)

/**
 * Nothing to show, and WHY.
 *
 * `what` names the gap, `why` says what is missing upstream. This is not a
 * styling nicety: a government dashboard that renders an empty card invites the
 * reader to assume zero, and two of these screens are empty because no detector
 * has been run -- which is a completely different fact from "no risk found".
 */
export const Empty = ({ what, why, children }) => (
  <div className="empty">
    <b>{what}</b>
    {why}
    {children}
  </div>
)

export const ErrorNote = ({ error, onRetry }) => (
  <div className="err">
    <b>Could not load this section.</b>
    {String(error?.message || error)}
    {onRetry && (
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={onRetry}>Try again</button>
      </div>
    )}
  </div>
)

/**
 * One place that decides which of loading / error / empty / content to render.
 *
 * Every screen routes its sections through this, so the four states cannot be
 * forgotten on one card out of fifty -- which is exactly what happens when each
 * section writes its own `if (!data) return null`.
 */
export function Panel({ q, empty, children, skeleton = 120 }) {
  if (q.error) return <ErrorNote error={q.error} onRetry={q.reload} />
  if (q.loading) return <Skeleton h={skeleton} />
  if (q.isEmpty) return empty ?? <Empty what="No data for this selection." why="Try another crop or season." />
  return children(q.data)
}

/** Provenance line. Every screen states where its numbers came from. */
export const Provenance = ({ children }) => <p className="prov">{children}</p>

/** Scrollable table shell, with the design's overflow wrapper. */
export const TableWrap = ({ children }) => <div className="tw">{children}</div>

/** `message` is `{ text, id }`, not a string — see GovApp's `say`. */
export function Toast({ message }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!message) return
    setShown(true)
    const t = setTimeout(() => setShown(false), 2400)
    return () => clearTimeout(t)
  }, [message])
  return <div id="toast" className={shown ? 'show' : ''} role="status">{message?.text}</div>
}

export const MapLegendGradient = ({ title, stops, lo, hi, note }) => (
  <div className="maplegend">
    <b>{title}</b>
    <div className="bar" style={{ background: `linear-gradient(90deg,${stops.join(',')})` }} />
    <div className="sc"><span>{lo}</span><span>{hi}</span></div>
    {note && <div className="sc" style={{ marginTop: 2 }}>{note}</div>}
  </div>
)

export const MapLegendItems = ({ title, items }) => (
  <div className="maplegend">
    <b>{title}</b>
    {items.map(([label, color]) => (
      <div className="it" key={label}><i style={{ background: color }} />{label}</div>
    ))}
  </div>
)

export { Icon }
