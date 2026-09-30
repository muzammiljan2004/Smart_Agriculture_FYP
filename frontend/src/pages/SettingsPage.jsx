import { useEffect, useState } from 'react'
import { getJSON } from '../lib/api'
import { supabase } from '../supabase'
import { Badge, Button, Card, CardHead, NotWired, PageHead, Row } from '../components/ui'

const SECTIONS = [
  ['profile', 'Profile'],
  ['notifications', 'Notifications'],
  ['data', 'Data Sources'],
  ['model', 'Model Settings'],
  ['account', 'Account Preferences'],
]

/** /health, which is the only place the running model describes itself. */
function useHealth() {
  const [h, setH] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let alive = true
    getJSON('/health')
      .then((d) => alive && setH(d))
      .catch((e) => alive && setErr(e.message))
    return () => { alive = false }
  }, [])
  return { h, err }
}

/** A switch that is rendered but cannot be saved.
 *
 * There is no user-preferences table and no route that accepts one, so a
 * working-looking toggle would silently discard whatever the farmer chose.
 * Disabled and labelled is the honest version.
 */
function DeadToggle({ label, sub, on }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-leaf-100 py-3.5 last:border-0">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
      </div>
      <span aria-disabled="true"
            className={'relative h-6 w-11 shrink-0 rounded-full opacity-50 ' +
              (on ? 'bg-leaf-500' : 'bg-leaf-100')}>
        <span className={'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ' +
          (on ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </div>
  )
}

export default function SettingsPage({ farms, email }) {
  const [section, setSection] = useState('profile')
  const { h, err } = useHealth()

  return (
    <div className="space-y-5">
      <PageHead title="Settings" sub="Manage your account, alerts and data preferences" />

      <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
        <Card pad="p-2" className="h-fit">
          {SECTIONS.map(([id, label]) => (
            <button key={id} onClick={() => setSection(id)}
                    className={'block w-full rounded-xl px-4 py-2.5 text-left text-sm transition ' +
                      (section === id ? 'bg-leaf-100 font-semibold text-leaf-800' : 'text-ink/80 hover:bg-leaf-50')}>
              {label}
            </button>
          ))}
        </Card>

        <div className="space-y-5">
          {section === 'profile' && (
            <Card>
              <CardHead title="Profile" />
              <div className="mt-5 flex flex-wrap items-center gap-4">
                <span className="grid h-14 w-14 place-items-center rounded-full bg-leaf-100 font-display text-lg font-semibold text-leaf-800">
                  {(email || '?').slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="font-display text-lg font-semibold">{email}</p>
                  <p className="text-sm text-muted">
                    {farms.length} farm{farms.length === 1 ? '' : 's'}
                    {farms[0] ? ` · ${farms[0].district}` : ''}
                  </p>
                </div>
              </div>
              <div className="mt-6">
                <NotWired
                  what="Name and phone cannot be edited here."
                  why="The account holds an email and a password; there is no profile table storing
                       a display name or phone number. The names shown across the app are the
                       farm names you entered when adding each farm."
                />
              </div>
            </Card>
          )}

          {section === 'notifications' && (
            <Card>
              <CardHead title="Notifications" />
              <div className="mt-3">
                <DeadToggle label="Critical alerts" sub="Email when a critical alert opens" on />
                <DeadToggle label="Warnings" sub="Email for warning-level alerts" on />
                <DeadToggle label="Satellite imagery updates" sub="In-app only" on={false} />
                <DeadToggle label="Weekly summary" sub="Every Monday" on />
              </div>
              <div className="mt-5">
                <NotWired
                  what="These switches are not saved."
                  why="No preferences table exists and no route accepts one, so a working-looking
                       toggle would discard your choice. The service does send alert email when
                       GMAIL_USER and GMAIL_APP_PASSWORD are configured; that is currently the
                       only notification path and it is on for every alert it raises."
                />
              </div>
            </Card>
          )}

          {section === 'data' && (
            <Card>
              <CardHead title="Data sources" />
              <div className="mt-3">
                <Row label="Optical satellite" value="Sentinel-2 L2A · Google Earth Engine" />
                <Row label="Radar satellite" value="Sentinel-1 GRD · descending orbit" />
                <Row label="Revisit" value="~5 days, cloud permitting" />
                <Row label="Soil" value="OpenLandMap / SoilGrids" />
                <Row label="Weather" value="Open-Meteo, 10-year climatology" />
                <Row label="Yield ground truth" value="Pakistan Bureau of Statistics" />
                <Row label="District boundaries" value="FAO GAUL 2015 level 2" />
              </div>
              <p className="mt-4 text-xs text-muted">
                Read from the pipeline as built. Imagery is fetched per farm on request rather
                than on a schedule — there is no background refresh job.
              </p>
            </Card>
          )}

          {section === 'model' && (
            <Card>
              <CardHead title="Model settings" />
              <div className="mt-3">
                {err && <p className="text-sm text-red-700">{err}</p>}
                {h && (
                  <>
                    <Row label="Yield model" value={h.model ?? '—'} />
                    <Row label="Training source" value={h.training_source ?? '—'} />
                    <Row label="Training rows" value={h.training_rows ?? '—'} />
                    <Row label="Crops the model predicts"
                         value={<span className="capitalize">{(h.trained_crops ?? []).join(', ') || '—'}</span>} />
                    <Row label="Units" value="t/ha · hectares" />
                  </>
                )}
              </div>
              <div className="mt-5">
                <NotWired
                  what="Read-only."
                  why="Model choice, spread display and units are fixed by the trained artifact and
                       the pipeline. Changing them means retraining and redeploying, not toggling
                       a setting."
                />
              </div>
            </Card>
          )}

          {section === 'account' && (
            <Card>
              <CardHead title="Account preferences" />
              <div className="mt-3">
                <Row label="Signed in as" value={email} />
                <Row label="Language" value={<Badge tone="grey">English only</Badge>} />
              </div>
              <div className="mt-5">
                <NotWired
                  what="Urdu is not available."
                  why="The interface has no translation layer; every string is written in English
                       in the components. Listing Urdu as a choice would imply it works."
                />
              </div>
              <div className="mt-5">
                <Button variant="ghost" onClick={() => supabase.auth.signOut()}>Sign out</Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
