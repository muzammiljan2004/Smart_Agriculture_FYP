import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import ResearchAuth from './ResearchAuth'
import ErrorBoundary from '../gov/lib/ErrorBoundary'
import Icon from '../gov/lib/icons'
import { Toast } from '../gov/lib/ui'
import { groupOf, navTree, roleLabel, screenById, visibleScreens } from './lib/access'
import { fetchCrops, fetchDistricts, fetchMyProfile, fetchSeasons } from './lib/queries'
import PAGES from './pages'

/* The shell. Same structure as GovApp -- the same sidebar grid, the same gates,
 * the same hash routing -- because the two portals share a stylesheet and
 * should share a feel. What differs is what gates on what: this one has no
 * district scope, and its navigation is filtered by capability flags rather
 * than by tier alone.
 *
 * The crop/season/district selection is hoisted here for the same reason the
 * other two portals hoist theirs: a crop chosen on the comparison screen must
 * still be the crop when the explorer opens, and pages that own their own copy
 * of it drift apart.
 */

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

/** A valid Supabase login with no researcher account.
 *
 * Not an error: the portal is invite-only, so this is simply somebody who is
 * not a researcher. Saying so and offering the way out beats rendering an empty
 * dashboard they will read as "the system is broken".
 */
function NoAccess({ deactivated, error }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div className="card" style={{ maxWidth: 480, padding: '24px 22px' }}>
        <h1 style={{ font: '500 20px var(--serif)', marginBottom: 6 }}>
          {deactivated ? 'This account is deactivated' : 'No researcher portal access'}
        </h1>
        <p className="sub" style={{ marginBottom: 14 }}>
          {deactivated
            ? 'Your sign-in worked, but the account has been deactivated. A research '
              + 'lead can reactivate it on the access screen.'
            : 'Your sign-in worked, but this address has no researcher portal account. '
              + 'The portal is invite-only — a research lead or the platform '
              + 'administrator has to provision one.'}
        </p>
        {error && <p className="prov">Detail: {String(error.message || error)}</p>}
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div>
  )
}

export default function ResearchApp() {
  const [session, setSession] = useState(undefined)   // undefined = still checking
  const [profile, setProfile] = useState(undefined)
  const [profileErr, setProfileErr] = useState(null)
  const [dims, setDims] = useState(null)
  const [dimsErr, setDimsErr] = useState(null)

  const [crop, setCrop] = useState(null)
  const [season, setSeason] = useState(null)
  const [district, setDistrict] = useState(null)
  const [toast, setToast] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [openGroups, setOpenGroups] = useState({ 'Model Operations': true })

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
        // Defaults mirror the government portal's: wheat where available, the
        // most recent season, and no district filter -- a researcher has no
        // district scope, so "all" is the honest starting view.
        setCrop((c) => c ?? (crops.find((x) => x.name === 'wheat') ?? crops[0])?.id ?? null)
        setSeason((s) => s ?? seasons[seasons.length - 1]?.id ?? null)
      })
      .catch((e) => live && setDimsErr(e))
    return () => { live = false }
  }, [active])

  /* ---------------------------------------------------------------- routing */
  const screens = useMemo(() => visibleScreens(profile), [profile])
  const ids = useMemo(() => screens.map((s) => s.id), [screens])
  const [screen, go] = useHashRoute(ids, 'dashboard')

  useEffect(() => {
    const s = screenById(screen)
    if (s) document.title = `${s.title} · Smart Agriculture Researcher Portal`
  }, [screen])

  /* ----------------------------------------------------------------- gates */
  if (session === undefined) {
    return <div style={{ padding: 40 }}><div className="skel" style={{ height: 120 }} /></div>
  }
  if (!session) return <ResearchAuth />

  if (profile === undefined) {
    return <div style={{ padding: 40 }}><div className="skel" style={{ height: 120 }} /></div>
  }
  if (!profile) return <NoAccess error={profileErr} />
  if (profile.status !== 'active') return <NoAccess deactivated />

  const Page = PAGES[screen]
  const shared = {
    profile, dims, dimsErr, crop, setCrop, season, setSeason, district, setDistrict,
    go, say,
    cropRow: dims?.crops.find((c) => c.id === crop) ?? null,
    seasonRow: dims?.seasons.find((s) => s.id === season) ?? null,
    districtRow: dims?.districts.find((d) => d.id === district) ?? null,
  }

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

          {/* What this account can actually DO, stated in the chrome. A
              researcher should not have to discover their own permissions by
              finding a screen that offers nothing. */}
          <span className="demo-pill hide-m">
            {profile.can_run_models && profile.can_train_models ? 'Run + train'
              : profile.can_train_models ? 'Train only'
                : profile.can_run_models ? 'Run only'
                  : 'Read only'}
          </span>

          <span className="userpill">
            <span className="av">
              {(profile.full_name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('')}
            </span>
            {profile.full_name}
            <span className="sub" style={{ marginLeft: 6 }}>{roleLabel(profile)}</span>
          </span>
        </header>

        <main className="page">
          {/* Remounted per screen: an error thrown on one page must not leave
              the next one wedged behind the same boundary. */}
          <ErrorBoundary key={screen}>
            {Page ? <Page {...shared} /> : <p className="sub">Unknown screen.</p>}
          </ErrorBoundary>
        </main>
      </div>

      {toast && <Toast key={toast.id} message={toast.text} />}
    </div>
  )
}
