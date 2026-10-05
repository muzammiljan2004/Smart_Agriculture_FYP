import { useState } from 'react'
import { supabase } from '../supabase'
import AuthShell, { AuIcon, AuthAlert, AuthField, AuthNote, AuthSubmit } from '../auth/AuthShell'

/**
 * Sign-in only. There is NO sign-up on this screen and no route to one.
 *
 * That is the brief's central access rule rather than an omission: the portal is
 * invite-only, every account is provisioned by the tier above it, and a self
 * registration form would let anyone with the URL create an account that then
 * needs manually deleting. The farmer portal's Auth.jsx does offer sign-up,
 * which is why this is a separate component rather than a reused one -- the two
 * have opposite requirements. (They share only the visual frame, AuthShell.)
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
    <AuthShell
      portal="gov"
      eyebrow="Government Portal"
      title="District insight,"
      accent="province-wide."
      lead="Read-only, district-level yield analysis across Punjab — for planning, procurement and subsidy decisions."
      points={[
        '15 analytical screens across 34 districts',
        'Yield forecasting, risk alerts and subsidy targeting',
        'Three-tier access: admin, district manager, officer',
      ]}
      stats={[['34', 'districts'], ['11', 'crops'], ['8', 'seasons']]}
    >
      <span className="au-badge"><AuIcon name="lock" size={13} />Invite only</span>
      <h2>Sign in</h2>
      <p className="au-sub">Punjab Agriculture Department · authorised accounts only</p>

      <form onSubmit={submit} className="au-form">
        <AuthField
          id="gov-email" label="Official email" icon="mail" type="email" required autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@agripunjab.gov.pk"
        />
        <AuthField
          id="gov-pass" label="Password" icon="lock" type="password" required autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password"
        />

        {err && <AuthAlert title="Sign-in failed.">{err}</AuthAlert>}

        <AuthSubmit busy={busy} busyLabel="Signing in…">Sign in</AuthSubmit>
      </form>

      <AuthNote>
        Accounts are issued by your district manager or the provincial administrator.
        There is no self-registration. If you cannot sign in, ask whoever provisioned
        your account to check that it is still active.
      </AuthNote>
    </AuthShell>
  )
}
