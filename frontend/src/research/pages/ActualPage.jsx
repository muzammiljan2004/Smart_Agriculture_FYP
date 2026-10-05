import { useMemo } from 'react'
import { Card, Empty, Kpi, PageHead, Panel, Provenance, TableWrap } from '../../gov/lib/ui'
import { Line } from '../../gov/lib/charts'
import { dash, f1, yieldDec } from '../../gov/lib/fmt'
import { downloadCsv } from '../../gov/lib/csv'
import { useQuery } from '../../gov/lib/useQuery'
import { Select } from '../lib/rui'
import { fetchPredictionVsActual } from '../lib/queries'

/**
 * Screen 6 — prediction vs actual.
 *
 * TWO KINDS OF "ACTUAL", AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   gov_yield_actuals   the Crop Reporting Service's district figure. Complete
 *                       coverage, but a district average computed months after
 *                       harvest.
 *   gov_field_surveys   an officer's verified yield cut at a known location.
 *                       Sparse, but measured on the ground.
 *
 * The brief asks for ground truth "sourced from the government portal's field
 * survey verification data where available" -- and "where available" is doing a
 * lot of work, because almost none is. So both columns are shown side by side
 * and neither is folded into the other. A survey value is only ever drawn where
 * one exists; it is never filled in from the CRS figure, because then the chart
 * would claim ground validation the project does not have.
 *
 * Only verified surveys cross the portal boundary -- the RLS policy restricts
 * the table to status='verified', so a pending or rejected submission is
 * invisible here by construction, not by this file remembering to filter.
 */
export default function ActualPage({ dims, crop, setCrop, season, setSeason, say }) {
  const q = useQuery(() => fetchPredictionVsActual({ cropId: crop, seasonId: season }),
                     [crop, season], { enabled: Boolean(crop) })

  const rows = useMemo(() => (q.data || [])
    .filter((r) => r.predicted != null || r.actual != null)
    .sort((a, b) => (a.district || '').localeCompare(b.district || '')), [q.data])

  const paired = rows.filter((r) => r.predicted != null && r.actual != null)
  const surveyed = rows.filter((r) => r.survey != null)

  // Residual summary over the pairs that exist. Computed here rather than read
  // from a model row because this compares the STORED predictions against the
  // reported outcome, which is a different question from a training holdout.
  const stats = useMemo(() => {
    if (!paired.length) return null
    const errs = paired.map((r) => Number(r.predicted) - Number(r.actual))
    const abs = errs.map(Math.abs)
    const mae = abs.reduce((a, b) => a + b, 0) / abs.length
    const rmse = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length)
    const bias = errs.reduce((a, b) => a + b, 0) / errs.length
    const ys = paired.map((r) => Number(r.actual))
    const ybar = ys.reduce((a, b) => a + b, 0) / ys.length
    const ssTot = ys.reduce((a, y) => a + (y - ybar) ** 2, 0)
    const ssRes = errs.reduce((a, e) => a + e * e, 0)
    return { mae, rmse, bias, r2: ssTot ? 1 - ssRes / ssTot : null, n: paired.length }
  }, [paired])

  const chart = useMemo(() => {
    if (paired.length < 2) return null
    return {
      labels: paired.map((r) => r.district || '—'),
      series: [
        { name: 'Predicted', v: paired.map((r) => r.predicted), c: 'var(--g500)' },
        { name: 'Reported (CRS)', v: paired.map((r) => r.actual), c: '#c98a1c' },
        ...(surveyed.length >= 2
          ? [{ name: 'Verified survey', v: paired.map((r) => r.survey), c: '#2f6f9a' }]
          : []),
      ],
    }
  }, [paired, surveyed])

  return (
    <>
      <PageHead title="Prediction vs actual"
                sub="Stored predictions against reported and ground-verified yield" />

      <div className="r-filters">
        <Select label="Crop" value={crop} onChange={setCrop}
                options={dims?.crops ?? []} all={null} />
        <Select label="Season" value={season} onChange={setSeason}
                options={(dims?.seasons ?? []).map((s) => ({ id: s.id, name: s.label }))}
                all="All seasons" />
        <div className="spacer" />
        <button className="btn sm" disabled={!rows.length} onClick={() => {
          downloadCsv(`prediction_vs_actual_${Date.now()}.csv`, rows.map((r) => ({
            district: r.district ?? '', season: r.season ?? '',
            predicted: r.predicted ?? '', reported_crs: r.actual ?? '',
            verified_survey: r.survey ?? '', survey_count: r.survey_n ?? 0,
            residual: (r.predicted != null && r.actual != null)
              ? Number(r.predicted) - Number(r.actual) : '',
            evaluation: r.evaluation ?? '', model_used: r.model_used ?? '',
            source: r.source ?? '',
          })))
          say(`Exported ${rows.length} rows`)
        }}>Export CSV</button>
      </div>

      <div className="grid g4">
        <Kpi label="Paired rows" value={q.loading ? '—' : paired.length}
             sub="Have both a prediction and a reported yield" />
        <Kpi label="MAE" value={stats ? f1(stats.mae, 3) : '—'} sub="t/ha, against CRS" />
        <Kpi label="RMSE" value={stats ? f1(stats.rmse, 3) : '—'} sub="t/ha, against CRS" />
        <Kpi label="Ground-verified" value={q.loading ? '—' : surveyed.length}
             sub={surveyed.length ? 'From field surveys' : 'No verified surveys yet'} />
      </div>

      <Panel q={q} skeleton={280}
             empty={<Empty what="No predictions or reported yields for this selection."
                           why="Pick another crop or widen the season." />}>
        {() => rows.length === 0 ? (
          <Empty what="Nothing to compare for this crop and season." />
        ) : (
          <>
            {chart && (
              <Card title="By district" sub="Predicted against reported, same axis">
                <Line series={chart.series} labels={chart.labels} h={230}
                      dec={2} alt="Predicted versus reported yield by district" />
                {surveyed.length > 0 && surveyed.length < 2 && (
                  <Provenance>
                    One district-season has a verified survey value, which is too few to
                    draw as a series. It is in the table below.
                  </Provenance>
                )}
              </Card>
            )}

            {stats && (
              <Card title="Residuals" sub={`Over the ${stats.n} paired rows`}>
                <div className="r-metrics">
                  <div className={'r-metric' + (stats.r2 != null && stats.r2 < 0 ? ' neg' : '')}>
                    <div className="k">R² vs CRS</div>
                    <div className="v">{dash(stats.r2, (v) => f1(v, 4))}</div>
                  </div>
                  <div className="r-metric">
                    <div className="k">Mean bias</div>
                    <div className="v">{(stats.bias > 0 ? '+' : '') + f1(stats.bias, 3)}</div>
                  </div>
                  <div className="r-metric">
                    <div className="k">MAE</div><div className="v">{f1(stats.mae, 3)}</div>
                  </div>
                  <div className="r-metric">
                    <div className="k">RMSE</div><div className="v">{f1(stats.rmse, 3)}</div>
                  </div>
                </div>
                <Provenance>
                  A positive bias means the stored predictions run high against the
                  reported figure. These are <b style={{ display: 'inline' }}>not</b> a
                  model's holdout metrics: many of these predictions are in-sample fits
                  to seasons the model trained on, flagged per row in the table below.
                  Compare a model's own accuracy on the Performance Comparison screen
                  instead.
                </Provenance>
              </Card>
            )}

            <Card title="District detail" sub="Three columns, never merged">
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>District</th><th>Season</th>
                      <th className="r-">Predicted</th>
                      <th className="r-">Reported (CRS)</th>
                      <th className="r-">Verified survey</th>
                      <th className="r-">Residual</th>
                      <th>Prediction basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const res = (r.predicted != null && r.actual != null)
                        ? Number(r.predicted) - Number(r.actual) : null
                      return (
                        <tr key={r.key}>
                          <td><b>{r.district ?? '—'}</b></td>
                          <td className="mono">{r.season ?? '—'}</td>
                          <td className="mono r-">{dash(r.predicted, (v) => f1(v, yieldDec(v)))}</td>
                          <td className="mono r-">{dash(r.actual, (v) => f1(v, yieldDec(v)))}</td>
                          <td className="mono r-">
                            {r.survey == null ? '—' : (
                              <>
                                {f1(r.survey, 2)}
                                {r.survey_n > 1 && (
                                  <span className="sub" style={{ fontSize: 10 }}>
                                    {' '}(n={r.survey_n})
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                          <td className="mono r-"
                              style={res != null && Math.abs(res) > 1
                                ? { color: 'var(--red)' } : undefined}>
                            {res == null ? '—' : (res > 0 ? '+' : '') + f1(res, 2)}
                          </td>
                          <td>
                            {r.evaluation
                              ? <span className={'r-badge ' + (r.evaluation === 'in_sample'
                                  ? 'candidate' : 'approved')}>
                                  <i />{r.evaluation === 'in_sample' ? 'in-sample fit'
                                    : r.evaluation === 'holdout' ? 'holdout' : 'out of sample'}
                                </span>
                              : <span className="sub">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </TableWrap>
              <Provenance>
                An empty <i>Verified survey</i> cell means no officer has submitted and
                had verified a yield cut for that district-season — it is not a zero and
                it is not filled in from the CRS column. Validating the harvest detector
                needs 20–30 of these and the collection has barely started, which is why
                the column is mostly empty and why that emptiness is shown rather than
                papered over.
              </Provenance>
            </Card>
          </>
        )}
      </Panel>
    </>
  )
}
