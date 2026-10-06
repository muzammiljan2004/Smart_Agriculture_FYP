import { useState } from 'react'
import { fmtDate, title } from '../lib/fmt'
import {
  Button, Card, Chip, Empty, Kpi, PageHead, Panel, Provenance, TableWrap,
} from '../lib/ui'
import {
  DESIGNATIONS, TIERS, canManageAccounts, provisionableTier, roleLabel,
} from '../lib/access'
import { fetchProfiles, provisionProfile, updateProfile } from '../lib/queries'
import { useQuery } from '../lib/useQuery'
import { dbError } from '../../lib/dbError'

/**
 * Screen 14 — user and access management.
 *
 * THREE DISTINCT VIEWS, as the brief specifies, and each is the direct
 * consequence of a policy rather than a UI choice:
 *
 *   Super admin      sees every district and its manager; may create and
 *                    deactivate DISTRICT MANAGERS and change their district.
 *   District manager sees only their own district's employees; may create and
 *                    deactivate EMPLOYEES and change their designation.
 *   Employee         sees their own account only, with no controls.
 *
 * The scoping is not done here. gov_profiles has two SELECT policies -- your own
 * row, plus whatever gov_can_read(district_id) allows -- so a district manager's
 * query simply does not return another district's rows. This screen renders what
 * came back.
 *
 * NOBODY CAN EDIT THEIR OWN ROW, including a super admin. That is deliberate and
 * is how "an employee must never be able to elevate their own designation" is
 * guaranteed: there is no UPDATE policy under which a caller's own row is a legal
 * target, so it is not a check that a cleverly shaped request could slip past.
 */
export default function RolesPage({ dims, profile, say }) {
  const q = useQuery(() => fetchProfiles(), [])
  const [adding, setAdding] = useState(false)
  const mayManage = canManageAccounts(profile)
  const canCreate = provisionableTier(profile)

  if (!mayManage) return <EmployeeView profile={profile} />

  return (
    <>
      <PageHead
        title="User & access management"
        sub={profile.tier === 'super_admin'
          ? 'Every district and the manager responsible for it'
          : `Employees in ${profile.gov_districts?.name}`}
      >
        {canCreate && (
          <Button variant="dark" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : `Add ${TIERS[canCreate].toLowerCase()}`}
          </Button>
        )}
      </PageHead>

      <Panel q={q} skeleton={260}>
        {(rows) => {
          const managers = rows.filter((r) => r.tier === 'district_manager')
          const employees = rows.filter((r) => r.tier === 'employee')
          const managed = profile.tier === 'super_admin' ? managers : employees

          return (
            <>
              <div className="grid g4">
                {profile.tier === 'super_admin' ? (
                  <>
                    <Kpi label="Districts" value={dims.districts.length} sub="In the province" />
                    <Kpi label="District managers" value={managers.length}
                         sub={`${managers.filter((m) => m.status === 'active').length} active`} />
                    <Kpi label="Districts without a manager"
                         value={dims.districts.filter((d) =>
                           !managers.some((m) => m.district_id === d.id && m.status === 'active')).length}
                         sub="No one can provision staff there" />
                    <Kpi label="Employees" value={employees.length}
                         sub="Created by their district managers" />
                  </>
                ) : (
                  <>
                    <Kpi label="Employees" value={employees.length}
                         sub={profile.gov_districts?.name} />
                    <Kpi label="Active" value={employees.filter((e) => e.status === 'active').length}
                         sub="Can sign in and read data" />
                    {Object.entries(DESIGNATIONS).slice(0, 2).map(([k, label]) => (
                      <Kpi key={k} label={label}
                           value={employees.filter((e) => e.designation === k).length}
                           sub={k === 'analyst' ? 'Read-only' : 'May submit surveys'} />
                    ))}
                  </>
                )}
              </div>

              {adding && canCreate && (
                <ProvisionForm me={profile} tier={canCreate} dims={dims} say={say}
                               onDone={() => { setAdding(false); q.reload() }} />
              )}

              {profile.tier === 'super_admin' && (
                <Card title="Districts without an active manager"
                      sub="Nobody can provision staff or verify surveys in these">
                  {(() => {
                    const orphans = dims.districts.filter((d) =>
                      !managers.some((m) => m.district_id === d.id && m.status === 'active'))
                    return orphans.length === 0 ? (
                      <p className="sub">Every district has an active manager.</p>
                    ) : (
                      <div className="row">
                        {orphans.map((d) => <Chip key={d.id} tone="a">{d.name}</Chip>)}
                      </div>
                    )
                  })()}
                </Card>
              )}

              <Card
                title={profile.tier === 'super_admin' ? 'District managers' : 'Employees'}
                sub={profile.tier === 'super_admin'
                  ? 'Created and scoped by you'
                  : `Created and scoped by you, within ${profile.gov_districts?.name}`}
              >
                {managed.length === 0 ? (
                  <Empty what={`No ${profile.tier === 'super_admin' ? 'district managers' : 'employees'} yet.`}>
                    {canCreate && `Use “Add ${TIERS[canCreate].toLowerCase()}” above. `}
                    An account needs a Supabase auth user first — see the note on the form.
                  </Empty>
                ) : (
                  <TableWrap>
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th><th>Role</th>
                          {profile.tier === 'super_admin' ? <th>District</th> : <th>Designation</th>}
                          <th>Created</th><th>Status</th><th />
                        </tr>
                      </thead>
                      <tbody>
                        {managed.map((u) => (
                          <tr key={u.id}>
                            <td>
                              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                                <span className="av">{initials(u.full_name)}</span>
                                <b>{u.full_name}</b>
                              </div>
                            </td>
                            <td><span className="sub">{roleLabel(u)}</span></td>

                            {profile.tier === 'super_admin' ? (
                              <td>
                                <select className="inp" style={{ width: 'auto', padding: '4px 8px' }}
                                        value={u.district_id ?? ''}
                                        aria-label={`District for ${u.full_name}`}
                                        onChange={async (e) => {
                                          try {
                                            await updateProfile(u.id, { district_id: e.target.value })
                                            say(`${u.full_name} reassigned`); q.reload()
                                          } catch (err) { say(dbError(err)) }
                                        }}>
                                  {dims.districts.map((d) => (
                                    <option key={d.id} value={d.id}>{d.name}</option>
                                  ))}
                                </select>
                              </td>
                            ) : (
                              <td>
                                <select className="inp" style={{ width: 'auto', padding: '4px 8px' }}
                                        value={u.designation ?? ''}
                                        aria-label={`Designation for ${u.full_name}`}
                                        onChange={async (e) => {
                                          try {
                                            await updateProfile(u.id, { designation: e.target.value })
                                            say(`${u.full_name} updated`); q.reload()
                                          } catch (err) { say(dbError(err)) }
                                        }}>
                                  {Object.entries(DESIGNATIONS).map(([k, l]) => (
                                    <option key={k} value={k}>{l}</option>
                                  ))}
                                </select>
                              </td>
                            )}

                            <td className="sub">{fmtDate(u.created_at)}</td>
                            <td>
                              <Chip tone={u.status === 'active' ? '' : 'n'}>{title(u.status)}</Chip>
                            </td>
                            <td>
                              <Button size="sm" onClick={async () => {
                                const next = u.status === 'active' ? 'deactivated' : 'active'
                                try {
                                  await updateProfile(u.id, { status: next })
                                  say(`${u.full_name} ${next}`); q.reload()
                                } catch (err) { say(dbError(err)) }
                              }}>
                                {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
                <Provenance>
                  Deactivating withdraws data access immediately: every read policy checks
                  `status = 'active'`, so the account keeps its login but stops seeing rows.
                  Accounts are never deleted — that would orphan the surveys they submitted and
                  break the chain recording who provisioned whom.
                </Provenance>
              </Card>

              <Card title="What each role can do" sub="Enforced in the database, not in this screen">
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>Capability</th>
                        <th style={{ textAlign: 'center' }}>Super Admin</th>
                        <th style={{ textAlign: 'center' }}>District Manager</th>
                        <th style={{ textAlign: 'center' }}>Agriculture / District Officer</th>
                        <th style={{ textAlign: 'center' }}>Analyst</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ['Read analytics', 'All districts', 'Own district', 'Own district', 'Own district'],
                        ['Submit field surveys', 'No', 'No', 'Yes', 'No'],
                        ['Verify / reject surveys', 'Yes, in scope', 'Own district', 'No', 'No'],
                        ['Register / verify datasets', 'Province-wide', 'Own district', 'No', 'No'],
                        ['Create accounts', 'District managers', 'Employees in own district', 'No', 'No'],
                        ['Edit own account', 'No', 'No', 'No', 'No'],
                        ['Write analytical tables', 'No', 'No', 'No', 'No'],
                      ].map((r) => (
                        <tr key={r[0]}>
                          <td>{r[0]}</td>
                          {r.slice(1).map((c, i) => (
                            <td key={i} style={{ textAlign: 'center' }}
                                className={c === 'No' ? 'sub' : undefined}>
                              {c}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
                <Provenance>
                  The design offered an editable permission matrix with tick boxes. It is shown
                  read-only here because these capabilities are RLS policies, not rows: a tick box
                  would have to rewrite a Postgres policy to mean anything, and one that only
                  changed a frontend flag would claim to grant access it cannot grant. Changing
                  them is a migration.
                  <br />
                  “Write analytical tables” is No for every role including the provincial
                  administrator — predictions, indices, alerts and targeting come from the pipeline
                  under a service key and have no client write policy at all.
                </Provenance>
              </Card>
            </>
          )
        }}
      </Panel>
    </>
  )
}

/** The employee view: own account, no controls. */
function EmployeeView({ profile }) {
  return (
    <>
      <PageHead title="Your account" sub="Read-only. Accounts are managed by your district manager." />
      <Card title="Account details">
        <div className="row" style={{ gap: 12, marginBottom: 12 }}>
          <span className="av" style={{ width: 44, height: 44, fontSize: 14 }}>
            {initials(profile.full_name)}
          </span>
          <div>
            <b style={{ fontSize: 14 }}>{profile.full_name}</b>
            <p className="sub">
              {roleLabel(profile)} · {profile.gov_districts?.name ?? 'No district'}
            </p>
          </div>
        </div>
        <TableWrap>
          <table>
            <tbody>
              <tr><td className="lbl">Role tier</td>
                <td style={{ textAlign: 'right' }}>{TIERS[profile.tier]}</td></tr>
              <tr><td className="lbl">Designation</td>
                <td style={{ textAlign: 'right' }}>
                  {DESIGNATIONS[profile.designation] ?? '—'}
                </td></tr>
              <tr><td className="lbl">District</td>
                <td style={{ textAlign: 'right' }}>{profile.gov_districts?.name ?? '—'}</td></tr>
              <tr><td className="lbl">Account created</td>
                <td style={{ textAlign: 'right' }}>{fmtDate(profile.created_at)}</td></tr>
              <tr><td className="lbl">Status</td>
                <td style={{ textAlign: 'right' }}>{title(profile.status)}</td></tr>
            </tbody>
          </table>
        </TableWrap>
        <Provenance>
          You cannot change your own designation or district, and neither can anyone at your level
          — the database has no update policy that would allow it. Ask your district manager.
        </Provenance>
      </Card>
    </>
  )
}

function ProvisionForm({ me, tier, dims, say, onDone }) {
  const [form, setForm] = useState({
    email: '', password: '', fullName: '',
    designation: 'agriculture_officer',
    districtId: me.tier === 'district_manager' ? me.district_id : (dims.districts[0]?.id ?? ''),
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [done, setDone] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Card title={`Add a ${TIERS[tier].toLowerCase()}`}
          sub="Creates the login and the profile together">
      <form onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true); setErr(null); setDone(null)
        try {
          await provisionProfile(me, {
            email: form.email.trim().toLowerCase(),
            password: form.password,
            fullName: form.fullName.trim(),
            tier,
            designation: form.designation,
            districtId: form.districtId,
          })
          say(`${form.fullName} provisioned`)
          // The password is shown back once, because nobody can retrieve it
          // afterwards -- it is a bcrypt hash the moment it reaches Supabase.
          setDone({ email: form.email.trim().toLowerCase(), password: form.password })
          setForm((f) => ({ ...f, email: '', password: '', fullName: '' }))
          onDone()
        } catch (e2) { setErr(e2) } finally { setBusy(false) }
      }}>
        <div className="field">
          <label htmlFor="pv-email">Email</label>
          <input id="pv-email" type="email" value={form.email} onChange={set('email')}
                 required autoComplete="off" placeholder="officer@punjab-agri.gov.pk" />
        </div>
        <div className="field">
          <label htmlFor="pv-pass">Initial password</label>
          <input id="pv-pass" type="text" value={form.password} onChange={set('password')}
                 required minLength={8} autoComplete="new-password"
                 placeholder="at least 8 characters" />
          <p className="sub">
            Shown as plain text on purpose — you have to read it out to hand it over, and
            it cannot be recovered afterwards. Tell them to change it on first sign-in.
          </p>
        </div>
        <div className="field">
          <label htmlFor="pv-name">Full name</label>
          <input id="pv-name" value={form.fullName} onChange={set('fullName')} required maxLength={120} />
        </div>

        {tier === 'employee' && (
          <div className="field">
            <label htmlFor="pv-desig">Designation</label>
            <select id="pv-desig" value={form.designation} onChange={set('designation')}>
              {Object.entries(DESIGNATIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor="pv-dist">District</label>
          {/* A district manager cannot choose: their own district is the only
              legal value and the insert policy pins it, so the control is fixed
              rather than offering options the database would refuse. */}
          <select id="pv-dist" value={form.districtId} onChange={set('districtId')}
                  disabled={me.tier === 'district_manager'}>
            {(me.tier === 'district_manager'
              ? dims.districts.filter((d) => d.id === me.district_id)
              : dims.districts
            ).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {me.tier === 'district_manager' && (
            <p className="sub">Fixed to your own district.</p>
          )}
        </div>

        {err && <div className="err" style={{ marginBottom: 10 }}>
          <b>Could not provision.</b>{dbError(err, 'The account could not be created.')}
        </div>}

        {done && (
          <div className="warn" style={{ marginBottom: 10 }}>
            <b>Account created. Hand these over now.</b>
            <br />
            <code>{done.email}</code> · <code>{done.password}</code>
            <br />
            The password is a hash from here on — this is the only time it is shown.
          </div>
        )}

        <Button variant="dark" type="submit" disabled={busy}>
          {busy ? 'Creating…' : `Create ${TIERS[tier].toLowerCase()}`}
        </Button>
      </form>

      <Provenance>
        The login is created by the ML service, which holds the service-role key —
        never by this bundle. It re-checks the hierarchy before writing anything,
        because that key bypasses row-level security, and it deletes the login again
        if the profile insert fails so a failed attempt leaves nothing behind.
      </Provenance>
    </Card>
  )
}

const initials = (name) =>
  String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
