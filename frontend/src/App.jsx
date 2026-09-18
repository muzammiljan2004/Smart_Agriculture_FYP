import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import Auth from './Auth'
import FarmForm from './FarmForm'
import Dashboard from './Dashboard'

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
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <span className="font-semibold">Smart Agriculture</span>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-500">{session.user.email}</span>
            <button onClick={() => supabase.auth.signOut()} className="underline text-gray-600">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="p-4">
        {loading ? (
          <p className="text-center text-gray-500">Loading…</p>
        ) : farm ? (
          <Dashboard farm={farm} />
        ) : (
          <FarmForm onCreated={setFarm} />
        )}
      </main>
    </div>
  )
}
