import { useMemo, useState } from 'react'
import { Card, Empty, Kpi, PageHead, Panel, Provenance, TableWrap } from '../../gov/lib/ui'
import { Bars } from '../../gov/lib/charts'
import { dash, f1, fmtDate } from '../../gov/lib/fmt'
import { downloadCsv } from '../../gov/lib/csv'
import { useQuery } from '../../gov/lib/useQuery'
import { ConfusionMatrix, Select, StatusBadge } from '../lib/rui'
import { MODEL_TYPES, STATUSES, STATUS_LONG } from '../lib/access'
import { fetchBenchmarks, fetchDatasetVersions, fetchRuns } from '../lib/queries'

/**
 * Screen 10 — report & export centre.
 *
 * Assembles a filtered slice of the record into something that can go into a
 * write-up: a table, the charts that go with it, and a CSV of exactly what is
 * on screen.
 *
 * EXPORT IS CSV AND PRINT, NOT PDF. The ML service already generates per-farm
 * PDFs with fpdf2 for the farmer portal, but that is a server-rendered report of
 * one farm's data. Adding a PDF writer here would mean either a new browser
 * dependency -- which the brief forbids -- or a new ML service endpoint
 * duplicating this screen's filter logic in Python, where it would drift from
 * the version in this file. The browser's own print-to-PDF renders this page
 * including its charts, and the CSV carries the numbers for a table a paper can
 * typeset itself. Flagged in the summary as a deliberate narrowing.
 */
export default function ReportsPage({ dims, say }) {
  const runs = useQuery(() => fetchRuns(), [])
  const datasets = useQuery(() => fetchDatasetVersions(), [])
  const benchmarks = useQuery(() => fetchBenchmarks(), [])

  const [modelType, setModelType] = useState(null)
  const [status, setStatus] = useState(null)
  const [cropId, setCropId] = useState(null)
  const [seasonId, setSeasonId] = useState(null)
  const [districtId, setDistrictId] = useState(null)

  const rows = useMemo(() => (runs.data || []).filter((r) => {
    if (r.job_status !== 'completed') return false
    if (modelType && r.model_type !== modelType) return false
    if (status && r.status !== status) return false
    if (cropId && r.crop_id !== cropId) return false
    if (seasonId && r.season_id !== seasonId) return false
    if (districtId && r.district_id !== districtId) return false
    return true
  }), [runs.data, modelType, status, cropId, seasonId, districtId])

  const reg = rows.filter((r) => r.output_type === 'regression')
  const cls = rows.filter((r) => r.output_type === 'classification')
  const dsById = useMemo(
    () => new Map((datasets.data || []).map((d) => [d.id, d])), [datasets.data])

  const scopeLine = [
    modelType || 'all model types',
    status ? STATUS_LONG[status] : 'all statuses',
    dims?.crops.find((c) => c.id === cropId)?.name || 'all crops',
    dims?.seasons.find((s) => s.id === seasonId)?.label || 'all seasons',
    dims?.districts.find((d) => d.id === districtId)?.name || 'all districts',
  ].join(' · ')

  const label = (r) => r.version_label
    || `${r.model_type} ${r.run_kind === 'evaluation' ? 'eval' : ''} ${r.id.slice(0, 6)}`.trim()

  function exportAll() {
    downloadCsv(`research_report_${Date.now()}.csv`, rows.map((r) => ({
      run_id: r.id,
      run_kind: r.run_kind,
      version: r.version_label ?? '',
      model_type: r.model_type,
      model_status: r.status ?? '',
      output_type: r.output_type ?? '',
      crop: r.gov_crops?.name ?? '',
      district: r.gov_districts?.name ?? '',
      season: r.gov_seasons?.label ?? '',
      dataset: dsById.get(r.dataset_version_id)?.description ?? '',
      dataset_rows: dsById.get(r.dataset_version_id)?.record_count ?? '',
      train_split: r.run_config?.train_split ?? '',
      r2: r.r2 ?? '', rmse: r.rmse ?? '', mae: r.mae ?? '',
      accuracy: r.accuracy ?? '', precision: r.precision_score ?? '',
      recall: r.recall ?? '', f1: r.f1_score ?? '',
      completed_at: r.completed_at ?? '',
      triggered_by: r.research_profiles?.full_name ?? '',
    })))
    say(`Exported ${rows.length} runs`)
  }

  return (
    <>
      <PageHead title="Report & export centre"
                sub="A filtered slice of the record, ready for a write-up">
        <button className="btn sm" onClick={() => window.print()}>Print / save as PDF</button>
        <button className="btn sm dark" disabled={!rows.length} onClick={exportAll}>
          Export CSV
        </button>
      </PageHead>

      <div className="r-filters">
        <Select label="Model type" value={modelType} onChange={setModelType}
                options={MODEL_TYPES.map((m) => ({ value: m, label: m }))} all="All types" />
        <Select label="Status" value={status} onChange={setStatus}
                options={STATUSES.map((s) => ({ value: s, label: STATUS_LONG[s] }))}
                all="All statuses" />
        <Select label="Crop" value={cropId} onChange={setCropId}
                options={dims?.crops ?? []} all="All crops" />
        <Select label="Season" value={seasonId} onChange={setSeasonId}
                options={(dims?.seasons ?? []).map((s) => ({ id: s.id, name: s.label }))}
                all="All seasons" />
        <Select label="District" value={districtId} onChange={setDistrictId}
                options={dims?.districts ?? []} all="All districts" />
      </div>

      <div className="grid g4">
        <Kpi label="Runs in scope" value={runs.loading ? '—' : rows.length} sub={scopeLine} />
        <Kpi label="Regression" value={runs.loading ? '—' : reg.length} sub="R², RMSE, MAE" />
        <Kpi label="Classification" value={runs.loading ? '—' : cls.length}
             sub="Accuracy, P, R, F1" />
        <Kpi label="Best R²"
             value={reg.length ? f1(Math.max(...reg.map((r) => Number(r.r2 ?? -Infinity))), 4) : '—'}
             sub={reg.length ? 'Across the scope' : 'No regression runs in scope'} />
      </div>

      <Panel q={runs} skeleton={260}
             empty={<Empty what="No completed runs to report on."
                           why="Runs appear here once they finish." />}>
        {() => rows.length === 0 ? (
          <Empty what="Nothing matches this scope." why="Widen the filters above." />
        ) : (
          <>
            {reg.length > 1 && (
              <Card title="Regression results" sub={scopeLine}>
                <Bars data={reg.map((r) => ({ l: label(r), v: r.r2 }))} dec={3}
                      alt="R squared by run, current scope" />
              </Card>
            )}
            {cls.length > 1 && (
              <Card title="Classification results" sub={scopeLine}>
                <Bars data={cls.map((r) => ({ l: label(r), v: r.f1_score }))} dec={3} max={1}
                      alt="F1 by run, current scope" />
              </Card>
            )}

            <Card title="Result table" sub={`${rows.length} runs · ${scopeLine}`}>
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Run</th><th>Type</th><th>Status</th><th>Output</th>
                      <th>Crop</th><th>Season</th><th>Dataset</th>
                      <th className="r-">Primary metric</th><th>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const prim = r.output_type === 'classification'
                        ? ['F1', r.f1_score] : ['R²', r.r2]
                      return (
                        <tr key={r.id}>
                          <td><b>{label(r)}</b></td>
                          <td className="sub">{r.model_type}</td>
                          <td>{r.run_kind === 'training'
                            ? <StatusBadge status={r.status} />
                            : <span className="sub" style={{ fontSize: 10.5 }}>evaluation</span>}</td>
                          <td className="sub">{r.output_type ?? '—'}</td>
                          <td>{r.gov_crops?.name ?? '—'}</td>
                          <td className="mono">{r.gov_seasons?.label ?? '—'}</td>
                          <td className="sub" style={{ maxWidth: 200 }}>
                            {dsById.get(r.dataset_version_id)?.description ?? '—'}
                          </td>
                          <td className="mono r-"
                              style={prim[0] === 'R²' && Number(prim[1]) < 0
                                ? { color: 'var(--red)' } : undefined}>
                            {prim[0]} {dash(prim[1], (x) => f1(x, 4))}
                          </td>
                          <td className="sub">{fmtDate(r.completed_at || r.created_at)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </TableWrap>
              <Provenance>
                The primary metric column shows R² for a regression run and F1 for a
                classification run, labelled per row — the two are never placed in one
                unlabelled column. The CSV export carries every metric for both kinds,
                with blanks where a metric does not apply.
              </Provenance>
            </Card>

            {cls.filter((r) => r.confusion_matrix).map((r) => (
              <Card key={r.id} title={`Confusion matrix · ${label(r)}`}
                    sub={`${r.model_type}${r.gov_crops?.name ? ' · ' + r.gov_crops.name : ''}`}>
                <ConfusionMatrix cm={r.confusion_matrix} />
              </Card>
            ))}

            <Card title="Literature context" sub="For the discussion section">
              <Panel q={benchmarks} skeleton={120}
                     empty={<Empty what="No benchmark references." />}>
                {(bs) => (
                  <TableWrap>
                    <table>
                      <thead>
                        <tr><th>Citation</th><th>Metric</th><th className="r-">Value</th><th>Crop</th></tr>
                      </thead>
                      <tbody>
                        {bs.map((b) => (
                          <tr key={b.id}>
                            <td>{b.citation}</td>
                            <td className="sub">{b.metric_type}</td>
                            <td className="mono r-">
                              {b.metric_value == null ? 'not entered' : f1(b.metric_value, 4)}
                            </td>
                            <td>{b.crop_type ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </Panel>
              <Provenance>
                Rows reading <i>not entered</i> are citations seeded without a figure
                because the paper is not in this repository. Do not quote them until the
                value has been read from the source.
              </Provenance>
            </Card>
          </>
        )}
      </Panel>
    </>
  )
}
