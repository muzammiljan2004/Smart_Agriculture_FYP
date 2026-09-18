import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import Auth from './Auth'
import FarmForm from './FarmForm'
import Dashboard from './Dashboard'
import Logo from './Logo'

export default function App() {
  const [session, setSession] = useState(null)
  const [farm, setFarm] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    // Fires on login, logout, and token refresh. Without it, a login would
    // update Supabase's storage but never re-render this component.
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) {
      setFarm(null)
      setLoading(false)
      return
    }
    setLoading(true)
    // No .eq('owner_id', ...) here on purpose: the RLS select policy already
    // restricts this to the caller's own farms. Filtering client-side would be
    // decoration -- the database is what enforces it.
    supabase
      .from('farms')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data, error }) => {
        if (error) console.error(error)
        setFarm(data?.[0] ?? null)
        setLoading(false)
      })
  }, [session])

  if (!session) return <Auth />

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-[1000] border-b border-leaf-100 bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Logo className="h-7 w-7" />
            <span className="font-display text-lg font-semibold tracking-tight">Smart Agriculture</span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-muted sm:inline">{session.user.email}</span>
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
        ) : farm ? (
          <Dashboard farm={farm} />
        ) : (
          <FarmForm onCreated={setFarm} />
        )}
      </main>

      <footer className="px-4 pb-10 text-center text-xs text-muted">
        Sentinel-2 · Google Earth Engine · Random Forest — FYP checkpoint build
      </footer>
    </div>
  )
}
