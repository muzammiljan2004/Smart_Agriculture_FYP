import { useMemo, useState } from 'react'
import { Card, Empty, PageHead, Panel, Provenance, TableWrap } from '../../gov/lib/ui'
import { fmtDate } from '../../gov/lib/fmt'
import { useQuery } from '../../gov/lib/useQuery'
import { FlagToggle, Select } from '../lib/rui'
import {
  TIERS, canManageAccounts, isSuperAdmin, provisionableTiers, roleLabel,
} from '../lib/access'
import { fetchProfiles, provisionProfile, updateProfile } from '../lib/queries'

/**
 * Screen 11 — user & access management.
 *
 * Three views out of one component, because the brief describes three and they
 * differ in what they can do rather than in what they look like:
 *
 *   super_admin    the research leads, created and deactivated here
 *   research_lead  their own researchers, with both flags set independently
 *   researcher     their own account and its flags, read-only, no controls
 *
 * NOBODY CAN EDIT THEIR OWN ROW, at any tier. That is not a check in this file
 * -- it is the absence of a self-update policy in the migration, so the
 * escalation does not exist rather than being guarded against. Every row below
 * belonging to the signed-in account renders without controls for that reason,
 * and the note says so.
 *
 * CREATING A LOGIN IS NOT DONE HERE. Provisioning takes an existing
 * auth.users id: making a Supabase auth user needs the admin API and the
 * service_role key, which is not in this bundle and must never be. Same
 * two-step as the government portal -- an administrator adds the user in
 * Studio, then this grants the tier.
 */
export default function AccessPage({ profile, say }) {
  const q = useQuery(() => fetchProfiles(), [])
  const mayManage = canManageAccounts(profile)
  const canCreate = provisionableTiers(profile)

  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({
    email: '', password: '', fullName: '',
    tier: canCreate[canCreate.length - 1] ?? 'researcher',
    canRun: false, canTrain: false,
  })
  const [err, setErr] = useState(null)
  const [done, setDone] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [creating, setCreating] = useState(false)

  const rows = q.data || []
  const leads = useMemo(() => rows.filter((r) => r.tier === 'research_lead'), [rows])
  const researchers = useMemo(() => rows.filter((r) => r.tier === 'researcher'), [rows])
  const admins = useMemo(() => rows.filter((r) => r.tier === 'super_admin'), [rows])

  async function create(e) {
    e.preventDefault()
    setErr(null)
    setDone(null)
    if (!form.fullName.trim()) return setErr('A full name is required.')
    if (form.password.length < 8) {
      return setErr('The password must be at least 8 characters.')
    }
    setCreating(true)
    try {
      await provisionProfile(profile, {
        email: form.email.trim().toLowerCase(),
        password: form.password,
        fullName: form.fullName.trim(),
        tier: form.tier,
        canRun: form.canRun,
        canTrain: form.canTrain,
      })
      say(`${TIERS[form.tier]} account created`)
      // Shown back once, because nobody can retrieve it afterwards -- it is a
      // bcrypt hash the moment it reaches Supabase.
      setDone({ email: form.email.trim().toLowerCase(), password: form.password })
      setForm((f) => ({ ...f, email: '', password: '', fullName: '' }))
      q.reload()
    } catch (e2) {
      // The service's own refusal, verbatim: it names the tier that was refused
      // or the address that is already taken, which is the accurate reason.
      setErr(String(e2.message || e2))
    } finally {
      setCreating(false)
    }
  }

  async function patch(row, change) {
    setBusyId(row.id)
    try {
      await updateProfile(row.id, change)
      say('Account updated')
      q.reload()
    } catch (e) {
      say(String(e.message || e))
    } finally {
      setBusyId(null)
    }
  }

  const Row = ({ r }) => {
    const self = r.id === profile.id
    const editable = mayManage && !self && r.tier === 'researcher'
    // A super admin may also deactivate a lead; a lead may not.
    const togglable = mayManage && !self
      && (isSuperAdmin(profile) ? r.tier !== 'super_admin' : r.tier === 'researcher')
    return (
      <tr>
        <td>
          <b>{r.full_name}</b>
          {self && <span className="sub" style={{ fontSize: 10 }}> · you</span>}
          <p className="sub" style={{ fontSize: 10.5 }}>{r.id.slice(0, 8)}</p>
        </td>
        <td className="sub">{roleLabel(r)}</td>
        <td>
          {r.tier === 'researcher' ? (
            <div className="row" style={{ gap: 6 }}>
              <span className={'r-badge ' + (r.can_run_models ? 'approved' : 'archived')}>
                <i />run
              </span>
              <span className={'r-badge ' + (r.can_train_models ? 'approved' : 'archived')}>
                <i />train
              </span>
            </div>
          ) : (
            <span className="sub" style={{ fontSize: 10.5 }}>both, implied by tier</span>
          )}
        </td>
        <td>
          <span className={'r-badge ' + (r.status === 'active' ? 'approved' : 'archived')}>
            <i />{r.status}
          </span>
        </td>
        <td className="sub">{fmtDate(r.created_at)}</td>
        {mayManage && (
          <td>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {editable && (
                <>
                  <button className="btn sm" disabled={busyId === r.id}
                          onClick={() => patch(r, { can_run_models: !r.can_run_models })}>
                    {r.can_run_models ? 'Revoke run' : 'Grant run'}
                  </button>
                  <button className="btn sm" disabled={busyId === r.id}
                          onClick={() => patch(r, { can_train_models: !r.can_train_models })}>
                    {r.can_train_models ? 'Revoke train' : 'Grant train'}
                  </button>
                </>
              )}
              {togglable && (
                <button className="btn sm" disabled={busyId === r.id}
                        onClick={() => patch(r, {
                          status: r.status === 'active' ? 'deactivated' : 'active',
                        })}>
                  {r.status === 'active' ? 'Deactivate' : 'Reactivate'}
                </button>
              )}
              {self && <span className="sub" style={{ fontSize: 10.5 }}>no self-edit</span>}
            </div>
          </td>
        )}
      </tr>
    )
  }

  const Table = ({ title, sub, list, emptyWhat, emptyWhy }) => (
    <Card title={title} sub={sub}>
      {list.length === 0 ? <Empty what={emptyWhat} why={emptyWhy} /> : (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Account</th><th>Tier</th><th>Permissions</th>
                <th>Status</th><th>Created</th>{mayManage && <th />}
              </tr>
            </thead>
            <tbody>{list.map((r) => <Row key={r.id} r={r} />)}</tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  )

  return (
    <>
      <PageHead title="User & access management"
                sub={mayManage ? 'Accounts you provision and the flags they carry'
                               : 'Your account and its permissions'}>
        {canCreate.length > 0 && !adding && (
          <button className="btn sm dark" onClick={() => { setErr(null); setAdding(true) }}>
            Create an account
          </button>
        )}
      </PageHead>

      {/* ---------------------------------------------------- researcher view */}
      {!mayManage && (
        <Card title="Your account" sub="Read-only — permissions are set by a research lead">
          <div className="list-row">
            <div className="grow">
              <b>{profile.full_name}</b>
              <p>{profile.email ?? profile.id.slice(0, 8)} · {roleLabel(profile)}</p>
            </div>
            <span className="r-badge approved"><i />{profile.status}</span>
          </div>

          <div className="r-flags" style={{ marginTop: 12 }}>
            <FlagToggle locked checked={Boolean(profile.can_run_models)}
                        label="can_run_models"
                        hint="Run any existing model version against a dataset to evaluate it. Never trains anything." />
            <FlagToggle locked checked={Boolean(profile.can_train_models)}
                        label="can_train_models"
                        hint="Train a new model or retrain an existing one, and upload dataset versions. Always produces a candidate." />
          </div>

          <Provenance>
            You cannot change your own flags or tier — there is no policy that permits
            it, for any account including the administrator's. Ask the research lead who
            provisioned you. Both analytical and comparison screens remain fully
            available whatever these flags say.
          </Provenance>
        </Card>
      )}

      {/* ------------------------------------------------------- provisioning */}
      {adding && canCreate.length > 0 && (
        <Card title="Create an account"
              sub={`You may create: ${canCreate.map((t) => TIERS[t]).join(', ')}`}>
          <form onSubmit={create}>
            <div className="grid g2" style={{ marginBottom: 0 }}>
              <div className="field">
                <label htmlFor="ac-email">Email</label>
                <input id="ac-email" type="email" value={form.email} required
                       autoComplete="off" placeholder="researcher@example.org"
                       onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ac-name">Full name</label>
                <input id="ac-name" value={form.fullName} required
                       onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="ac-pass">Initial password</label>
              <input id="ac-pass" type="text" value={form.password} required minLength={8}
                     autoComplete="new-password" placeholder="at least 8 characters"
                     onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <p className="sub">
                Plain text on purpose — you have to read it out to hand it over, and it
                cannot be recovered afterwards. Tell them to change it on first sign-in.
              </p>
            </div>

            <div className="r-filters" style={{ marginBottom: 10 }}>
              <Select label="Tier" value={form.tier} all={null}
                      onChange={(v) => setForm({ ...form, tier: v || 'researcher' })}
                      options={canCreate.map((t) => ({ value: t, label: TIERS[t] }))} />
            </div>

            {form.tier === 'researcher' ? (
              <div className="r-flags">
                <FlagToggle name="canRun" checked={form.canRun}
                            onChange={(v) => setForm({ ...form, canRun: v })}
                            label="can_run_models"
                            hint="May run any existing model version against a dataset to evaluate it. Never trains." />
                <FlagToggle name="canTrain" checked={form.canTrain}
                            onChange={(v) => setForm({ ...form, canTrain: v })}
                            label="can_train_models"
                            hint="May train and retrain, and upload dataset versions. Always produces a candidate." />
              </div>
            ) : (
              <p className="sub" style={{ fontSize: 12 }}>
                A research lead carries both flags implicitly — the database constraint
                requires it, so there is nothing to choose here.
              </p>
            )}

            {err && <div className="err" style={{ marginTop: 10 }}><b>Could not create the account.</b>{err}</div>}

            {done && (
              <div className="r-warn" style={{ marginTop: 10 }}>
                <b>Account created. Hand these over now.</b>
                <code>{done.email}</code> · <code>{done.password}</code>
                <br />
                The password is a hash from here on — this is the only time it is shown.
              </div>
            )}

            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button className="btn dark" type="submit" disabled={creating}>
                {creating ? 'Creating…' : 'Create account'}
              </button>
              <button className="btn" type="button"
                      onClick={() => { setAdding(false); setErr(null); setDone(null) }}>
                {done ? 'Done' : 'Cancel'}
              </button>
            </div>
          </form>

          <Provenance>
            The login is created by the ML service, which holds the service-role key —
            never by this bundle. Because that key bypasses row-level security, the
            service re-checks the hierarchy in Python before writing anything, and it
            deletes the login again if the profile insert fails so a failed attempt
            leaves nothing behind. Neither tier can create one equal to or above
            itself: a super admin creates leads and researchers, a lead creates
            researchers only.
          </Provenance>
        </Card>
      )}

      {/* ------------------------------------------------------- manager views */}
      {mayManage && (
        <Panel q={q} skeleton={240}
               empty={<Empty what="No accounts are visible to you."
                             why="A lead sees the researchers they created. If you have created none yet, that is why this is empty." />}>
          {() => (
            <>
              {isSuperAdmin(profile) && (
                <>
                  <Table title="Research leads" sub="Created and deactivated by you"
                         list={leads}
                         emptyWhat="No research leads yet."
                         emptyWhy="Create one above; they then provision their own researchers." />
                  {admins.length > 0 && (
                    <Table title="Super admins" sub="Not editable from this portal"
                           list={admins}
                           emptyWhat="" emptyWhy="" />
                  )}
                </>
              )}

              <Table title="Researchers"
                     sub={isSuperAdmin(profile)
                       ? 'All researchers' : 'The researchers you created'}
                     list={researchers}
                     emptyWhat="No researcher accounts yet."
                     emptyWhy="Create one above and set its flags independently — an account may have one, both, or neither." />

              <Provenance>
                A deactivated account loses data access immediately: every RLS helper
                checks <code>status = 'active'</code>, so suspending an account revokes
                it without touching a policy. Accounts are never deleted — model runs and
                dataset uploads point at them, and removing one would erase the
                attribution on work that may be cited in a report.
                {profile.mirrored && (
                  <>
                    {' '}Your own access is mirrored from your government portal super
                    admin role, so you have no editable row in this table.
                  </>
                )}
              </Provenance>
            </>
          )}
        </Panel>
      )}
    </>
  )
}
