import { useState } from 'react'
import { supabase } from '../supabase'
import Icon from '../gov/lib/icons'

/**
 * Sign-in only. There is NO sign-up on this screen and no route to one.
 *
 * Same rule and same reason as the government portal: this is a closed,
 * invite-only portal, every account is provisioned by the tier above it, and a
 * self-registration form would let anyone with the URL create an account that
 * then needs manually deleting. The farmer portal's Auth.jsx does offer
 * sign-up, which is why this is a separate component rather than a shared one.
 *
 * Signing in with a Supabase account that has no research_profiles row succeeds
 * at the auth layer and is then stopped by ResearchApp, which says so plainly.
 * The message there must not reveal whether an address belongs to a researcher.
 */
export default function ResearchAuth() {
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
    // On success ResearchApp's onAuthStateChange swaps the screen.
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: 'var(--bg)', padding: 20,
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: '26px 24px' }}>
        <div className="brand" style={{ paddingBottom: 14 }}>
          <i><Icon name="leaf" size={13} /></i>
          Smart Agriculture
        </div>
        <h1 style={{ font: '500 22px var(--serif)', marginBottom: 4 }}>Researcher Portal</h1>
        <p className="sub" style={{ marginBottom: 18 }}>
          Dataset access and model evaluation · authorised accounts only
        </p>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="res-email">Email</label>
            <input id="res-email" type="email" required autoComplete="username"
                   value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="res-pass">Password</label>
            <input id="res-pass" type="password" required autoComplete="current-password"
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>

          {err && (
            <p style={{ color: 'var(--red)', fontSize: 12, margin: '2px 0 12px' }}>{err}</p>
          )}

          <button className="btn dark" type="submit" disabled={busy}
                  style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="prov" style={{ marginTop: 16 }}>
          Accounts are issued by a research lead or the platform administrator.
          There is no self-registration. If you cannot sign in, ask the lead who
          provisioned your account.
        </p>
      </div>
    </div>
  )
}
