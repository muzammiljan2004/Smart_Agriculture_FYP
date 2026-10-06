import { useState } from 'react'
import { supabase } from './supabase'
import AuthShell, { AuthAlert, AuthField, AuthNote, AuthSubmit } from './auth/AuthShell'

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

  const switchTo = (m) => { setMode(m); setMsg(null) }

  return (
    <AuthShell
      portal="farmer"
      eyebrow="Farmer Portal"
      title="Wheat yield, forecast"
      accent="from orbit."
      lead="Sentinel-2 imagery over Punjab, reduced to vegetation indices and run through a Random Forest — a yield estimate weeks before harvest."
      points={[
        'Satellite crop monitoring, field by field',
        'Yield forecasts for your registered farms',
        'Water-stress and irrigation alerts',
      ]}
      stats={[['10 m', 'resolution'], ['5 day', 'revisit'], ['t/ha', 'output']]}
    >
      <span className="au-badge">Farmer portal</span>
      <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
      <p className="au-sub">
        {mode === 'login'
          ? 'Sign in to see your fields, forecasts and alerts.'
          : 'Register, add your farms, and start monitoring them.'}
      </p>

      <div className={'au-tabs' + (mode === 'signup' ? ' signup' : '')} role="group" aria-label="Log in or sign up">
        <button type="button" aria-pressed={mode === 'login'} onClick={() => switchTo('login')}>Log in</button>
        <button type="button" aria-pressed={mode === 'signup'} onClick={() => switchTo('signup')}>Sign up</button>
      </div>

      <form onSubmit={submit} className="au-form">
        <AuthField
          label="Email" icon="mail" type="email" required value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email"
        />
        {/* minLength on SIGNUP only. On login it would validate a credential
            that already exists -- an account created under an older, shorter
            rule could no longer sign in, and the form would refuse before the
            server ever got a chance to say "wrong password". 8 matches the
            minimum the government and researcher portals enforce (accounts.py
            MIN_PASSWORD), so one policy covers every account on the platform. */}
        <AuthField
          label="Password" icon="lock" type="password" required value={password}
          minLength={mode === 'signup' ? 8 : undefined}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        />

        {msg && <AuthAlert type={msg.type}>{msg.text}</AuthAlert>}

        <AuthSubmit busy={busy} busyLabel="Working…">
          {mode === 'login' ? 'Log in' : 'Sign up'}
        </AuthSubmit>
      </form>

      
    </AuthShell>
  )
}
