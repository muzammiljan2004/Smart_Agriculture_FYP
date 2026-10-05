import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import GovAuth from './GovAuth'
import ErrorBoundary from './lib/ErrorBoundary'
import Icon from './lib/icons'
import { ThemeToggle, Toast } from './lib/ui'
import { roleLabel, groupOf, navTree, screenById, visibleScreens } from './lib/access'
import { fetchCrops, fetchDistricts, fetchMyProfile, fetchRiskAlerts, fetchSeasons } from './lib/queries'
import PAGES from './pages'

/* The selection every screen shares, hoisted here for the same reason the
 * farmer portal hoists useFarmData: a crop chosen on the dashboard must still be
 * the crop when the user opens Satellite Monitoring, and pages that own their own
 * copy of it drift apart. Screens receive it as props and stay presentational. */

function useHashRoute(allowed, fallback) {
  const read = useCallback(() => {
    const id = (window.location.hash || '').replace(/^#\/?/, '').split('?')[0]
    return allowed.includes(id) ? id : fallback
  }, [allowed, fallback])

  const [screen, setScreen] = useState(read)

  useEffect(() => {
    const onHash = () => setScreen(read())
    window.addEventListener('hashchange', onHash)
    onHash()
    return () => window.removeEventListener('hashchange', onHash)
  }, [read])

  const go = useCallback((id) => {
    if (window.location.hash !== '#/' + id) window.location.hash = '#/' + id
    else setScreen(id)
    window.scrollTo(0, 0)
  }, [])

  return [screen, go]
}

export default function GovApp() {
  const [session, setSession] = useState(undefined)   // undefined = still checking
  const [profile, setProfile] = useState(undefined)
  const [profileErr, setProfileErr] = useState(null)
  const [dims, setDims] = useState(null)
  const [dimsErr, setDimsErr] = useState(null)
  const [alerts, setAlerts] = useState([])

  const [crop, setCrop] = useState(null)
  const [season, setSeason] = useState(null)
  const [district, setDistrict] = useState(null)
  const [toast, setToast] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [openGroups, setOpenGroups] = useState({ Monitoring: true })

  // A fresh object every time, not a bare string: showing the same message
  // twice in a row has to re-trigger the toast, and setState on an identical
  // string is a no-op that would leave the second one silent.
  const say = useCallback((text) => setToast({ text, id: Date.now() + Math.random() }), [])

  /* ------------------------------------------------------------------ auth */
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s ?? null)
      if (!s) { setProfile(undefined); setDims(null) }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  /* --------------------------------------------------------------- profile */
  useEffect(() => {
    if (!session) return
    setProfile(undefined)
    setProfileErr(null)
    fetchMyProfile().then(setProfile).catch((e) => { setProfileErr(e); setProfile(null) })
  }, [session])

  /* ------------------------------------------------------------ dimensions */
  const active = profile && profile.status === 'active'
  useEffect(() => {
    if (!active) return
    let live = true
    Promise.all([fetchDistricts(), fetchCrops(), fetchSeasons()])
      .then(([districts, crops, seasons]) => {
        if (!live) return
        setDims({ districts, crops, seasons })
        // Defaults: the crop the design opens on when it is available, the most
        // recent season, and the user's own district for a scoped account.
        setCrop((c) => c ?? (crops.find((x) => x.name === 'wheat') ?? crops[0])?.id ?? null)
        setSeason((s) => s ?? seasons[seasons.length - 1]?.id ?? null)
        // A district NAME, never an id. Every consumer matches on name --
        // GovMap's `selected`, DistrictPage's lookup -- so seeding this with
        // profile.district_id (a uuid) would silently never match and a scoped
        // user would always land on whichever district sorted first.
        setDistrict((d) => d ?? (
          districts.find((x) => x.id === profile.district_id)?.name ??
          districts.find((x) => x.name === 'Multan')?.name ??
          districts[0]?.name ?? null
        ))
      })
      .catch((e) => live && setDimsErr(e))
    return () => { live = false }
  }, [active, profile])

  useEffect(() => {
    if (!active) return
    fetchRiskAlerts().then(setAlerts).catch(() => setAlerts([]))
  }, [active])

  /* ---------------------------------------------------------------- routing */
  const screens = useMemo(() => visibleScreens(profile), [profile])
  const ids = useMemo(() => screens.map((s) => s.id), [screens])
  const [screen, go] = useHashRoute(ids, 'dashboard')

  useEffect(() => {
    const s = screenById(screen)
    if (s) document.title = `${s.title} · Smart Agriculture Government Portal`
  }, [screen])

  /* ----------------------------------------------------------------- gates */
  if (session === undefined) {
    return <div style={{ padding: 40 }}><div className="skel" style={{ height: 120 }} /></div>
  }
  if (!session) return <GovAuth />

  if (profile === undefined) {
    return <div style={{ padding: 40 }}><div className="skel" style={{ height: 120 }} /></div>
  }

  // A valid Supabase login with no gov_profiles row. Not an error -- the portal
  // is invite-only, so this is simply somebody who is not a government user, and
  // the honest thing is to say so and offer the way out rather than render an
  // empty dashboard they will read as "the system is broken".
  if (!profile) return <NoAccess error={profileErr} />
  if (profile.status !== 'active') return <NoAccess deactivated />

  const Page = PAGES[screen]
  const shared = {
    profile, dims, crop, setCrop, season, setSeason, district, setDistrict,
    alerts, go, say,
    cropRow: dims?.crops.find((c) => c.id === crop) ?? null,
    seasonRow: dims?.seasons.find((s) => s.id === season) ?? null,
  }
  const unacked = alerts.filter((a) => !a.resolved && a.severity === 'high').length

  return (
    <div className="app">
      <aside className={'side' + (menuOpen ? ' open' : '')} id="side">
        <div className="brand"><i><Icon name="leaf" size={13} /></i>Smart Agriculture</div>

        <nav className="nav">
          {navTree(profile).map((n) =>
            n.single ? (
              <button key={n.single.id}
                      className={'ni ' + (screen === n.single.id ? 'on' : '')}
                      onClick={() => { go(n.single.id); setMenuOpen(false) }}>
                <Icon name={n.single.icon} />{n.single.nav}
              </button>
            ) : (
              <div key={n.group}
                   className={'grp ' + (openGroups[n.group] || groupOf(screen) === n.group ? 'open' : '')}>
                <button className="ni"
                        aria-expanded={Boolean(openGroups[n.group] || groupOf(screen) === n.group)}
                        onClick={() => setOpenGroups((g) => ({
                          ...g, [n.group]: !(g[n.group] || groupOf(screen) === n.group),
                        }))}>
                  <Icon name={n.icon} />{n.group}
                  <span className="chev"><Icon name="chev" size={13} /></span>
                </button>
                <div className="sub-list">
                  {n.items.map((s) => (
                    <button key={s.id} className={'si ' + (screen === s.id ? 'on' : '')}
                            onClick={() => { go(s.id); setMenuOpen(false) }}>
                      {s.nav}
                    </button>
                  ))}
                </div>
              </div>
            )
          )}
        </nav>

        <button className="ni signout" onClick={() => supabase.auth.signOut()}>
          <Icon name="out" />Sign out
        </button>
      </aside>

      <div className="main">
        <header className="top">
          <button className="icon-btn burger" aria-label="Open menu"
                  onClick={() => setMenuOpen((o) => !o)}>
            <Icon name="menu" />
          </button>

          {/* The scope the signed-in account actually has, stated in the chrome
              rather than left to be inferred from a short district list. */}
          <ThemeToggle />
          <span className="demo-pill hide-m">
            {profile.tier === 'super_admin'
              ? 'Province-wide'
              : `${profile.gov_districts?.name ?? 'District'} only`}
          </span>

          {dims && (
            <>
              <div className="sel hide-m">
                <span>Crop</span>
                <select value={crop ?? ''} aria-label="Crop"
                        onChange={(e) => setCrop(e.target.value)}>
                  {dims.crops.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name.charAt(0).toUpperCase() + c.name.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sel hide-m">
                <span>Season</span>
                <select value={season ?? ''} aria-label="Season"
                        onChange={(e) => setSeason(e.target.value)}>
                  {[...dims.seasons].reverse().map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          <button className="icon-btn" aria-label={`Alerts (${unacked} high severity)`}
                  onClick={() => go('risk')}>
            <Icon name="bell" size={15} />
            {unacked > 0 && <b>{unacked}</b>}
          </button>

          <div className="userpill">
            <span className="av">{initials(profile.full_name)}</span>
            {roleLabel(profile)}
          </div>
        </header>

        <main className="page" id="page">
          {dimsErr ? (
            <div className="err"><b>Could not load the portal's reference data.</b>
              {String(dimsErr.message)}</div>
          ) : !dims ? (
            <div className="skel" style={{ height: 240 }} />
          ) : !Page ? (
            <div className="err"><b>Unknown screen.</b>No screen is registered for “{screen}”.</div>
          ) : (
            // Keyed on the screen so a thrown render in one page does not leave
            // the boundary latched when the user navigates away.
            <ErrorBoundary key={screen} screen={screenById(screen)?.title}>
              <Page {...shared} />
            </ErrorBoundary>
          )}
        </main>

        <footer className="foot">
          Sources: Google Earth Engine · Sentinel-2 L2A · Pakistan Bureau of Statistics ·
          OpenLandMap. Read-only analytical portal; it holds no individual farm records.
        </footer>
      </div>

      <Toast message={toast} />
    </div>
  )
}

const initials = (name) =>
  String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

function NoAccess({ deactivated, error }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div className="card" style={{ maxWidth: 440, padding: '24px' }}>
        <h1 style={{ font: '700 20px var(--display)', marginBottom: 6 }}>
          {deactivated ? 'This account has been deactivated' : 'No portal access'}
        </h1>
        <p className="sub" style={{ marginBottom: 14 }}>
          {deactivated
            ? 'Your sign-in is valid, but the account has been deactivated and its data access '
              + 'has been withdrawn. Contact whoever provisioned it to have it reactivated.'
            : 'Your sign-in worked, but this address has not been provisioned for the government '
              + 'portal. Access is granted by a district manager or the provincial administrator; '
              + 'there is no self-registration.'}
        </p>
        {error && <div className="err" style={{ marginBottom: 12 }}>
          <b>Profile lookup failed.</b>{String(error.message)}</div>}
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div>
  )
}
