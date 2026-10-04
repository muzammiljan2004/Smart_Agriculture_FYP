import { useState } from 'react'
import GovMap from '../GovMap'
import { f1, fmtDate, title } from '../lib/fmt'
import {
  Button, Card, Chip, Empty, Kpi, MapLegendItems, PageHead, Panel, Provenance, Tabs, TableWrap,
} from '../lib/ui'
import { canReviewSurvey, canSubmitSurvey } from '../lib/access'
import { districtCells } from '../lib/geo'
import { fetchSurveys, reviewSurvey, submitSurvey } from '../lib/queries'
import { useQuery } from '../lib/useQuery'

const TYPES = {
  crop_type: ['Crop type', '#e0a23a'],
  sowing_date: ['Sowing date', '#4aa0c4'],
  harvest_progress: ['Harvest progress', '#6fae52'],
  yield_cut: ['Yield cut', '#8a4fa0'],
}

/**
 * Screen 11 — field survey.
 *
 * The only screen where an employee writes, and the write is gated on
 * DESIGNATION, not tier: an analyst is an employee too and does not do field work.
 * The gate here mirrors the "gov officers submit surveys" policy; the policy is
 * what enforces it. officer_id, district_id and status are never taken from the
 * form — they come from the session and the profile, so there is no field a user
 * could edit to file a survey against another district.
 *
 * This screen is also the project's binding constraint made visible. Validating
 * the harvest detector needs 20–30 confirmed harvest dates, and a `yield_cut` or
 * `harvest_progress` survey is how one arrives. The counter at the top says how
 * far along that is, because it is the single most useful number on the screen.
 */
export default function SurveyPage({ dims, profile, say, go }) {
  const q = useQuery(() => fetchSurveys(), [])
  const [filter, setFilter] = useState('all')
  const mayWrite = canSubmitSurvey(profile)
  const mayReview = canReviewSurvey(profile)

  return (
    <>
      <PageHead title="Field survey"
                sub="Officer observations, used to validate what the model predicts">
        <Chip tone="n">
          {mayWrite ? 'You may submit surveys'
            : mayReview ? 'You may verify or reject' : 'Read-only for your designation'}
        </Chip>
      </PageHead>

      <Panel q={q} skeleton={280}>
        {(rows) => {
          const verified = rows.filter((r) => r.status === 'verified')
          const pending = rows.filter((r) => r.status === 'pending')
          const groundTruth = verified.filter((r) =>
            r.harvest_date || r.survey_type === 'yield_cut' || r.survey_type === 'harvest_progress')
          const visible = filter === 'all' ? rows : rows.filter((r) => r.survey_type === filter)
          const cells = districtCells(dims.districts)

          return (
            <>
              <div className="grid g4">
                <Kpi label="Surveys submitted" value={rows.length}
                     sub={`${pending.length} awaiting review`} />
                <Kpi label="Verified" value={verified.length}
                     sub={rows.length ? `${Math.round((verified.length / rows.length) * 100)}% of submissions` : '—'} />
                <Kpi label="Harvest ground truth" value={`${groundTruth.length} / 25`}
                     sub="Needed to validate the harvest detector" />
                <Kpi label="Your district"
                     value={profile.tier === 'super_admin' ? 'All' : (profile.gov_districts?.name ?? '—')}
                     sub={profile.tier === 'super_admin' ? 'Province-wide' : 'Submissions are scoped here'} />
              </div>

              {groundTruth.length < 25 && (
                <Empty what={`${25 - groundTruth.length} more confirmed harvest observations needed.`}>
                  The satellite harvest detector (app/harvest.py) has never been scored, because
                  scoring it needs 20–30 real harvest dates. Until then harvest progress cannot be
                  published as a provincial statistic — which is why
                  {' '}<button className="btn sm" onClick={() => go('harvest')}>Harvest Monitoring</button>{' '}
                  is empty. A “yield cut” or “harvest progress” survey with a date is what moves
                  this counter.
                </Empty>
              )}

              <div className="grid g32">
                <Card title="Survey locations" sub="Where observations have been recorded">
                  <GovMap
                    id="survey-map" height={380} data={cells} fillOpacity={0.2}
                    fill={() => '#ffffff'}
                    tip={(d) => {
                      const n = rows.filter((r) => r.district_id === d.id).length
                      return `<b>${d.name}</b><br>${n} survey${n === 1 ? '' : 's'}`
                    }}
                    points={rows.filter((r) => r.gps_lat != null && r.gps_lng != null).map((r) => ({
                      lat: Number(r.gps_lat), lng: Number(r.gps_lng),
                      c: TYPES[r.survey_type]?.[1] ?? '#9aa79f',
                      tip: `<b>${TYPES[r.survey_type]?.[0]}</b> · ${r.gov_districts?.name}`
                        + `<br>${r.observed_value ?? ''} · ${r.status}`,
                    }))}
                    legend={<MapLegendItems title="Survey type"
                                            items={Object.values(TYPES).map(([l, c]) => [l, c])} />}
                  />
                  <Provenance>
                    Only surveys with coordinates are plotted. District shading is uniform — a
                    survey count is not a measurement of the district.
                  </Provenance>
                </Card>

                {mayWrite
                  ? <SurveyForm dims={dims} profile={profile} say={say} onDone={q.reload} />
                  : (
                    <Card title="New survey" sub="Not available with your designation">
                      <Empty what="Only agriculture officers and district officers may submit.">
                        Your account is {profile.tier === 'employee'
                          ? `an employee with the ${title(profile.designation?.replace(/_/g, ' ') ?? '')} designation`
                          : `a ${profile.tier.replace(/_/g, ' ')}`}.
                        The database enforces this, not just this screen: the insert policy on
                        gov_field_surveys checks the designation, so a request made outside this
                        form is refused the same way.
                        {mayReview && ' You can verify or reject submissions in the table below.'}
                      </Empty>
                    </Card>
                  )}
              </div>

              <Card title="Survey records" sub="Most recent first">
                <Tabs
                  items={[['all', 'All'], ...Object.entries(TYPES).map(([k, v]) => [k, v[0]])]}
                  value={filter} onChange={setFilter}
                />
                {visible.length === 0 ? (
                  <Empty what="No surveys recorded yet."
                         why="Submissions appear here as soon as an officer files one." />
                ) : (
                  <TableWrap>
                    <table>
                      <thead>
                        <tr>
                          <th>Submitted</th><th>District</th><th>Type</th><th>Crop</th>
                          <th>Season</th><th>Observation</th><th>Status</th>
                          {mayReview && <th />}
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((r) => (
                          <tr key={r.id}>
                            <td className="sub">{fmtDate(r.submitted_at)}</td>
                            <td><b>{r.gov_districts?.name ?? '—'}</b></td>
                            <td>
                              <span style={{
                                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                background: TYPES[r.survey_type]?.[1], marginRight: 6,
                              }} />
                              {TYPES[r.survey_type]?.[0] ?? r.survey_type}
                            </td>
                            <td>{title(r.gov_crops?.name ?? '—')}</td>
                            <td>{r.gov_seasons?.label ?? '—'}</td>
                            <td>
                              {r.verified_yield != null ? `${f1(r.verified_yield, 2)} t/ha`
                                : r.harvest_date ? `harvested ${r.harvest_date}`
                                  : r.sowing_date ? `sown ${r.sowing_date}`
                                    : (r.observed_value ?? '—')}
                            </td>
                            <td>
                              <Chip tone={r.status === 'verified' ? '' : r.status === 'pending' ? 'n' : 'r'}>
                                {title(r.status)}
                              </Chip>
                            </td>
                            {mayReview && (
                              <td>
                                {r.status === 'pending' ? (
                                  <div className="row" style={{ gap: 5, flexWrap: 'nowrap' }}>
                                    <Button size="sm" onClick={async () => {
                                      try {
                                        await reviewSurvey(r.id, 'verified', profile.id)
                                        say('Survey verified'); q.reload()
                                      } catch (e) { say(e.message) }
                                    }}>Verify</Button>
                                    <Button size="sm" onClick={async () => {
                                      try {
                                        await reviewSurvey(r.id, 'rejected', profile.id)
                                        say('Survey rejected'); q.reload()
                                      } catch (e) { say(e.message) }
                                    }}>Reject</Button>
                                  </div>
                                ) : (
                                  <span className="sub">
                                    {r.reviewed_at ? fmtDate(r.reviewed_at) : ''}
                                  </span>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
                <Provenance>
                  A verified survey records who adjudicated it and when. An unattributed
                  “verified” is not verification, so the reviewer is a required column on the
                  table and the database refuses a review without one.
                </Provenance>
              </Card>
            </>
          )
        }}
      </Panel>
    </>
  )
}

function SurveyForm({ dims, profile, say, onDone }) {
  const [form, setForm] = useState({
    survey_type: 'yield_cut',
    crop_id: dims.crops[0]?.id ?? '',
    season_id: dims.seasons[dims.seasons.length - 1]?.id ?? '',
    sowing_date: '', harvest_date: '', verified_yield: '',
    observed_value: '', notes: '', gps_lat: '', gps_lng: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await submitSurvey(profile, form)
      say('Survey submitted for review')
      setForm((f) => ({ ...f, verified_yield: '', observed_value: '', notes: '', harvest_date: '' }))
      onDone()
    } catch (e2) {
      setErr(e2)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="New survey" sub={`Filed for ${profile.gov_districts?.name ?? 'your district'}`}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="sv-type">Survey type</label>
          <select id="sv-type" value={form.survey_type} onChange={set('survey_type')}>
            {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
          </select>
        </div>

        <div className="grid g2" style={{ margin: 0 }}>
          <div className="field">
            <label htmlFor="sv-crop">Crop</label>
            <select id="sv-crop" value={form.crop_id} onChange={set('crop_id')}>
              {dims.crops.map((c) => <option key={c.id} value={c.id}>{title(c.name)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sv-season">Season</label>
            <select id="sv-season" value={form.season_id} onChange={set('season_id')}>
              {[...dims.seasons].reverse().map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* The fields shown follow the survey type, so an officer filing a yield
            cut is not asked for a sowing date and a date field is never left to
            be guessed from a free-text value. */}
        {form.survey_type === 'sowing_date' && (
          <div className="field">
            <label htmlFor="sv-sow">Sowing date observed</label>
            <input id="sv-sow" type="date" value={form.sowing_date} onChange={set('sowing_date')} required />
          </div>
        )}

        {(form.survey_type === 'harvest_progress' || form.survey_type === 'yield_cut') && (
          <div className="field">
            <label htmlFor="sv-harv">
              Harvest date observed
              {form.survey_type === 'yield_cut' ? '' : ' (leave blank if still standing)'}
            </label>
            <input id="sv-harv" type="date" value={form.harvest_date} onChange={set('harvest_date')}
                   required={form.survey_type === 'yield_cut'} />
          </div>
        )}

        {form.survey_type === 'yield_cut' && (
          <div className="field">
            <label htmlFor="sv-yield">Measured yield (t/ha)</label>
            <input id="sv-yield" type="number" step="0.01" min="0" max="120"
                   value={form.verified_yield} onChange={set('verified_yield')} required />
          </div>
        )}

        {(form.survey_type === 'crop_type' || form.survey_type === 'harvest_progress') && (
          <div className="field">
            <label htmlFor="sv-obs">
              {form.survey_type === 'crop_type' ? 'Crop observed in the field' : 'Progress observed'}
            </label>
            <input id="sv-obs" value={form.observed_value} onChange={set('observed_value')}
                   placeholder={form.survey_type === 'crop_type' ? 'e.g. wheat, intercropped with onion'
                     : 'e.g. about 60% cut'} required />
          </div>
        )}

        <div className="grid g2" style={{ margin: 0 }}>
          <div className="field">
            <label htmlFor="sv-lat">Latitude (optional)</label>
            <input id="sv-lat" type="number" step="0.00001" min="-90" max="90"
                   value={form.gps_lat} onChange={set('gps_lat')} placeholder="31.5204" />
          </div>
          <div className="field">
            <label htmlFor="sv-lng">Longitude (optional)</label>
            <input id="sv-lng" type="number" step="0.00001" min="-180" max="180"
                   value={form.gps_lng} onChange={set('gps_lng')} placeholder="74.3587" />
          </div>
        </div>

        <div className="field">
          <label htmlFor="sv-notes">Notes</label>
          <textarea id="sv-notes" rows="2" value={form.notes} onChange={set('notes')} />
        </div>

        {err && <div className="err" style={{ marginBottom: 10 }}>
          <b>Could not submit.</b>{err.message}</div>}

        <Button variant="dark" type="submit" disabled={busy}>
          {busy ? 'Submitting…' : 'Submit for review'}
        </Button>
      </form>
      <Provenance>
        Filed as pending against your own district. Neither the district nor the status can be set
        from this form — the insert policy pins both to your profile, so a survey cannot be
        submitted pre-verified or against somebody else's district.
      </Provenance>
    </Card>
  )
}
