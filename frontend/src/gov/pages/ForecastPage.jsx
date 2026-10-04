import { HRows } from '../lib/charts'
import { dash, f1, mean, title, yieldDec } from '../lib/fmt'
import {
  Card, Chip, Empty, PageHead, Panel, Provenance, TableWrap,
} from '../lib/ui'
import { fetchCropHistory, fetchModelCard } from '../lib/queries'
import { useFacts } from '../lib/useFacts'
import { useQuery } from '../lib/useQuery'

/**
 * Screen 7 — pre-season yield forecasting, with the lead-time comparison.
 *
 * TWO THINGS THIS SCREEN REFUSES TO DO.
 *
 * First, the design's lead-time tabs (90 / 60 / 30 days before harvest) are not
 * reproduced as a selector, because there is only ONE forecast per
 * district-crop-season and it has one real lead time, computed from the composite
 * date to the expected harvest date. Offering three tabs would mean generating two
 * forecasts that were never run.
 *
 * Second, accuracy is reported from HOLDOUT ROWS ONLY. 1705 of the ~2250
 * predictions are fits to seasons the forest trained on; their error is near zero
 * by construction and quoting it as forecast accuracy would overstate the system
 * by a wide margin. The split is shown explicitly rather than averaged away.
 *
 * The lead-time comparison the brief asks for is real and is the system's
 * strongest honest claim: the composite that drives the forecast is complete well
 * before harvest, whereas the reported series publishes months after it.
 */
export default function ForecastPage({ dims, crop, season, cropRow, seasonRow }) {
  const facts = useFacts({ dims, crop, season })
  const history = useQuery(() => fetchCropHistory({ cropId: crop }), [crop], { enabled: Boolean(crop) })
  const card = useQuery(() => fetchModelCard(), [])

  return (
    <>
      <PageHead title="Yield forecasting"
                sub={`${title(cropRow?.name ?? '')} · ${seasonRow?.label ?? ''}`} />

      <Panel q={facts} skeleton={320}
             empty={<Empty what="No model runs for this crop and season."
                           why="The production model was not trained on every crop — barley has no predictions at all." />}>
        {(rows) => {
          const withPred = rows.filter((r) => r.prediction)
          if (!withPred.length) {
            return (
              <Empty what={`The model has no predictions for ${title(cropRow?.name)}.`}>
                The production RandomForest was trained on ten crops; this is not one of them, so
                no prediction exists rather than a value borrowed from a similar crop. A forest
                handed an unseen crop does not fail — it answers for the nearest leaf — which is
                why the pipeline refuses instead.
              </Empty>
            )
          }

          const yPred = mean(withPred.map((r) => r.prediction), 'predicted_yield')
          const dec = yieldDec(yPred.value)
          const inSample = withPred.filter((r) => r.prediction.evaluation === 'in_sample')
          const holdout = withPred.filter((r) => r.prediction.evaluation !== 'in_sample')
          const leads = withPred.map((r) => r.prediction.lead_days).filter((v) => v != null)
          const leadMean = leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null

          // Mean absolute error on this season, computed per basis. Only the
          // holdout figure is a forecast error; the in-sample one is a fit
          // residual, and they are labelled accordingly.
          const errOf = (list) => {
            const pairs = list.filter((r) => r.actual)
            if (!pairs.length) return null
            const e = pairs.map((r) =>
              Math.abs(Number(r.prediction.predicted_yield) - Number(r.actual.yield_t_ha)))
            return { mae: e.reduce((a, b) => a + b, 0) / e.length, n: e.length }
          }
          const holdoutErr = errOf(holdout)
          const sampleErr = errOf(inSample)

          return (
            <>
              <div className="grid g21">
                <section className="card hero">
                  <div className="lbl">
                    Model yield · {title(cropRow?.name)} · {seasonRow?.label}
                  </div>
                  <div className="spread" style={{ alignItems: 'flex-end', marginTop: 10 }}>
                    <div className="big">{f1(yPred.value, dec)}<small>t/ha</small></div>
                    <div style={{ textAlign: 'right' }}>
                      <Chip>
                        {leadMean == null ? 'lead time unknown'
                          : `${Math.round(leadMean)} days before harvest`}
                      </Chip>
                      <div className="sub" style={{ marginTop: 8 }}>
                        Mean across {withPred.length} districts
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: 18 }}>
                    <HRows rows={[
                      { l: 'Out-of-sample', v: holdout.length, max: withPred.length,
                        t: `${holdout.length}/${withPred.length}` },
                      { l: 'In-sample fit', v: inSample.length, max: withPred.length,
                        t: `${inSample.length}/${withPred.length}` },
                    ]} />
                  </div>
                  <Provenance>
                    {inSample.length > 0 && holdout.length === 0
                      ? 'Every prediction for this season is a fit to data the model trained on. '
                        + 'It is not a forecast. The honest accuracy figures are on the holdout '
                        + 'seasons, 2021-22 and 2022-23.'
                      : holdout.length === withPred.length
                        ? 'This season was held out of training, so these are genuine '
                          + 'out-of-sample predictions.'
                        : 'This season mixes held-out and trained-on districts; the table below '
                          + 'separates them.'}
                  </Provenance>
                </section>

                <Card title="Accuracy on this season" sub="Split by basis, never averaged together">
                  <TableWrap>
                    <table>
                      <tbody>
                        <tr>
                          <td className="lbl">Out-of-sample MAE</td>
                          <td style={{ textAlign: 'right' }} className="mono">
                            {holdoutErr ? `${f1(holdoutErr.mae, 2)} t/ha` : '—'}
                          </td>
                        </tr>
                        <tr>
                          <td className="lbl">…districts compared</td>
                          <td style={{ textAlign: 'right' }} className="mono">
                            {holdoutErr?.n ?? 0}
                          </td>
                        </tr>
                        <tr>
                          <td className="lbl">In-sample residual</td>
                          <td style={{ textAlign: 'right' }} className="mono">
                            {sampleErr ? `${f1(sampleErr.mae, 2)} t/ha` : '—'}
                          </td>
                        </tr>
                        <tr>
                          <td className="lbl">…districts compared</td>
                          <td style={{ textAlign: 'right' }} className="mono">
                            {sampleErr?.n ?? 0}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </TableWrap>
                  <Provenance>
                    The in-sample row is shown only so the difference between the two is visible.
                    It is not an accuracy claim: the model was fitted to those rows, so a small
                    residual there is expected and means nothing about a future season.
                  </Provenance>
                </Card>
              </div>

              <LeadTime cropRow={cropRow} leadMean={leadMean} />

              <div className="grid g2">
                <Card title="District forecasts" sub="Highest to lowest">
                  <div style={{ maxHeight: 340, overflow: 'auto' }}>
                    <HRows
                      rows={[...withPred]
                        .sort((a, b) => b.prediction.predicted_yield - a.prediction.predicted_yield)
                        .map((r) => ({
                          l: r.name, v: Number(r.prediction.predicted_yield),
                          t: f1(r.prediction.predicted_yield, dec),
                        }))}
                      max={Math.max(...withPred.map((r) => Number(r.prediction.predicted_yield))) * 1.05}
                    />
                  </div>
                </Card>

                <Card title="Model card" sub="Read from the dataset registry, not hardcoded">
                  <Panel q={card} skeleton={140}
                         empty={<Empty what="No model record registered."
                                       why="Run the seeding script to register it." />}>
                    {(c) => (
                      <TableWrap>
                        <table>
                          <tbody>
                            <tr><td className="lbl">Model</td>
                              <td style={{ textAlign: 'right' }}>{c.name}</td></tr>
                            <tr><td className="lbl">Coverage</td>
                              <td style={{ textAlign: 'right' }}>{c.coverage}</td></tr>
                            <tr><td className="lbl">Predictions stored</td>
                              <td style={{ textAlign: 'right' }} className="mono">{c.record_count}</td></tr>
                            <tr><td className="lbl">Registered</td>
                              <td style={{ textAlign: 'right' }}>{c.uploaded_at?.slice(0, 10)}</td></tr>
                          </tbody>
                        </table>
                        <Provenance>{c.description}</Provenance>
                      </TableWrap>
                    )}
                  </Panel>
                </Card>
              </div>

              <Card title="Per-district detail" sub={`${title(cropRow?.name)} · ${seasonRow?.label}`}>
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>District</th><th className="r-">Model</th><th className="r-">Range</th>
                        <th className="r-">Reported</th><th className="r-">Error</th>
                        <th className="r-">Lead (days)</th><th>Basis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...withPred].sort((a, b) => a.name.localeCompare(b.name)).map((r) => {
                        const p = r.prediction
                        const err = r.actual
                          ? Number(p.predicted_yield) - Number(r.actual.yield_t_ha) : null
                        return (
                          <tr key={r.district_id}>
                            <td><b>{r.name}</b></td>
                            <td className="mono r-">{f1(p.predicted_yield, dec)}</td>
                            <td className="mono r-">
                              {p.ci_low == null ? '—' : `${f1(p.ci_low, dec)}–${f1(p.ci_high, dec)}`}
                            </td>
                            <td className="mono r-">{dash(r.actual?.yield_t_ha, (v) => f1(v, dec))}</td>
                            <td className="mono r-"
                                style={{ color: err == null ? undefined
                                  : Math.abs(err) > 0.5 ? 'var(--red)' : undefined }}>
                              {err == null ? '—' : (err >= 0 ? '+' : '') + f1(err, 2)}
                            </td>
                            <td className="mono r-">{p.lead_days ?? '—'}</td>
                            <td>
                              {p.evaluation === 'in_sample'
                                ? <Chip tone="a">In-sample</Chip>
                                : <Chip>Out-of-sample</Chip>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </TableWrap>
                <Provenance>
                  The range is the 10th-to-90th percentile spread of the forest's 500 trees. It is
                  model DISAGREEMENT, not a calibrated prediction interval — it ignores
                  field-level noise and therefore reads narrower than the true uncertainty.
                </Provenance>
              </Card>
            </>
          )
        }}
      </Panel>
    </>
  )
}

/**
 * The lead-time comparison the brief requires, drawn from real dates.
 *
 * `leadMean` is measured: the stored composite's centre date to the crop's
 * expected harvest date, averaged over the districts shown. The comparison figure
 * is the published lag of the reported series, which is the thing this system is
 * meant to improve on.
 */
function LeadTime({ cropRow, leadMean }) {
  const traditional = 105          // ~3.5 months, the midpoint of the stated 3-4 month lag
  const W = 760, H = 150
  const maxDays = 150
  const x = (d) => 150 + ((maxDays - d) / maxDays) * (W - 170)

  return (
    <Card title="Lead time against traditional reporting"
          sub="When an estimate becomes available, relative to harvest">
      {leadMean == null ? (
        <Empty what="No lead time recorded for these predictions." why="" />
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img"
               aria-label={`This system produces an estimate about ${Math.round(leadMean)} days before harvest; `
                 + `traditional reporting publishes roughly ${traditional} days after it`}>
            {/* harvest line */}
            <line x1={x(0)} x2={x(0)} y1={16} y2={H - 28} stroke="var(--ink)" strokeWidth="1.4" />
            <text x={x(0)} y={H - 12} className="at" textAnchor="middle">Harvest</text>

            {[150, 100, 50].map((d) => (
              <g key={d}>
                <line x1={x(d)} x2={x(d)} y1={16} y2={H - 28} className="gl" strokeDasharray="3 3" />
                <text x={x(d)} y={H - 12} className="at" textAnchor="middle">{d}d before</text>
              </g>
            ))}

            {/* this system: available before harvest */}
            <text x={8} y={46} className="at">This system</text>
            <rect x={x(leadMean)} y={34} width={Math.max(2, x(0) - x(leadMean))} height={16}
                  rx="4" style={{ fill: 'var(--g500)' }} />
            <text x={x(leadMean) + 6} y={46} style={{ fill: '#fff', fontSize: 10.5, fontWeight: 600 }}>
              estimate available {Math.round(leadMean)}d before harvest
            </text>

            {/* traditional: published after harvest */}
            <text x={8} y={88} className="at">Reported series</text>
            <rect x={x(0)} y={76} width={(traditional / maxDays) * (W - 170) * 0.62} height={16}
                  rx="4" style={{ fill: '#d9822b' }} />
            <text x={x(0) + 6} y={88} style={{ fill: '#fff', fontSize: 10.5, fontWeight: 600 }}>
              published ~{traditional}d after harvest
            </text>

            <text x={8} y={120} className="at">
              Difference: roughly {Math.round(leadMean) + traditional} days earlier
            </text>
          </svg>
          <Provenance>
            The {Math.round(leadMean)} days is measured, not claimed: it is the gap between the
            centre of the Sentinel-2 composite that feeds the model and {cropRow?.name}'s expected
            harvest date from the crop registry. The {traditional}-day figure is the typical
            publication lag of the official reported series this portal also displays — the same
            series the accuracy table above compares against, which is why that comparison can
            only ever be made retrospectively.
          </Provenance>
        </>
      )}
    </Card>
  )
}
