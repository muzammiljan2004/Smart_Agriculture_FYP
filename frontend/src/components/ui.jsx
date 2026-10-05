import { useEffect } from 'react'
import { INDEX_META } from '../lib/format'

/** The white panel every page is built from. */
export function Card({ children, className = '', pad = 'p-6' }) {
  return (
    <section className={`rounded-2xl bg-card ${pad} shadow-sm ring-1 ring-leaf-100 ${className}`}>
      {children}
    </section>
  )
}

export function CardHead({ title, right, sub }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h3 className="font-display text-lg font-semibold">{title}</h3>
        {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      </div>
      {right && <div className="text-xs text-muted">{right}</div>}
    </div>
  )
}

export function PageHead({ title, sub, children }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

const TONES = {
  leaf: 'bg-leaf-100 text-leaf-700 ring-leaf-200',
  wheat: 'bg-wheat-300/40 text-wheat-500 ring-wheat-300/60',
  red: 'bg-red-50 text-red-700 ring-red-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
  grey: 'bg-black/4 text-muted ring-black/5',
}

export function Badge({ children, tone = 'leaf', className = '' }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${TONES[tone] ?? TONES.leaf} ${className}`}>
      {children}
    </span>
  )
}

export function Button({ children, variant = 'primary', className = '', ...rest }) {
  const v = {
    primary: 'bg-leaf-700 text-white hover:bg-leaf-800',
    dark: 'bg-leaf-900 text-white hover:bg-leaf-800',
    ghost: 'border border-leaf-200 bg-card text-leaf-800 hover:bg-leaf-50',
    danger: 'bg-red-700 text-white hover:bg-red-800',
    wheat: 'bg-wheat-400 text-leaf-900 hover:bg-wheat-300',
  }[variant]
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm
                  font-medium transition disabled:opacity-60 ${v} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

/** A label/value row with a hairline under it, as used across the design. */
export function Row({ label, value, className = '' }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 border-b border-leaf-100 py-2.5 last:border-0 ${className}`}>
      <span className="text-sm text-muted">{label}</span>
      <span className="tnum text-sm font-semibold">{value}</span>
    </div>
  )
}

/** Horizontal meter on a caller-supplied scale. */
export function Meter({ value, max = 1, tone = 'bg-leaf-600' }) {
  const pct = Math.max(2, Math.min(100, (value / max) * 100))
  return (
    <div className="h-1.5 w-full rounded-full bg-leaf-100">
      <div className={`h-1.5 rounded-full transition-[width] duration-700 ${tone}`}
           style={{ width: pct + '%' }} />
    </div>
  )
}

/** One spectral index with its bar. Indices live in [-1, 1]; the value is
 *  mapped onto the bar so a negative reads as left-of-centre rather than
 *  silently clamping to empty. Moved from the old Dashboard unchanged. */
export function IndexBar({ name, value, showHint = true }) {
  const [label, hint] = INDEX_META[name] ?? [name, '']
  // A scene fully masked out over this field is stored with nulls, so an index
  // can legitimately be absent. Rendering it as an em dash keeps the row in
  // place; calling .toFixed on null would take the whole panel down.
  const has = typeof value === 'number' && Number.isFinite(value)
  const pct = has ? ((value + 1) / 2) * 100 : 0
  const negative = has && value < 0
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <span className="tnum text-sm font-semibold">
          {has ? value.toFixed(3) : <span className="text-muted">—</span>}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full rounded-full bg-leaf-100">
        <div
          className={'h-1.5 rounded-full transition-[width] duration-700 '
            + (negative ? 'bg-wheat-400' : 'bg-leaf-600')}
          style={{ width: Math.max(2, Math.min(100, pct)) + '%' }}
        />
      </div>
      {showHint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  )
}

/** Modal shell: click the backdrop or press Escape to dismiss. */
export function Modal({ open, onClose, title, sub, children, wide = false }) {
  // Escape is bound on the document, not on the wrapper. A div only receives
  // key events when something inside it has focus, so an onKeyDown here would
  // do nothing until the user had already clicked into the form.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[2000] flex items-start justify-center overflow-y-auto
                 bg-leaf-900/40 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`w-full rounded-2xl bg-card shadow-xl ring-1 ring-leaf-100
                    ${wide ? 'max-w-3xl' : 'max-w-2xl'}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-4 px-7 pt-6">
          <div>
            <h2 className="font-display text-xl font-semibold">{title}</h2>
            {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
          </div>
          <button onClick={onClose} aria-label="Close"
                  className="rounded-lg p-1.5 text-muted transition hover:bg-leaf-50">
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="px-7 pb-7 pt-4">{children}</div>
      </div>
    </div>
  )
}

/** Shown wherever the design asks for something the backend cannot supply yet.
 *
 * Deliberately NOT a fake value. A dashboard that invents a number is worse
 * than one that admits a gap, and this project has already been bitten once by
 * a confident yield for a field that had no crop on it.
 */
export function NotWired({ what, why }) {
  return (
    <div className="rounded-xl bg-black/3 px-4 py-3 text-xs leading-relaxed text-muted ring-1 ring-black/5">
      <span className="font-semibold text-ink/70">{what}</span> {why}
    </div>
  )
}

export function Skeleton({ className = 'h-4 w-24' }) {
  return <div className={`animate-pulse rounded bg-leaf-100 ${className}`} />
}
