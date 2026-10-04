import { useMemo } from 'react'
import GovMap from '../GovMap'
import { HRows } from '../lib/charts'
import { ALERT_COLOR, ALERT_LABEL, RAMPS, cropColor, dash, f1, mean, norm, ramp, title, yieldDec }
  from '../lib/fmt'
import {
  Card, Chip, Empty, Kpi, MapLegendGradient, PageHead, Panel, Provenance, RiskChip,
} from '../lib/ui'
import { useFacts } from '../lib/useFacts'

/**
 * Screen 1 — provincial (or district-scoped) overview.
 *
 * Differs from the design in what the KPI row reports, and deliberately. The
 * design's four cards were cultivated area, mean NDVI, harvest progress and
 * districts at high risk. Two of those cannot be computed from anything in the
 * database: gov_crop_area_estimates and gov_harvest_progress are both empty
 * because no classification raster and no harvest returns exist upstream. Rather
 * than print a plausible Mha figure, those two cards state what is missing — and
 * the two that ARE real (mean NDVI, districts flagged) carry their district
 * count so the reader can see the denominator.
 */
export default function DashboardPage({ dims, crop, season, cropRow, seasonRow, alerts, go, setDistrict, profile }) {
  const facts = useFacts({ dims, crop, season })
  const provincial = profile.tier === 'super_admin'

  const openAlerts = useMemo(
    () => alerts.filter((a) => !a.resolved && (!season || a.season_id === season)),
    [alerts, season]
  )

  return (
    <>
      <PageHead
        title={provincial ? 'Punjab agriculture overview' : `${profile.gov_districts?.name} overview`}
        sub={`${title(cropRow?.name ?? '')} · ${seasonRow?.label ?? ''} · ${
          dims.districts.length} district${dims.districts.length === 1 ? '' : 's'} in your scope`}
      >
        <Chip tone="n">{provincial ? 'Province: Punjab' : 'District scope'}</Chip>
      </PageHead>

      <Panel q={facts} skeleton={320}
             empty={<Empty what={`No data loaded for ${title(cropRow?.name)} in ${seasonRow?.label}.`}
                           why="Pick another season, or run ml-service/scripts/seed_gov_portal.py to load the pipeline's outputs." />}>
        {(rows) => {
          const ndvi = mean(rows.map((r) => r.indices).filter(Boolean), 'ndvi')
          const yActual = mean(rows.map((r) => r.actual).filter(Boolean), 'yield_t_ha')
          const yPred = mean(rows.map((r) => r.prediction).filter(Boolean), 'predicted_yield')
          const withPred = rows.filter((r) => r.prediction)
          const inSample = withPred.filter((r) => r.prediction.evaluation === 'in_sample').length
          const flagged = new Set(openAlerts.map((a) => a.district_id))
          const worst = [...rows].filter((r) => r.indices?.ndvi != null)
            .sort((a, b) => a.indices.ndvi - b.indices.ndvi).slice(0, 6)
          const dec = yieldDec(yActual.value ?? yPred.value ?? 1)

          return (
            <>
              <div className="grid g21">
                <section className="card hero">
                  <div className="lbl">
                    {provincial ? 'Reported yield' : 'Reported yield'} · {title(cropRow?.name)} · {seasonRow?.label}
                  </div>
                  <div className="spread" style={{ alignItems: 'flex-end', marginTop: 10 }}>
                    <div className="big">
                      {dash(yActual.value, (v) => f1(v, dec))}
                      <small>t/ha</small>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <Chip>{yActual.n} of {rows.length} districts reporting</Chip>
                      <div className="sub" style={{ marginTop: 8 }}>
                        Model mean for the same districts: {dash(yPred.value, (v) => f1(v, dec))} t/ha
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: 18 }}>
                    <HRows rows={[
                      { l: 'Districts with imagery', v: ndvi.n, max: rows.length,
                        t: `${ndvi.n}/${rows.length}` },
                      { l: 'Districts with a model run', v: withPred.length, max: rows.length,
                        t: `${withPred.length}/${rows.length}` },
                    ]} />
                  </div>
                  <Provenance>
                    Unweighted district mean. Production weighting needs crop area per district,
                    which is not loaded — so this is the mean across districts, not a
                    production-weighted provincial yield.
                  </Provenance>
                </section>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Card title="Open alerts" sub={`${openAlerts.length} in ${seasonRow?.label}`}
                        right={<button className="btn sm" onClick={() => go('risk')}>Open</button>}>
                    {openAlerts.length === 0 ? (
                      <Empty what="No alerts for this season."
                             why="The drought rule compares each district against its own history; none crossed the threshold." />
                    ) : (
                      <div className="row">
                        {Object.keys(ALERT_COLOR).map((k) => {
                          const n = openAlerts.filter((a) => a.alert_type === k).length
                          return (
                            <span key={k} className="chip"
                                  style={{ background: ALERT_COLOR[k] + '22', color: ALERT_COLOR[k] }}>
                              {ALERT_LABEL[k]} {n}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </Card>

                  <Card title="Crop mix in scope" sub="Districts reporting a yield, by crop">
                    <CropMixNote />
                  </Card>
                </div>
              </div>

              <div className="grid g4">
                <Kpi label="Mean NDVI" value={dash(ndvi.value)}
                     sub={`Across ${ndvi.n} district${ndvi.n === 1 ? '' : 's'} with imagery`} />
                <Kpi label="Districts flagged" value={flagged.size}
                     sub={`of ${rows.length} · see Risk & Alerts`} />
                <Kpi label="Cultivated area" value="—"
                     sub="No crop-area classification loaded" />
                <Kpi label="Harvest progress" value="—"
                     sub="No harvest returns loaded" />
              </div>

              <div className="grid g21">
                <Card title="Canopy condition by district" sub={`NDVI · ${title(cropRow?.name)}`}
                      right={<Chip tone="n">Click a district</Chip>}>
                  <GovMap
                    id="dash-map" height={400} data={rows}
                    fill={(d) => (d.indices?.ndvi == null ? null
                      : ramp(RAMPS.ndvi, norm(d.indices.ndvi, 0.2, 0.8)))}
                    tip={(d) => `<b>${d.name}</b><br>NDVI ${dash(d.indices?.ndvi)}`
                      + (d.actual ? `<br>Reported ${f1(d.actual.yield_t_ha, dec)} t/ha` : '')}
                    onClick={(d) => { setDistrict(d.name); go('district') }}
                    legend={<MapLegendGradient title="NDVI" stops={RAMPS.ndvi} lo="0.20" hi="0.80"
                                               note="Grey = no imagery loaded" />}
                    badge="Approximate district cells"
                  />
                  <Provenance>
                    Cells are nearest-headquarters catchments, not administrative boundaries —
                    gov_districts.geom is not yet populated. Shading is the seasonal Sentinel-2
                    median composite for this crop's observation window.
                  </Provenance>
                </Card>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Card title="Watchlist" sub="Lowest NDVI this season">
                    {worst.length === 0 ? (
                      <Empty what="No imagery for this crop and season." why="" />
                    ) : worst.map((w) => (
                      <div className="list-row" key={w.district_id}>
                        <div className="grow">
                          <b>{w.name}</b>
                          <p>
                            NDVI {dash(w.indices.ndvi)}
                            {w.actual ? ` · reported ${f1(w.actual.yield_t_ha, dec)} t/ha` : ' · no reported yield'}
                          </p>
                        </div>
                        {flagged.has(w.district_id) ? <RiskChip level="high" /> : <Chip tone="n">Not flagged</Chip>}
                      </div>
                    ))}
                  </Card>

                  <Card title="Model coverage" sub="Where the forecast comes from">
                    <HRows rows={[
                      { l: 'Out-of-sample', v: withPred.length - inSample, max: Math.max(1, withPred.length),
                        t: String(withPred.length - inSample) },
                      { l: 'In-sample fit', v: inSample, max: Math.max(1, withPred.length),
                        t: String(inSample), c: '#d9822b' },
                    ]} />
                    <Provenance>
                      {inSample > 0
                        ? `${inSample} of ${withPred.length} district predictions for this season are a fit `
                          + 'to rows the model was trained on. They are not forecasts and are labelled '
                          + 'as such on the forecasting screen.'
                        : 'Every prediction shown for this season is out-of-sample.'}
                    </Provenance>
                  </Card>
                </div>
              </div>

              <div className="grid g2">
                <Card title="Reported vs model" sub={`${title(cropRow?.name)} · districts with both`}>
                  <ReportedVsModel rows={rows} dec={dec} />
                </Card>
                <Card title="Districts by reported yield" sub={seasonRow?.label}>
                  {yActual.n === 0 ? (
                    <Empty what="No reported yields for this crop and season." why="" />
                  ) : (
                    <div style={{ maxHeight: 300, overflow: 'auto' }}>
                      <HRows
                        rows={[...rows].filter((r) => r.actual)
                          .sort((a, b) => b.actual.yield_t_ha - a.actual.yield_t_ha)
                          .map((r) => ({
                            l: r.name, v: r.actual.yield_t_ha,
                            t: f1(r.actual.yield_t_ha, dec),
                            c: cropColor(cropRow?.name),
                          }))}
                        max={Math.max(...rows.filter((r) => r.actual).map((r) => r.actual.yield_t_ha)) * 1.05}
                      />
                    </div>
                  )}
                </Card>
              </div>
            </>
          )
        }}
      </Panel>
    </>
  )
}

/** Why there is no area donut here, said once rather than left as a gap. */
const CropMixNote = () => (
  <Empty what="Area share is not available."
         why={'The design shows provincial area split by crop. That needs gov_crop_area_estimates, '
            + 'which is empty — no crop-type classification has been run. Reported yields are '
            + 'available per crop on Production & Yield Statistics.'} />
)

/** Scatter of reported against modelled yield, with a 1:1 line.
 *
 * Worth more than the design's two separate bars: the question a policymaker has
 * about a model is whether it agrees with the returns, and that is a position
 * relative to the diagonal, not two numbers to subtract mentally.
 */
function ReportedVsModel({ rows, dec }) {
  const pairs = rows.filter((r) => r.actual && r.prediction).map((r) => ({
    name: r.name,
    a: Number(r.actual.yield_t_ha),
    p: Number(r.prediction.predicted_yield),
    inSample: r.prediction.evaluation === 'in_sample',
  }))
  if (!pairs.length) {
    return <Empty what="No district has both a reported yield and a model run for this selection." why="" />
  }
  const vals = pairs.flatMap((p) => [p.a, p.p])
  const lo = Math.min(...vals) * 0.9
  const hi = Math.max(...vals) * 1.05
  const W = 320, H = 240, pad = 34
  const X = (v) => pad + ((v - lo) / (hi - lo || 1)) * (W - pad - 8)
  const Y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - pad - 10)
  const anyInSample = pairs.some((p) => p.inSample)

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img"
           aria-label="Reported yield against model prediction, with a one-to-one line">
        <line x1={X(lo)} y1={Y(lo)} x2={X(hi)} y2={Y(hi)} className="gl" strokeDasharray="4 4" />
        <line x1={pad} x2={W - 8} y1={H - pad} y2={H - pad} className="gl" />
        <line x1={pad} x2={pad} y1={10} y2={H - pad} className="gl" />
        <text x={pad} y={H - 8} className="at">reported {f1(lo, dec)}</text>
        <text x={W - 8} y={H - 8} className="at" textAnchor="end">{f1(hi, dec)}</text>
        <text transform={`translate(12,${H / 2}) rotate(-90)`} className="at" textAnchor="middle">
          model t/ha
        </text>
        {pairs.map((p) => (
          <circle key={p.name} cx={X(p.a)} cy={Y(p.p)} r="3.4"
                  style={{
                    fill: p.inSample ? '#d9822b' : 'var(--g700)',
                    fillOpacity: 0.8,
                  }}>
            <title>{`${p.name}: reported ${f1(p.a, dec)}, model ${f1(p.p, dec)}${
              p.inSample ? ' (in-sample fit)' : ''}`}</title>
          </circle>
        ))}
      </svg>
      <div className="leg">
        <span><i style={{ background: 'var(--g700)' }} />Out-of-sample</span>
        {anyInSample && <span><i style={{ background: '#d9822b' }} />In-sample fit</span>}
        <span>Dashed line is exact agreement</span>
      </div>
      <Provenance>
        Points on the dashed line mean the model reproduced the reported figure. In-sample
        points sit close to it by construction — the model was fitted to them — so they are
        not evidence of accuracy.
      </Provenance>
    </>
  )
}
