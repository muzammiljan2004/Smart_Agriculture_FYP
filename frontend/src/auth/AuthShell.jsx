import { useId, useState } from 'react'
import './auth.css'

/**
 * The frame every portal's sign-in screen shares: a decorative pitch panel on
 * the left (hidden on small screens), the form card on the right.
 *
 * PRESENTATION ONLY. Each portal keeps its own auth component -- Auth.jsx with
 * sign-up, GovAuth.jsx and ResearchAuth.jsx without -- because their access
 * rules are opposite; this only gives them one look. It holds no auth state and
 * calls nothing.
 *
 * Plain JSX + auth.css (prefixed `au-`), not Tailwind and not gov.css, so the
 * same file works inside all three bundles.
 */

const PATHS = {
  mail: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7l8.5 6 8.5-6" /></>,
  lock: <><rect x="4" y="10.5" width="16" height="10.5" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 018 0v3" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M3 3l18 18" /><path d="M10.6 5.1A10.4 10.4 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.2 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 005.4-1.6" /><path d="M9.9 9.9a3 3 0 004.2 4.2" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="M8 12.3l2.6 2.6L16 9.5" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M19 12H5M11 18l-6-6 6-6" />,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5h.01" /></>,
}

export function AuIcon({ name, size = 18, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  )
}

/** The landing page's mark, with literal fills so it renders in any bundle. */
function Mark({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="#1a7f4b" />
      <path d="M16 25c0-6 3-10 8-12-1 7-4 10-8 12z" fill="#bfe5cc" />
      <path d="M16 25c0-6-3-10-8-12 1 7 4 10 8 12z" fill="#7fc79c" />
      <path d="M16 26V15" stroke="#effaf3" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <circle cx="16" cy="9" r="2.2" fill="#e8b84f" />
    </svg>
  )
}

const Brand = ({ className }) => (
  <a className={'au-brand ' + (className || '')} href="/">
    <Mark /> <span>Smart Agriculture</span>
  </a>
)

/** Decorative only: a field patch with a pulsing ring, and a season curve. No figures. */
function Visual() {
  return (
    <div className="au-visual" aria-hidden="true">
      <div className="au-visual-in">
        <div className="au-mini-map">
          <svg viewBox="0 0 220 140" preserveAspectRatio="xMidYMid slice">
            <g transform="rotate(-8 110 70)">
              <rect className="au-m1" x="-10" y="-10" width="70" height="56" rx="4" />
              <rect className="au-m4" x="64" y="-10" width="56" height="56" rx="4" />
              <rect className="au-m2" x="124" y="-10" width="110" height="56" rx="4" />
              <rect className="au-m3" x="-10" y="50" width="96" height="60" rx="4" />
              <rect className="au-m2" x="90" y="50" width="66" height="60" rx="4" />
              <rect className="au-m4" x="160" y="50" width="74" height="60" rx="4" />
              <rect className="au-m2" x="-10" y="114" width="80" height="50" rx="4" />
              <rect className="au-m1" x="74" y="114" width="160" height="50" rx="4" />
            </g>
            <circle className="au-ring2" cx="122" cy="78" r="26" />
            <circle className="au-ring" cx="122" cy="78" r="17" />
            <circle cx="122" cy="78" r="3" style={{ fill: 'var(--g)' }} />
          </svg>
        </div>
        <div className="au-mini-curve">
          <span>Season curve</span>
          <svg viewBox="0 0 140 70">
            <path className="au-cf" d="M0 62 C 30 60, 45 30, 70 14 S 105 20, 140 58 L140 70 L0 70Z" />
            <path className="au-cl" pathLength="1" d="M0 62 C 30 60, 45 30, 70 14 S 105 20, 140 58" />
            <circle className="au-cd" cx="74" cy="13" r="3.4" />
          </svg>
        </div>
      </div>
    </div>
  )
}

/**
 * portal: 'farmer' | 'gov' | 'res' -- picks the accent (green / wheat / sky).
 * eyebrow, title, accent: the pitch headline, `accent` set in italic serif.
 * lead, points, stats: supporting copy for the left panel.
 */
export default function AuthShell({ portal, eyebrow, title, accent, lead, points = [], stats = [], children }) {
  return (
    <div className={'au ' + portal}>
      <aside className="au-art">
        <div className="au-glows" aria-hidden="true"><i /><i /><i /></div>
        <Brand />
        <div className="au-pitch">
          <span className="au-eyebrow"><i />{eyebrow}</span>
          <h1>{title} <em>{accent}</em></h1>
          <p>{lead}</p>
          <ul className="au-points">
            {points.map((p) => <li key={p}><AuIcon name="check" size={18} />{p}</li>)}
          </ul>
        </div>
        <Visual />
        <dl className="au-stats">
          {stats.map(([v, k]) => <div key={k}><dt>{v}</dt><dd>{k}</dd></div>)}
        </dl>
      </aside>

      <main className="au-main">
        <a className="au-back" href="/"><AuIcon name="back" size={16} />Back to home</a>
        <div className="au-card">
          <Brand className="au-brand-m" />
          {children}
        </div>
        <p className="au-legal">Smart Agriculture · Final Year Project, Air University</p>
      </main>
    </div>
  )
}

/** Labelled input with a leading icon; password fields get a show/hide button. */
export function AuthField({ label, icon, type = 'text', id, ...input }) {
  const auto = useId()
  const [show, setShow] = useState(false)
  const fid = id || auto
  const isPw = type === 'password'
  return (
    <div className="au-field">
      <label htmlFor={fid}>{label}</label>
      <div className="au-input">
        <AuIcon name={icon} size={18} />
        <input id={fid} type={isPw && show ? 'text' : type} {...input} />
        {isPw && (
          <button type="button" className="au-eye" onClick={() => setShow((s) => !s)}
                  aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
            <AuIcon name={show ? 'eyeOff' : 'eye'} size={17} />
          </button>
        )}
      </div>
    </div>
  )
}

export function AuthSubmit({ busy, busyLabel, children }) {
  return (
    <button type="submit" className="au-submit" disabled={busy}>
      {busy ? <><span className="au-spin" aria-hidden="true" />{busyLabel}</> : <>{children}<AuIcon name="arrow" size={17} className="arrow" /></>}
    </button>
  )
}

export function AuthAlert({ type = 'err', title, children }) {
  return (
    <div className={'au-alert ' + type} role={type === 'err' ? 'alert' : 'status'}>
      <AuIcon name={type === 'err' ? 'alert' : 'check'} size={18} />
      <div>{title && <b>{title}</b>}{children}</div>
    </div>
  )
}

export function AuthNote({ children }) {
  return <p className="au-note"><AuIcon name="info" size={16} /><span>{children}</span></p>
}
