import { useState } from 'react'
import { Bars } from '../lib/charts'
import { cropColor, dash, f1, title, yieldDec } from '../lib/fmt'
import {
  Button, Card, Chip, Empty, PageHead, Panel, Provenance, TableWrap,
} from '../lib/ui'
import { downloadCsv } from '../lib/csv'
import { fetchRiskAlerts, fetchSubsidy } from '../lib/queries'
import { useFacts } from '../lib/useFacts'
import { useQuery } from '../lib/useQuery'

/**
 * Screen 13 — reports and analytics.
 *
 * EXPORTS ARE CSV, NOT PDF. The design listed PDF bulletins with a "Generate"
 * button; generating a real PDF in the browser needs a library this project does
 * not have, and a button that produces nothing is worse than one that produces a
 * file. CSV is a genuine export of the exact rows on screen, opens in Excel, and
 * needs no dependency. A PDF bulletin, if it is wanted, belongs in the FastAPI
 * service where app/report.py already lives.
 *
 * Every export is built from the same query the chart is drawn from, so the file
 * and the screen cannot disagree.
 */
const METRICS = {
  actual: ['Reported yield (t/ha)', (r) => r.actual?.yield_t_ha],
  predicted: ['Model yield (t/ha)', (r) => r.prediction?.predicted_yield],
  ndvi: ['NDVI', (r) => r.indices?.ndvi],
  error: ['Model error (t/ha)', (r) => (r.actual && r.prediction
    ? Number(r.prediction.predicted_yield) - Number(r.actual.yield_t_ha) : null)],
}

export default function ReportsPage({ dims, crop, season, cropRow, seasonRow, say }) {
  const facts = useFacts({ dims, crop, season })
  const [metric, setMetric] = useState('actual')
  const [order, setOrder] = useState('top')

  const alerts = useQuery(() => fetchRiskAlerts({ seasonId: season }), [season],
                          { enabled: Boolean(season) })
  const subsidy = useQuery(() => fetchSubsidy({ seasonId: season }), [season],
                           { enabled: Boolean(season) })

  const [label, get] = METRICS[metric]

  return (
    <>
      <PageHead title="Reports & analytics"
                sub={`${title(cropRow?.name ?? '')} · ${seasonRow?.label ?? ''}`} />

      <Panel q={facts} skeleton={300}
             empty={<Empty what="Nothing loaded for this selection." why="Try another crop or season." />}>
        {(rows) => {
          const dec = yieldDec(rows.find((r) => r.actual)?.actual.yield_t_ha ?? 1)
          const withVal = rows.filter((r) => get(r) != null)
          const sorted = [...withVal].sort((a, b) =>
            order === 'bottom' ? Number(get(a)) - Number(get(b)) : Number(get(b)) - Number(get(a)))
          const shown = sorted.slice(0, 12)

          const fullExport = () => rows.map((r) => ({
            district: r.name,
            crop: cropRow?.name ?? '',
            season: seasonRow?.label ?? '',
            reported_yield_t_ha: r.actual?.yield_t_ha ?? '',
            reported_source: r.actual?.source ?? '',
            model_yield_t_ha: r.prediction?.predicted_yield ?? '',
            model_ci_low: r.prediction?.ci_low ?? '',
            model_ci_high: r.prediction?.ci_high ?? '',
            model_basis: r.prediction?.evaluation ?? '',
            model_lead_days: r.prediction?.lead_days ?? '',
            ndvi: r.indices?.ndvi ?? '',
            evi: r.indices?.evi ?? '',
            ndwi: r.indices?.ndwi ?? '',
            savi: r.indices?.savi ?? '',
            nbr: r.indices?.nbr ?? '',
            composite_date: r.indices?.date ?? '',
          }))

          const REPORTS = [
            ['District summary',
             'Every district for the selected crop and season: reported yield, model yield with '
             + 'its range and basis, and all five indices.',
             () => fullExport(), `district-summary-${cropRow?.name}-${seasonRow?.label}.csv`],
            ['Risk and alert digest',
             'Open alerts for the season with the rule parameters that fired each one.',
             () => (alerts.data ?? []).map((a) => ({
               district: a.gov_districts?.name ?? '', crop: a.gov_crops?.name ?? '',
               type: a.alert_type, severity: a.severity, triggered: a.triggered_at,
               observed_ndvi: a.details?.observed_ndvi ?? '',
               historical_mean: a.details?.historical_mean ?? '',
               z_score: a.details?.z_score ?? '', message: a.message,
             })), `risk-digest-${seasonRow?.label}.csv`],
            ['Subsidy targeting list',
             'Ranked districts with the full reason for each, across every crop.',
             () => (subsidy.data ?? []).map((s) => ({
               rank: s.rank, district: s.gov_districts?.name ?? '', crop: s.gov_crops?.name ?? '',
               resource: s.resource_type, priority_score: s.priority_score,
               yield_deficit_pct: s.yield_deficit_pct,
               water_access_score: s.resource_access_score, reason: s.reason,
             })), `subsidy-targeting-${seasonRow?.label}.csv`],
            ['Model accuracy by district',
             'Districts with both a reported figure and a model run, with the signed error and '
             + 'whether the row was in the training set.',
             () => rows.filter((r) => r.actual && r.prediction).map((r) => ({
               district: r.name, crop: cropRow?.name ?? '', season: seasonRow?.label ?? '',
               reported: r.actual.yield_t_ha, model: r.prediction.predicted_yield,
               error: Number(r.prediction.predicted_yield) - Number(r.actual.yield_t_ha),
               basis: r.prediction.evaluation,
             })), `model-accuracy-${cropRow?.name}-${seasonRow?.label}.csv`],
          ]

          return (
            <>
              <div className="grid g4">
                {REPORTS.map(([name, desc, build, filename]) => (
                  <section className="card" key={name}>
                    <h3>{name}</h3>
                    <p className="sub" style={{ margin: '4px 0 12px', minHeight: 58 }}>{desc}</p>
                    <Button variant="dark" size="sm" onClick={() => {
                      const data = build()
                      if (!data.length) return say('Nothing to export for this selection')
                      downloadCsv(filename, data)
                      say(`${name} exported`)
                    }}>
                      Export CSV
                    </Button>
                  </section>
                ))}
              </div>

              <Card title="Chart builder" sub="Any metric, by district"
                    right={
                      <Button size="sm" onClick={() => {
                        downloadCsv(
                          `${metric}-${cropRow?.name}-${seasonRow?.label}.csv`,
                          sorted.map((r) => ({ district: r.name, [metric]: get(r) }))
                        )
                        say('Chart data exported')
                      }}>Export this chart</Button>
                    }>
                <div className="row" style={{ marginBottom: 12 }}>
                  <select className="inp" style={{ width: 'auto' }} value={metric}
                          aria-label="Metric" onChange={(e) => setMetric(e.target.value)}>
                    {Object.entries(METRICS).map(([k, v]) => (
                      <option key={k} value={k}>{v[0]}</option>
                    ))}
                  </select>
                  <select className="inp" style={{ width: 'auto' }} value={order}
                          aria-label="Order" onChange={(e) => setOrder(e.target.value)}>
                    <option value="top">Highest 12</option>
                    <option value="bottom">Lowest 12</option>
                  </select>
                  <Chip tone="n">{withVal.length} of {rows.length} districts have a value</Chip>
                </div>

                {shown.length === 0 ? (
                  <Empty what={`No district has a value for ${label}.`} why="" />
                ) : (
                  <>
                    <Bars
                      data={shown.map((r) => ({
                        l: r.name.length > 9 ? r.name.slice(0, 8) + '…' : r.name,
                        v: Number(get(r)),
                        c: metric === 'error'
                          ? (Number(get(r)) < 0 ? '#b4342b' : 'var(--g500)')
                          : cropColor(cropRow?.name),
                      }))}
                      vals dec={metric === 'ndvi' ? 2 : dec} h={240} w={700}
                      min={metric === 'error' ? Math.min(0, ...shown.map((r) => Number(get(r)))) : 0}
                      alt={`${label} by district`}
                    />
                    <p className="sub" style={{ marginTop: 6 }}>
                      {title(cropRow?.name)} · {order === 'top' ? 'highest' : 'lowest'} 12 districts
                      by {label.toLowerCase()}
                    </p>
                  </>
                )}
                <Provenance>
                  Districts with no value for the chosen metric are excluded from the chart rather
                  than plotted at zero, and the count above says how many that is.
                </Provenance>
              </Card>

              <Card title="Full table" sub="Exactly what the exports contain">
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>District</th><th className="r-">Reported</th><th className="r-">Model</th>
                        <th className="r-">Error</th><th className="r-">NDVI</th><th>Basis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...rows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => {
                        const err = r.actual && r.prediction
                          ? Number(r.prediction.predicted_yield) - Number(r.actual.yield_t_ha) : null
                        return (
                          <tr key={r.district_id}>
                            <td><b>{r.name}</b></td>
                            <td className="mono r-">{dash(r.actual?.yield_t_ha, (v) => f1(v, dec))}</td>
                            <td className="mono r-">{dash(r.prediction?.predicted_yield, (v) => f1(v, dec))}</td>
                            <td className="mono r-">{err == null ? '—' : (err >= 0 ? '+' : '') + f1(err, 2)}</td>
                            <td className="mono r-">{dash(r.indices?.ndvi)}</td>
                            <td>
                              {!r.prediction ? <span className="sub">no model run</span>
                                : r.prediction.evaluation === 'in_sample'
                                  ? <Chip tone="a">In-sample</Chip> : <Chip>Out-of-sample</Chip>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </TableWrap>
              </Card>

              <Card title="Why CSV and not PDF" sub="">
                <Provenance>
                  A PDF bulletin needs a rendering library that is not a dependency of this project,
                  and a “Generate” button that produced nothing would be worse than none. CSV is a
                  real export of the exact rows above and opens in Excel directly. If a formatted
                  bulletin is wanted, the FastAPI service is the place for it —
                  ml-service/app/report.py already assembles report content server-side, where a
                  PDF library can live without shipping to every browser.
                </Provenance>
              </Card>
            </>
          )
        }}
      </Panel>
    </>
  )
}
