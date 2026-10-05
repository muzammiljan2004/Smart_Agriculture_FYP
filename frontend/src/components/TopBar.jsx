import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { Button } from './ui'

const initials = (s) =>
  (s || '?').split(/[\s@._-]+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join('')

/** Farm switcher, add-farm, alert bell and account menu.
 *
 * The farm switcher is the old header's <select>, kept as a real <select>: it
 * is one control, it is keyboard accessible for free, and a hand-rolled
 * listbox would be more code doing less.
 */
export default function TopBar({
  farms, selectedId, onSelect, onAdd, alerts, email, onNavigate, onMenu,
}) {
  const [openBell, setOpenBell] = useState(false)
  const [openUser, setOpenUser] = useState(false)
  const bell = useRef(null)
  const user = useRef(null)

  // One listener for both menus. Without it a menu stays open behind whatever
  // the user clicks next, which reads as a stuck overlay.
  useEffect(() => {
    const away = (e) => {
      if (bell.current && !bell.current.contains(e.target)) setOpenBell(false)
      if (user.current && !user.current.contains(e.target)) setOpenUser(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  const unread = alerts?.length ?? 0

  return (
    <header className="sticky top-0 z-[1100] border-b border-leaf-100 bg-canvas/85 backdrop-blur">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
        <button onClick={onMenu} aria-label="Open navigation"
                className="rounded-lg p-2 text-muted transition hover:bg-leaf-50 lg:hidden">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
          </svg>
        </button>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {farms.length > 0 && (
            <label className="hidden min-w-0 rounded-xl border border-leaf-200 bg-white px-3 py-1.5 sm:block">
              <span className="block text-[11px] leading-none text-muted">Current farm</span>
              <select
                value={selectedId ?? ''}
                onChange={(e) => onSelect(e.target.value)}
                className="mt-0.5 max-w-60 truncate bg-transparent text-sm font-medium outline-none"
                aria-label="Select farm"
              >
                {farms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.farmer_name} {f.area_hectares ? `${f.area_hectares} ha` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <Button variant="dark" onClick={onAdd} className="whitespace-nowrap">
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 4v12M4 10h12" strokeLinecap="round" />
            </svg>
            Add Farm
          </Button>

          <div className="relative" ref={bell}>
            <button
              onClick={() => setOpenBell((v) => !v)}
              aria-label={`Notifications (${unread})`}
              className="relative rounded-xl border border-leaf-200 bg-white p-2.5 text-ink/70 transition hover:bg-leaf-50"
            >
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor"
                   strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6M10.5 20a2 2 0 0 0 3 0" />
              </svg>
              {unread > 0 && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-600 ring-2 ring-white" />
              )}
            </button>

            {openBell && (
              <div className="absolute right-0 mt-2 w-80 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-leaf-100">
                <p className="border-b border-leaf-100 px-4 py-3 text-sm font-semibold">
                  Notifications
                </p>
                {unread === 0 ? (
                  <p className="px-4 py-5 text-sm text-muted">Nothing open right now.</p>
                ) : (
                  <ul className="max-h-80 overflow-y-auto">
                    {alerts.slice(0, 6).map((a) => (
                      <li key={a.id} className="border-b border-leaf-50 px-4 py-3 last:border-0">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                          {String(a.type).replace(/_/g, ' ')} · {a.severity}
                        </p>
                        <p className="mt-0.5 text-sm">{a.message}</p>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  onClick={() => { setOpenBell(false); onNavigate('alerts') }}
                  className="w-full border-t border-leaf-100 px-4 py-2.5 text-sm font-medium text-leaf-700 transition hover:bg-leaf-50"
                >
                  View all alerts
                </button>
              </div>
            )}
          </div>

          <div className="relative" ref={user}>
            <button
              onClick={() => setOpenUser((v) => !v)}
              className="flex items-center gap-2 rounded-xl border border-leaf-200 bg-white py-1.5 pl-1.5 pr-2.5 transition hover:bg-leaf-50"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-leaf-100 text-xs font-semibold text-leaf-800">
                {initials(email)}
              </span>
              <span className="hidden max-w-[10rem] truncate text-sm font-medium sm:block">{email}</span>
              <svg viewBox="0 0 20 20" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M6 8l4 4 4-4" strokeLinecap="round" />
              </svg>
            </button>

            {openUser && (
              <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-leaf-100">
                <p className="truncate border-b border-leaf-100 px-4 py-3 text-sm text-muted">{email}</p>
                <button
                  onClick={() => { setOpenUser(false); onNavigate('settings') }}
                  className="w-full px-4 py-2.5 text-left text-sm transition hover:bg-leaf-50"
                >
                  Settings
                </button>
                <button
                  onClick={() => supabase.auth.signOut()}
                  className="w-full border-t border-leaf-100 px-4 py-2.5 text-left text-sm transition hover:bg-leaf-50"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
