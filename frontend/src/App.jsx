import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import Auth from './Auth'
import FarmForm from './FarmForm'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import { Modal } from './components/ui'
import { useFarmData } from './hooks/useFarmData'
import DashboardPage from './pages/DashboardPage'
import FarmsPage from './pages/FarmsPage'
import CropMonitoringPage from './pages/CropMonitoringPage'
import YieldPredictionPage from './pages/YieldPredictionPage'
import FieldIntelligencePage from './pages/FieldIntelligencePage'
import AlertsPage from './pages/AlertsPage'
import ReportsPage from './pages/ReportsPage'
import SettingsPage from './pages/SettingsPage'

/* NAVIGATION IS STATE, NOT A ROUTER.
 *
 * The design has eight destinations, two of which carry sub-tabs. react-router
 * would add a dependency, a build-time base path and a server rewrite rule for
 * deep links, in exchange for URLs this app never links into from outside. A
 * page id plus a tab id is the whole of it. If shareable URLs are wanted later,
 * everything routes through goTo() and that is the only place a router has to
 * reach. */

export default function App() {
  const [session, setSession] = useState(null)
  const [farms, setFarms] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState('dashboard')
  const [tab, setTab] = useState(null)
  const [menu, setMenu] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    // Fires on login, logout, and token refresh. Without it, a login would
    // update Supabase's storage but never re-render this component.
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const loadFarms = useCallback(async () => {
    // No .eq('owner_id', ...) on purpose: the RLS select policy already
    // restricts this to the caller's own farms. Filtering client-side would be
    // decoration -- the database is what enforces it.
    const { data, error } = await supabase
      .from('farms')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) console.error(error)
    setFarms(data ?? [])
    // Keep the current selection if it still exists; otherwise fall back to
    // the newest. Re-selecting blindly would bounce the user off the farm
    // they were looking at every time this refetches.
    setSelectedId((prev) =>
      prev && data?.some((f) => f.id === prev) ? prev : (data?.[0]?.id ?? null)
    )
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!session) {
      setFarms([])
      setSelectedId(null)
      setLoading(false)
      return
    }
    setLoading(true)
    loadFarms()
  }, [session, loadFarms])

  const selected = farms.find((f) => f.id === selectedId) ?? null

  // One fetch of prediction / suitability / time series for the selected farm,
  // shared by every page that needs it. Hoisted out of the old Dashboard so
  // that switching tabs does not refetch the same prediction each time.
  const data = useFarmData(selected)

  const goTo = useCallback((nextPage, nextTab = null) => {
    setPage(nextPage)
    setTab(nextTab)
    window.scrollTo({ top: 0 })
  }, [])

  if (!session) return <Auth />

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-muted">Loading…</div>
  }

  // First run: no farms yet, so the only useful screen is the form. Rendered
  // full-page rather than as a modal -- there is nothing behind it to return to.
  if (farms.length === 0) {
    return (
      <div className="min-h-screen px-4 py-12">
        <FarmForm onCreated={async (farm) => { await loadFarms(); setSelectedId(farm.id) }} />
      </div>
    )
  }

  const openAlerts = data.pred?.alerts ?? []

  const page_ = () => {
    // Every page but Alerts and Settings is about one farm; those two are
    // account-wide, which is why they take `farms` rather than `farm`.
    switch (page) {
      case 'farms':
        return <FarmsPage farms={farms} selectedId={selectedId} onSelect={setSelectedId}
                          onNavigate={goTo} onAddFarm={() => setAdding(true)} />
      case 'monitoring':
        return <CropMonitoringPage farm={selected} data={data} tab={tab ?? 'growth'}
                                   onTab={(t) => setTab(t)} />
      case 'yield':
        return <YieldPredictionPage farm={selected} data={data} />
      case 'field':
        return <FieldIntelligencePage farm={selected} data={data} tab={tab ?? 'indices'}
                                      onTab={(t) => setTab(t)} />
      case 'alerts':
        return <AlertsPage farms={farms} />
      case 'reports':
        return <ReportsPage farm={selected} farms={farms} selectedId={selectedId}
                            onSelect={setSelectedId} />
      case 'settings':
        return <SettingsPage farms={farms} email={session.user?.email} />
      default:
        return <DashboardPage farm={selected} data={data} onNavigate={goTo}
                              onAddFarm={() => setAdding(true)} />
    }
  }

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-leaf-100 bg-card lg:block">
        <Sidebar page={page} tab={tab} onNavigate={goTo} alertCount={openAlerts.length} />
      </aside>

      {/* Mobile drawer */}
      {menu && (
        <div className="fixed inset-0 z-[1200] lg:hidden" role="presentation"
             onClick={() => setMenu(false)}>
          <div className="absolute inset-0 bg-leaf-900/40 backdrop-blur-sm" />
          <aside className="absolute inset-y-0 left-0 w-72 bg-card shadow-xl"
                 onClick={(e) => e.stopPropagation()}>
            <Sidebar page={page} tab={tab} onNavigate={goTo}
                     alertCount={openAlerts.length} onClose={() => setMenu(false)} />
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <TopBar
          farms={farms}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={() => setAdding(true)}
          alerts={openAlerts}
          email={session.user?.email}
          onNavigate={goTo}
          onMenu={() => setMenu(true)}
        />

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          {selected ? page_() : <p className="text-muted">Select a farm to continue.</p>}
        </main>

        <footer className="px-6 pb-10 pt-4 text-xs text-muted">
          Sentinel-2 · Google Earth Engine · Random Forest — FYP checkpoint build
        </footer>
      </div>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add farm"
        sub="Add a field to start satellite monitoring. First results arrive within one imagery pass."
      >
        <FarmForm
          chrome={false}
          onCancel={() => setAdding(false)}
          onCreated={async (farm) => {
            setAdding(false)
            await loadFarms()
            setSelectedId(farm.id)   // land on the farm just created
            goTo('dashboard')
          }}
        />
      </Modal>
    </div>
  )
}
