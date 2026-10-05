import { useEffect, useState } from 'react'
import { fmtDate, title } from '../lib/fmt'
import { Card, Chip, Empty, PageHead, Provenance, TableWrap } from '../lib/ui'
import { DESIGNATIONS, TIERS, roleLabel } from '../lib/access'

const THEME_KEY = 'gov.theme'

/**
 * Screen 15 — settings.
 *
 * Only the preferences that genuinely take effect. The design's notification
 * toggles, model-settings panel and units selector are not reproduced as working
 * controls: there is no notification delivery for government users (alerts are a
 * dashboard view by design, and the brief is explicit that they are never sent),
 * the forecast model is a committed artefact rather than a runtime setting, and no
 * screen reads a units preference. A toggle that persists nothing teaches the user
 * that the portal does not do what it says.
 *
 * Appearance DOES work: it writes the data-theme attribute the stylesheet already
 * keys on, and localStorage is the right store for a per-viewer display choice.
 * gov/main.jsx applies the saved value at startup, defaulting to light.
 */
export default function SettingsPage({ profile, dims }) {
  const [tab, setTab] = useState('account')
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'light' } catch { return 'light' }
  })

  useEffect(() => {
    // Wrapped: localStorage throws in a private window and with site data
    // blocked, and a theme preference is not worth taking the screen down for.
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* not persisted */ }
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <>
      <PageHead title="Settings" sub="Your account and display preferences" />

      <div className="grid" style={{ gridTemplateColumns: '200px minmax(0,1fr)', alignItems: 'start' }}>
        <section className="card" style={{ padding: 8 }}>
          <div className="setnav">
            {[['account', 'Account'], ['appearance', 'Appearance'], ['scope', 'Data scope'],
              ['notifications', 'Notifications']].map(([k, l]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
        </section>

        {tab === 'account' && (
          <Card title="Account">
            <div className="row" style={{ gap: 12, marginBottom: 12 }}>
              <span className="av" style={{ width: 44, height: 44, fontSize: 14 }}>
                {String(profile.full_name || '?').split(/\s+/).slice(0, 2)
                  .map((w) => w[0]).join('').toUpperCase()}
              </span>
              <div>
                <b style={{ fontSize: 14 }}>{profile.full_name}</b>
                <p className="sub">
                  {roleLabel(profile)} · {profile.gov_districts?.name ?? 'Province-wide'}
                </p>
              </div>
            </div>
            <TableWrap>
              <table>
                <tbody>
                  <tr><td className="lbl">Role tier</td>
                    <td style={{ textAlign: 'right' }}>{TIERS[profile.tier]}</td></tr>
                  <tr><td className="lbl">Designation</td>
                    <td style={{ textAlign: 'right' }}>{DESIGNATIONS[profile.designation] ?? '—'}</td></tr>
                  <tr><td className="lbl">District</td>
                    <td style={{ textAlign: 'right' }}>{profile.gov_districts?.name ?? 'All'}</td></tr>
                  <tr><td className="lbl">Account created</td>
                    <td style={{ textAlign: 'right' }}>{fmtDate(profile.created_at)}</td></tr>
                  <tr><td className="lbl">Status</td>
                    <td style={{ textAlign: 'right' }}>{title(profile.status)}</td></tr>
                </tbody>
              </table>
            </TableWrap>
            <div className="warn" style={{ marginTop: 12, marginBottom: 0 }}>
              <b>Your name, role and district cannot be edited here.</b> There is no update policy
              in the database that lets any account modify its own row — including the provincial
              administrator's. Changes are made by the tier above yours.
            </div>
          </Card>
        )}

        {tab === 'appearance' && (
          <Card title="Appearance" sub="Stored in this browser only">
            <div className="field">
              <label htmlFor="st-theme">Theme</label>
              <select id="st-theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">Match system</option>
              </select>
            </div>
            <Provenance>
              Saved in this browser's local storage, so it does not follow you to another device and
              is not stored against your account. It takes effect immediately.
            </Provenance>
          </Card>
        )}

        {tab === 'scope' && (
          <Card title="Data scope" sub="What your account can read, and why">
            <TableWrap>
              <table>
                <tbody>
                  <tr>
                    <td className="lbl">Districts visible</td>
                    <td style={{ textAlign: 'right' }}>
                      {profile.tier === 'super_admin'
                        ? `All ${dims.districts.length}`
                        : dims.districts.map((d) => d.name).join(', ') || '—'}
                    </td>
                  </tr>
                  <tr><td className="lbl">Crops</td>
                    <td style={{ textAlign: 'right' }} className="mono">{dims.crops.length}</td></tr>
                  <tr><td className="lbl">Seasons</td>
                    <td style={{ textAlign: 'right' }} className="mono">{dims.seasons.length}</td></tr>
                  <tr><td className="lbl">Farm-level records</td>
                    <td style={{ textAlign: 'right' }}>None — no role in this portal can read one</td></tr>
                </tbody>
              </table>
            </TableWrap>
            <Provenance>
              The district list above is the result of a live query, not a setting: gov_districts is
              scoped by row-level security, so it returns exactly what your account may read. If it
              shows one district, that is the database's answer and no screen in this portal can
              widen it.
              <br />
              This portal holds no individual farm data. The farmer-side tables are governed by
              separate policies keyed to each grower's own user id, and nothing here joins to them.
            </Provenance>
          </Card>
        )}

        {tab === 'notifications' && (
          <Card title="Notifications" sub="Not implemented for government accounts">
            <Empty what="There is no notification delivery on this side of the system.">
              Risk alerts are a dashboard view, deliberately: the brief requires that authority-side
              alerts are never sent to farmers, and no government-facing mailer exists either.
              Showing toggles here would imply a digest that nobody receives.
              <br /><br />
              The farmer portal does email alerts, through a separate table (public.alerts) with its
              own per-grower policies. The two paths share nothing, which is what guarantees a
              provincial warning cannot reach a grower's inbox.
            </Empty>
            <div className="row" style={{ marginTop: 10 }}>
              <Chip tone="n">No scheduled digests</Chip>
              <Chip tone="n">No email integration</Chip>
            </div>
          </Card>
        )}
      </div>
    </>
  )
}
