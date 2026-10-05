import { useState } from 'react'
import { supabase } from '../supabase'
import Icon from './lib/icons'

/**
 * Sign-in only. There is NO sign-up on this screen and no route to one.
 *
 * That is the brief's central access rule rather than an omission: the portal is
 * invite-only, every account is provisioned by the tier above it, and a self
 * registration form would let anyone with the URL create an account that then
 * needs manually deleting. The farmer portal's Auth.jsx does offer sign-up,
 * which is why this is a separate component rather than a reused one -- the two
 * have opposite requirements.
 *
 * Signing in with a Supabase account that has no gov_profiles row succeeds at
 * the auth layer and is then stopped by GovApp, which says so plainly. Leaking
 * nothing matters more here than a tidy error: the message must not reveal
 * whether an address belongs to a government user.
 */
export default function GovAuth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setErr(error.message)
    // On success GovApp's onAuthStateChange swaps the screen.
  }

  return (
    <div className="auth-bg" style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20,
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: '26px 24px' }}>
        <div className="brand" style={{ paddingBottom: 14 }}>
          <i><Icon name="leaf" size={13} /></i>
          Smart Agriculture
        </div>
        <h1 style={{ font: '700 22px var(--display)', marginBottom: 4 }}>Government Portal</h1>
        <p className="sub" style={{ marginBottom: 18 }}>
          Punjab Agriculture Department · authorised accounts only
        </p>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="gov-email">Official email</label>
            <input id="gov-email" type="email" required autoComplete="username"
                   value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="gov-pass">Password</label>
            <input id="gov-pass" type="password" required autoComplete="current-password"
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          {err && <div className="err" style={{ marginBottom: 10 }}><b>Sign-in failed.</b>{err}</div>}

          <button className="btn dark" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="prov" style={{ marginTop: 14 }}>
          Accounts are issued by your district manager or the provincial administrator.
          There is no self-registration. If you cannot sign in, ask whoever provisioned
          your account to check that it is still active.
        </p>
      </div>
    </div>
  )
}
