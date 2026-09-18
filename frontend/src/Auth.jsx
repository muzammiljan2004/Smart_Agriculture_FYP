import { useState } from 'react'
import { supabase } from './supabase'

export default function Auth() {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    const fn = mode === 'login' ? supabase.auth.signInWithPassword : supabase.auth.signUp
    const { data, error } = await fn.call(supabase.auth, { email, password })
    setBusy(false)

    if (error) return setMsg({ type: 'err', text: error.message })
    // With "Confirm email" ON, signUp returns a user but no session -- the app
    // would sit on this screen with no explanation. Say so instead.
    if (mode === 'signup' && !data.session)
      return setMsg({ type: 'ok', text: 'Check your email to confirm, then log in.' })
    // Success: App's onAuthStateChange picks up the session and swaps the screen.
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-lg shadow p-6 space-y-4">
        <h1 className="text-xl font-semibold">Smart Agriculture</h1>
        <p className="text-sm text-gray-500">Farmer portal — Sheikhupura, Punjab</p>

        <input
          type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="Email" autoComplete="email"
          className="w-full border rounded px-3 py-2"
        />
        <input
          type="password" required minLength={6} value={password}
          onChange={(e) => setPassword(e.target.value)} placeholder="Password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          className="w-full border rounded px-3 py-2"
        />

        {msg && (
          <p className={`text-sm ${msg.type === 'err' ? 'text-red-600' : 'text-green-700'}`}>
            {msg.text}
          </p>
        )}

        <button
          type="submit" disabled={busy}
          className="w-full bg-green-700 text-white rounded py-2 disabled:opacity-50"
        >
          {busy ? '...' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>

        <button
          type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMsg(null) }}
          className="w-full text-sm text-gray-600 underline"
        >
          {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Log in'}
        </button>
      </form>
    </div>
  )
}
