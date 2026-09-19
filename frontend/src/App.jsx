import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import Auth from './Auth'
import FarmForm from './FarmForm'
import Dashboard from './Dashboard'
import Logo from './Logo'

export default function App() {
  const [session, setSession] = useState(null)
  const [farms, setFarms] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [loading, setLoading] = useState(true)

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

  if (!session) return <Auth />

  const selected = farms.find((f) => f.id === selectedId) ?? null
  const showForm = adding || farms.length === 0

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-[1000] border-b border-leaf-100 bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Logo className="h-7 w-7" />
            <span className="font-display text-lg font-semibold tracking-tight">Smart Agriculture</span>
          </div>

          <div className="flex items-center gap-3 text-sm">
            {farms.length > 0 && !showForm && (
              <select
                value={selectedId ?? ''}
                onChange={(e) => setSelectedId(e.target.value)}
                className="max-w-[14rem] rounded-lg border border-leaf-100 bg-white px-3 py-1.5
                           outline-none transition focus:border-leaf-400"
                aria-label="Select farm"
              >
                {farms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.farmer_name} — {f.district}
                  </option>
                ))}
              </select>
            )}

            {!showForm ? (
              <button
                onClick={() => setAdding(true)}
                className="rounded-lg bg-leaf-700 px-3 py-1.5 font-medium text-white transition hover:bg-leaf-800"
              >
                + Farm
              </button>
            ) : (
              farms.length > 0 && (
                <button
                  onClick={() => setAdding(false)}
                  className="rounded-lg px-3 py-1.5 font-medium text-leaf-700 transition hover:bg-leaf-100"
                >
                  Cancel
                </button>
              )
            )}

            <button
              onClick={() => supabase.auth.signOut()}
              className="rounded-lg px-3 py-1.5 font-medium text-leaf-700 transition hover:bg-leaf-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="px-4 py-8">
        {loading ? (
          <p className="text-center text-muted">Loading…</p>
        ) : showForm ? (
          <FarmForm
            onCreated={async (farm) => {
              setAdding(false)
              await loadFarms()
              setSelectedId(farm.id) // land on the farm just created
            }}
          />
        ) : selected ? (
          <Dashboard farm={selected} farmCount={farms.length} />
        ) : null}
      </main>

      <footer className="px-4 pb-10 text-center text-xs text-muted">
        Sentinel-2 · Google Earth Engine · Random Forest — FYP checkpoint build
      </footer>
    </div>
  )
}
