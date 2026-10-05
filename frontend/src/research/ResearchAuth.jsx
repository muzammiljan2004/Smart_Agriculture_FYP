import { useState } from 'react'
import { supabase } from '../supabase'
import AuthShell, { AuIcon, AuthAlert, AuthField, AuthNote, AuthSubmit } from '../auth/AuthShell'

/**
 * Sign-in only. There is NO sign-up on this screen and no route to one.
 *
 * Same rule and same reason as the government portal: this is a closed,
 * invite-only portal, every account is provisioned by the tier above it, and a
 * self-registration form would let anyone with the URL create an account that
 * then needs manually deleting. The farmer portal's Auth.jsx does offer
 * sign-up, which is why this is a separate component rather than a shared one.
 * (They share only the visual frame, AuthShell.)
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
    <AuthShell
      portal="res"
      eyebrow="Researcher Portal"
      title="Data and models,"
      accent="under the microscope."
      lead="The dataset and the model behind the forecasts, with the evaluation that says how far to trust them."
      points={[
        'Dataset explorer and versioned snapshots',
        'Train, retrain and evaluate model versions',
        'Per-crop performance and feature importance',
      ]}
      stats={[['2,378', 'records'], ['11', 'crops'], ['8', 'seasons']]}
    >
      <span className="au-badge"><AuIcon name="lock" size={13} />Invite only</span>
      <h2>Sign in</h2>
      <p className="au-sub">Dataset access and model evaluation · authorised accounts only</p>

      <form onSubmit={submit} className="au-form">
        <AuthField
          id="res-email" label="Email" icon="mail" type="email" required autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@university.edu.pk"
        />
        <AuthField
          id="res-pass" label="Password" icon="lock" type="password" required autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password"
        />

        {err && <AuthAlert title="Sign-in failed.">{err}</AuthAlert>}

        <AuthSubmit busy={busy} busyLabel="Signing in…">Sign in</AuthSubmit>
      </form>

      <AuthNote>
        Accounts are issued by a research lead or the platform administrator.
        There is no self-registration. If you cannot sign in, ask the lead who
        provisioned your account.
      </AuthNote>
    </AuthShell>
  )
}
