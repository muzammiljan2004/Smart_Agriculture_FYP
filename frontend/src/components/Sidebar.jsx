import Logo from '../Logo'
import { supabase } from '../supabase'

/** Nav tree. `sub` items render indented and set the same page with a tab.
 *
 * The design gives Crop Monitoring and Field Intelligence three sub-items
 * each; those are tabs within one page, not separate routes, so a sub-item
 * selects the page AND the tab. Keeping them in one structure means the
 * sidebar and the in-page tabs cannot drift apart.
 */
export const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'farms', label: 'Farms', icon: 'home' },
  {
    id: 'monitoring', label: 'Crop Monitoring', icon: 'sprout',
    sub: [
      { tab: 'growth', label: 'Growth Stage' },
      { tab: 'health', label: 'Crop Health' },
      { tab: 'suitability', label: 'Crop Suitability' },
    ],
  },
  { id: 'yield', label: 'Yield Prediction', icon: 'chart' },
  {
    id: 'field', label: 'Field Intelligence', icon: 'layers',
    sub: [
      { tab: 'indices', label: 'Spectral Indices' },
      { tab: 'map', label: 'Satellite Map' },
      { tab: 'imagery', label: 'Imagery' },
    ],
  },
  { id: 'alerts', label: 'Alerts', icon: 'bell' },
  { id: 'reports', label: 'Reports', icon: 'doc' },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
]

function Icon({ name, className = 'h-[18px] w-[18px]' }) {
  const p = {
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    home: 'M3 10.5 12 3l9 7.5M5.5 9.5V21h13V9.5',
    sprout: 'M12 21v-8m0 0C12 9 9 7 5 7c0 4 2.5 6 7 6Zm0 0c0-3 2-5 6-5 0 3-2 5-6 5Z',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    layers: 'M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5M3 17l9 5 9-5',
    bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6M10.5 20a2 2 0 0 0 3 0',
    doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h4',
    sliders: 'M4 6h16M4 12h16M4 18h16M9 4v4M15 10v4M7 16v4',
    out: 'M15 17l5-5-5-5M20 12H9M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h7',
  }[name]
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor"
         strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={p} />
    </svg>
  )
}

export default function Sidebar({ page, tab, onNavigate, alertCount = 0, onClose }) {
  const item = (active) =>
    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ' +
    (active ? 'bg-leaf-100 font-semibold text-leaf-800' : 'text-ink/80 hover:bg-leaf-50')

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <Logo className="h-8 w-8" />
        <span className="font-display text-lg font-semibold tracking-tight">Smart Agriculture</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {NAV.map((n) => {
          const active = page === n.id
          return (
            <div key={n.id} className="mb-0.5">
              <button
                className={item(active && !n.sub) || ''}
                onClick={() => { onNavigate(n.id, n.sub?.[0]?.tab); onClose?.() }}
                aria-current={active ? 'page' : undefined}
              >
                <span className={active ? 'text-leaf-700' : 'text-muted'}>
                  <Icon name={n.icon} />
                </span>
                <span className="flex-1">{n.label}</span>
                {n.id === 'alerts' && alertCount > 0 && (
                  <span className="rounded-full bg-red-700 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                    {alertCount}
                  </span>
                )}
              </button>

              {n.sub && (
                <div className="mb-1 ml-3 border-l border-leaf-100 pl-3">
                  {n.sub.map((s) => {
                    const on = active && tab === s.tab
                    return (
                      <button
                        key={s.tab}
                        onClick={() => { onNavigate(n.id, s.tab); onClose?.() }}
                        className={
                          'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition ' +
                          (on ? 'font-semibold text-leaf-700' : 'text-muted hover:text-ink')
                        }
                      >
                        <span className={'h-1.5 w-1.5 rounded-full ' + (on ? 'bg-leaf-600' : 'bg-transparent')} />
                        {s.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      <div className="border-t border-leaf-100 px-3 py-4">
        <button
          onClick={() => supabase.auth.signOut()}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink/80 transition hover:bg-leaf-50"
        >
          <span className="text-muted"><Icon name="out" /></span>
          Sign out
        </button>
      </div>
    </div>
  )
}
