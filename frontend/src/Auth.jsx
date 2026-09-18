import { useState } from 'react'
import { supabase } from './supabase'
import Logo from './Logo'

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

  const field =
    'mt-1.5 w-full rounded-xl border border-leaf-100 bg-white px-4 py-3 text-ink ' +
    'placeholder:text-muted/60 outline-none transition ' +
    'focus:border-leaf-400 focus:ring-4 focus:ring-leaf-400/15'

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Left: the pitch. Hidden on phones, where it would just push the form down. */}
      <div className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-leaf-900 p-12 text-leaf-50">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              'radial-gradient(60rem 40rem at 15% 10%, #1b4d35 0%, transparent 60%),' +
              'radial-gradient(50rem 40rem at 85% 85%, #236344 0%, transparent 55%)',
          }}
        />
        {/* Field-row motif: parallel arcs, like contour-ploughed land seen from orbit. */}
        <svg aria-hidden="true" viewBox="0 0 400 400" className="absolute inset-0 h-full w-full opacity-[0.13]">
          {Array.from({ length: 14 }, (_, i) => (
            <path
              key={i}
              d={`M -40 ${60 + i * 26} Q 200 ${10 + i * 26} 440 ${100 + i * 26}`}
              stroke="#d7e9dd" strokeWidth="1.2" fill="none"
            />
          ))}
        </svg>

        <div className="relative flex items-center gap-3">
          <Logo className="h-9 w-9" />
          <span className="font-display text-xl font-semibold tracking-tight">Smart Agriculture</span>
        </div>

        <div className="relative max-w-md">
          <h1 className="font-display text-5xl leading-[1.05] font-semibold">
            Wheat yield,<br />forecast from orbit.
          </h1>
          <p className="mt-5 text-leaf-200 leading-relaxed">
            Sentinel-2 imagery over Sheikhupura, reduced to vegetation indices and
            run through a Random Forest — a yield estimate weeks before harvest.
          </p>
        </div>

        <dl className="relative grid grid-cols-3 gap-6 text-sm">
          {[
            ['10 m', 'resolution'],
            ['5 day', 'revisit'],
            ['t/ha', 'output'],
          ].map(([v, k]) => (
            <div key={k}>
              <dt className="font-display text-2xl font-semibold text-wheat-300">{v}</dt>
              <dd className="text-leaf-200/80">{k}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Right: the form. */}
      <div className="flex items-center justify-center p-6 sm:p-12">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo className="h-8 w-8" />
            <span className="font-display text-lg font-semibold">Smart Agriculture</span>
          </div>

          <h2 className="font-display text-3xl font-semibold">
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </h2>
          <p className="mt-2 text-sm text-muted">Farmer portal · Sheikhupura, Punjab</p>

          <div className="mt-8 space-y-4">
            <label className="block text-sm font-medium">
              Email
              <input
                type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com" autoComplete="email" className={field}
              />
            </label>
            <label className="block text-sm font-medium">
              Password
              <input
                type="password" required minLength={6} value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className={field}
              />
            </label>
          </div>

          {msg && (
            <p
              role="status"
              className={`mt-4 rounded-xl px-4 py-3 text-sm ${
                msg.type === 'err'
                  ? 'bg-red-50 text-red-700 ring-1 ring-red-100'
                  : 'bg-leaf-50 text-leaf-700 ring-1 ring-leaf-100'
              }`}
            >
              {msg.text}
            </p>
          )}

          <button
            type="submit" disabled={busy}
            className="mt-6 w-full rounded-xl bg-leaf-700 py-3 font-medium text-white shadow-sm
                       transition hover:bg-leaf-800 active:scale-[.99] disabled:opacity-60"
          >
            {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Sign up'}
          </button>

          <p className="mt-6 text-center text-sm text-muted">
            {mode === 'login' ? "Don't have an account?" : 'Already registered?'}{' '}
            <button
              type="button"
              onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMsg(null) }}
              className="font-medium text-leaf-600 underline underline-offset-4 hover:text-leaf-800"
            >
              {mode === 'login' ? 'Sign up' : 'Log in'}
            </button>
          </p>
        </form>
      </div>
    </div>
  )
}
