import { useMemo, useState } from 'react'
import { Card, Empty, PageHead, Panel, Provenance, TableWrap } from '../../gov/lib/ui'
import { Bars } from '../../gov/lib/charts'
import { dash, f1, fmtDate } from '../../gov/lib/fmt'
import { downloadCsv } from '../../gov/lib/csv'
import { useQuery } from '../../gov/lib/useQuery'
import { ConfusionMatrix, JobChip, RunReport, Select, StatusBadge } from '../lib/rui'
import { MODEL_TYPES, STATUSES, STATUS_LONG } from '../lib/access'
import { fetchRuns } from '../lib/queries'

/**
 * Screen 4 — model performance comparison.
 *
 * Pulls from EVERY saved run and training, and filters nothing out by default.
 * The brief's worked example is the test this screen is built to pass: compare
 * the current production LSTM against two experimental candidate LSTMs and an
 * archived XGBoost run, in one view. So status is a filter like any other, it
 * starts at "all", and an archived model is as selectable as a live one.
 *
 * THE METRIC SPLIT IS THE HARD PART, and it is handled by segregating the table
 * rather than by blanking cells. Regression and classification runs go into two
 * separate tables with their own headers, because a single table with seven
 * metric columns and half of them empty per row invites exactly the misreading
 * the brief forbids -- someone reading an empty Accuracy column as "accuracy
 * zero" instead of "accuracy does not apply".
 */
/* THESE FILTERS ARE LOCAL, NOT THE APP-WIDE ONES, AND THAT IS DELIBERATE.
 *
 * Every other screen reads observations, where the shell's crop/season defaults
 * (wheat, newest season) are the honest starting view because every row carries
 * both. A model run does not: crop_id, district_id and season_id are an
 * OPTIONAL scope, null on any run trained across everything -- which is most of
 * them. Inheriting the shell's "2024-25" therefore hid every run behind a
 * filter the user never set, under a subtitle promising nothing was filtered.
 *
 * So this screen starts unfiltered and keeps its own state. A season chosen
 * here is "runs scoped to that season", which is a different question from the
 * one the sidebar's season answers, and conflating them is what caused the bug.
 */
export default function ComparisonPage({ dims, say }) {
  const [crop, setCrop] = useState(null)
  const [season, setSeason] = useState(null)
  const [district, setDistrict] = useState(null)
  const q = useQuery(() => fetchRuns(), [])
  const [modelType, setModelType] = useState(null)
  const [status, setStatus] = useState(null)
  const [kind, setKind] = useState(null)
  const [picked, setPicked] = useState([])

  const all = q.data || []

  const rows = useMemo(() => all.filter((r) => {
    if (r.job_status !== 'completed') return false
    if (crop && r.crop_id !== crop) return false
    if (district && r.district_id !== district) return false
    if (season && r.season_id !== season) return false
    if (modelType && r.model_type !== modelType) return false
    // An evaluation has no status of its own, so a status filter necessarily
    // narrows to trainings. Said out loud in the note under the filter bar.
    if (status && r.status !== status) return false
    if (kind && r.run_kind !== kind) return false
    return true
  }), [all, crop, district, season, modelType, status, kind])

  const regression = rows.filter((r) => r.output_type === 'regression')
  const classification = rows.filter((r) => r.output_type === 'classification')

  const selected = rows.filter((r) => picked.includes(r.id))
  const toggle = (id) => setPicked((p) =>
    p.includes(id) ? p.filter((x) => x !== id) : [...p, id])

  function exportTable() {
    downloadCsv(`model_comparison_${Date.now()}.csv`, rows.map((r) => ({
      run_id: r.id,
      kind: r.run_kind,
      version: r.version_label ?? '',
      model_type: r.model_type,
      status: r.status ?? '',
      output_type: r.output_type ?? '',
      crop: r.gov_crops?.name ?? '',
      district: r.gov_districts?.name ?? '',
      season: r.gov_seasons?.label ?? '',
      r2: r.r2 ?? '', rmse: r.rmse ?? '', mae: r.mae ?? '',
      accuracy: r.accuracy ?? '', precision: r.precision_score ?? '',
      recall: r.recall ?? '', f1: r.f1_score ?? '',
      completed_at: r.completed_at ?? '',
      triggered_by: r.research_profiles?.full_name ?? '',
    })))
    say(`Exported ${rows.length} runs`)
  }

  const label = (r) => r.version_label
    || `${r.model_type} ${r.run_kind === 'evaluation' ? 'eval' : ''} ${r.id.slice(0, 6)}`.trim()

  return (
    <>
      <PageHead title="Model performance comparison"
                sub="Every completed run and training. Nothing is filtered out by default." />

      <div className="r-filters">
        <Select label="Crop" value={crop} onChange={setCrop}
                options={dims?.crops ?? []} all="All crops" />
        <Select label="District" value={district} onChange={setDistrict}
                options={dims?.districts ?? []} all="All districts" />
        <Select label="Season" value={season} onChange={setSeason}
                options={(dims?.seasons ?? []).map((s) => ({ id: s.id, name: s.label }))}
                all="All seasons" />
        <Select label="Model type" value={modelType} onChange={setModelType}
                options={MODEL_TYPES.map((m) => ({ value: m, label: m }))} all="All types" />
        <Select label="Model status" value={status} onChange={setStatus}
                options={STATUSES.map((s) => ({ value: s, label: STATUS_LONG[s] }))}
                all="All statuses" />
        <Select label="Run kind" value={kind} onChange={setKind}
                options={[{ value: 'training', label: 'Trainings' },
                          { value: 'evaluation', label: 'Evaluations' }]} all="Both" />
        <div className="spacer" />
        <button className="btn sm" disabled={!rows.length} onClick={exportTable}>
          Export CSV
        </button>
      </div>

      <Panel q={q} skeleton={280}
             empty={<Empty what="No completed runs yet."
                           why="Trainings and evaluations appear here as soon as they finish, whoever ran them." />}>
        {() => rows.length === 0 ? (
          <Empty what={`No completed run matches this filter (${all.length} exist).`}
                 why={'Crop, district and season match a run\'s SCOPE, and a run trained '
                      + 'or evaluated across everything carries none — so those three '
                      + 'filters hide it. Status narrows to trainings too, because an '
                      + 'evaluation is not a model version and has no status.'} />
        ) : (
          <>
            {/* Side-by-side chart of whatever is ticked. Bars, not lines: these
                are unordered independent runs, and a line between them would
                imply a progression that does not exist. */}
            {selected.length > 0 && (
              <Card title={`Selected runs · ${selected.length}`}
                    sub="Tick rows below to compare"
                    right={<button className="btn sm" onClick={() => setPicked([])}>
                             Clear
                           </button>}>
                <div className="grid g2">
                  {selected.some((r) => r.output_type === 'regression') && (
                    <div>
                      <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 6 }}>
                        REGRESSION · R²
                      </p>
                      <Bars dec={3}
                            data={selected.filter((r) => r.output_type === 'regression')
                              .map((r) => ({ l: label(r), v: r.r2 }))}
                            alt="R squared by selected regression run" />
                    </div>
                  )}
                  {selected.some((r) => r.output_type === 'classification') && (
                    <div>
                      <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 6 }}>
                        CLASSIFICATION · F1
                      </p>
                      <Bars dec={3} max={1}
                            data={selected.filter((r) => r.output_type === 'classification')
                              .map((r) => ({ l: label(r), v: r.f1_score }))}
                            alt="F1 score by selected classification run" />
                    </div>
                  )}
                </div>

                {/* One run ticked: show its FULL report, since that is the
                    "tell me everything about this run" case. Several ticked:
                    the charts above are the comparison, and stacking five full
                    reports would bury it. */}
                {selected.length === 1 && (
                  <div style={{ marginTop: 14 }}>
                    <RunReport run={selected[0]} />
                  </div>
                )}

                {selected.length > 1 && selected.filter((r) => r.confusion_matrix).map((r) => (
                  <div key={r.id} style={{ marginTop: 14 }}>
                    <p className="sub" style={{ marginBottom: 6 }}>
                      <b style={{ display: 'inline' }}>{label(r)}</b> — confusion matrix
                    </p>
                    <ConfusionMatrix cm={r.confusion_matrix} />
                  </div>
                ))}

                <Provenance>
                  Regression and classification runs are charted separately and never on
                  one axis. R² and F1 are not comparable quantities, and putting them in
                  one bar group would invite a ranking that means nothing.
                </Provenance>
              </Card>
            )}

            {regression.length > 0 && (
              <Card title="Regression runs" sub="Yield value prediction · R², RMSE, MAE">
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 28 }} />
                        <th>Run</th><th>Type</th><th>Status</th>
                        <th>Crop</th><th>Season</th>
                        <th className="r-">R²</th><th className="r-">RMSE</th><th className="r-">MAE</th>
                        <th>Completed</th><th>By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {regression.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input type="checkbox" checked={picked.includes(r.id)}
                                   aria-label={`Compare ${label(r)}`}
                                   onChange={() => toggle(r.id)} />
                          </td>
                          <td>
                            <b>{label(r)}</b>
                            {r.run_kind === 'evaluation' && (
                              <span className="sub" style={{ fontSize: 10 }}> · evaluation</span>
                            )}
                          </td>
                          <td className="sub">{r.model_type}</td>
                          <td>{r.run_kind === 'training'
                            ? <StatusBadge status={r.status} />
                            : <span className="sub" style={{ fontSize: 10.5 }}>n/a</span>}</td>
                          <td>{r.gov_crops?.name ?? '—'}</td>
                          <td className="mono">{r.gov_seasons?.label ?? '—'}</td>
                          <td className="mono r-"
                              style={Number(r.r2) < 0 ? { color: 'var(--red)' } : undefined}>
                            {dash(r.r2, (v) => f1(v, 4))}
                          </td>
                          <td className="mono r-">{dash(r.rmse, (v) => f1(v, 3))}</td>
                          <td className="mono r-">{dash(r.mae, (v) => f1(v, 3))}</td>
                          <td className="sub">{fmtDate(r.completed_at || r.created_at)}</td>
                          <td className="sub">{r.research_profiles?.full_name ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
                <Provenance>
                  A negative R² means the run predicted its held-out values less well
                  than their own mean would have. Shown in red and reported as computed,
                  never clamped to zero.
                </Provenance>
              </Card>
            )}

            {classification.length > 0 && (
              <Card title="Classification runs"
                    sub="Categorical output · Accuracy, Precision, Recall, F1">
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 28 }} />
                        <th>Run</th><th>Type</th><th>Status</th>
                        <th>Crop</th><th>Season</th>
                        <th className="r-">Accuracy</th><th className="r-">Precision</th>
                        <th className="r-">Recall</th><th className="r-">F1</th>
                        <th>Completed</th><th>By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {classification.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input type="checkbox" checked={picked.includes(r.id)}
                                   aria-label={`Compare ${label(r)}`}
                                   onChange={() => toggle(r.id)} />
                          </td>
                          <td><b>{label(r)}</b></td>
                          <td className="sub">{r.model_type}</td>
                          <td>{r.run_kind === 'training'
                            ? <StatusBadge status={r.status} />
                            : <span className="sub" style={{ fontSize: 10.5 }}>n/a</span>}</td>
                          <td>{r.gov_crops?.name ?? '—'}</td>
                          <td className="mono">{r.gov_seasons?.label ?? '—'}</td>
                          <td className="mono r-">{dash(r.accuracy, (v) => f1(v, 4))}</td>
                          <td className="mono r-">{dash(r.precision_score, (v) => f1(v, 4))}</td>
                          <td className="mono r-">{dash(r.recall, (v) => f1(v, 4))}</td>
                          <td className="mono r-">{dash(r.f1_score, (v) => f1(v, 4))}</td>
                          <td className="sub">{fmtDate(r.completed_at || r.created_at)}</td>
                          <td className="sub">{r.research_profiles?.full_name ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Card>
            )}

            {/* Failed and in-flight runs are not silently dropped: a run that
                never completed is information, and leaving it out makes the
                screen look like fewer things were tried than were. */}
            {all.some((r) => r.job_status !== 'completed') && (
              <Card title="Incomplete runs" sub="Queued, running or failed — excluded from the tables above">
                <TableWrap>
                  <table>
                    <thead>
                      <tr><th>Run</th><th>Type</th><th>Job</th><th>Started</th><th>Reason</th></tr>
                    </thead>
                    <tbody>
                      {all.filter((r) => r.job_status !== 'completed').slice(0, 20).map((r) => (
                        <tr key={r.id}>
                          <td><b>{label(r)}</b></td>
                          <td className="sub">{r.model_type}</td>
                          <td><JobChip status={r.job_status} /></td>
                          <td className="sub">{r.started_at ? fmtDate(r.started_at) : '—'}</td>
                          <td className="sub" style={{ maxWidth: 420 }}>{r.error_message ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Card>
            )}
          </>
        )}
      </Panel>
    </>
  )
}
