import { useMemo } from 'react'
import GovMap from '../GovMap'
import { Donut, HRows, Line } from '../lib/charts'
import { RAMPS, cropColor, dash, f1, mean, norm, ramp, title, yieldDec } from '../lib/fmt'
import {
  Card, Chip, Empty, Kpi, MapLegendGradient, PageHead, Panel, Provenance, TableWrap,
} from '../lib/ui'
import { fetchCropHistory } from '../lib/queries'
import { useFacts } from '../lib/useFacts'
import { useQuery } from '../lib/useQuery'

/**
 * Screen 3 — one crop across the province.
 *
 * The design's growth-stage rail is NOT reproduced here, and that is the one
 * substantive omission on this screen. A growth stage is a function of days since
 * sowing for a specific field; this portal's grain is a whole district's seasonal
 * composite, which has no sowing date. The farmer portal computes growth stage
 * correctly from the farmer's own planting date (app/growth.py), and inventing a
 * province-wide stage here would contradict it. The card says so in place.
 */
export default function CropPage({ dims, crop, season, cropRow, seasonRow }) {
  const facts = useFacts({ dims, crop, season })
  const history = useQuery(() => fetchCropHistory({ cropId: crop }), [crop], { enabled: Boolean(crop) })

  return (
    <>
      <PageHead title="Crop monitoring"
                sub={`${title(cropRow?.name ?? '')} · ${cropRow?.season ?? ''} · ${seasonRow?.label ?? ''}`}>
        <Chip tone="n">{title(cropRow?.category ?? '')}</Chip>
      </PageHead>

      <Panel q={facts} skeleton={320}
             empty={<Empty what={`No rows for ${title(cropRow?.name)} in ${seasonRow?.label}.`}
                           why="Not every crop is reported in every season." />}>
        {(rows) => {
          const ndvi = mean(rows.map((r) => r.indices).filter(Boolean), 'ndvi')
          const yA = mean(rows.map((r) => r.actual).filter(Boolean), 'yield_t_ha')
          const dec = yieldDec(yA.value ?? 1)
          const withYield = rows.filter((r) => r.actual)
          const top = [...withYield].sort((a, b) => b.actual.yield_t_ha - a.actual.yield_t_ha)

          // Condition bands from the same NDVI thresholds app/field.py uses to
          // describe a canopy, so the farmer and government sides agree on what
          // "good" means rather than each inventing a cut-off.
          const band = (v) => (v >= 0.6 ? 'good' : v >= 0.35 ? 'fair' : 'sparse')
          const bands = { good: 0, fair: 0, sparse: 0 }
          rows.forEach((r) => {
            if (r.indices?.ndvi != null) bands[band(Number(r.indices.ndvi))] += 1
          })
          const classified = bands.good + bands.fair + bands.sparse

          return (
            <>
              <div className="grid g4">
                <Kpi label="Districts reporting" value={`${yA.n} / ${rows.length}`}
                     sub={`${title(cropRow?.name)} in ${seasonRow?.label}`} />
                <Kpi label="Mean reported yield" value={dash(yA.value, (v) => f1(v, dec))}
                     sub="t/ha · unweighted district mean" />
                <Kpi label="Mean NDVI" value={dash(ndvi.value)}
                     sub={`${ndvi.n} districts with imagery`} />
                <Kpi label="Season" value={title(cropRow?.season ?? '—')}
                     sub={`Observation window from data/crops.csv`} />
              </div>

              <div className="grid g21">
                <Card title="Canopy condition" sub="Districts by NDVI band">
                  {classified === 0 ? (
                    <Empty what="No imagery loaded for this crop and season." why="" />
                  ) : (
                    <div className="row" style={{ gap: 18, alignItems: 'center' }}>
                      <Donut
                        parts={[
                          { v: bands.good, c: 'var(--g500)' },
                          { v: bands.fair, c: '#e5c14a' },
                          { v: bands.sparse, c: '#d9822b' },
                        ]}
                        size={130}
                        center={String(Math.round((bands.good / classified) * 100)) + '%'}
                        sub="good"
                      />
                      <div style={{ flex: 1 }}>
                        <HRows rows={[
                          { l: 'Good (NDVI ≥ 0.60)', v: bands.good, max: classified, t: String(bands.good) },
                          { l: 'Fair (0.35–0.60)', v: bands.fair, max: classified, t: String(bands.fair), c: '#e5c14a' },
                          { l: 'Sparse (< 0.35)', v: bands.sparse, max: classified, t: String(bands.sparse), c: '#d9822b' },
                        ]} />
                      </div>
                    </div>
                  )}
                  <Provenance>
                    Bands are the thresholds app/field.py uses on the farmer side: below 0.35 is
                    bare or near-bare ground, 0.60 and above is a closed canopy. Counted over
                    the {classified} districts with imagery, not all {rows.length}.
                  </Provenance>
                </Card>

                <Card title="Growth stage" sub="Not available at district grain">
                  <Empty what="No province-wide growth stage.">
                    A growth stage is days-since-sowing for one field. This portal's unit of
                    observation is a district's season-long median composite, which carries no
                    sowing date — so there is no stage to compute. The farmer portal derives it
                    per farm from the grower's own planting date.
                  </Empty>
                </Card>
              </div>

              <div className="grid g2">
                <Card title="Reported yield by season" sub={`${title(cropRow?.name)} · province mean`}>
                  <Panel q={history} skeleton={190}
                         empty={<Empty what="No history for this crop." why="" />}>
                    {(h) => <CropSeasonTrend h={h} seasons={dims.seasons} dec={dec} crop={cropRow?.name} />}
                  </Panel>
                </Card>

                <Card title="Where it is grown" sub="NDVI shading by district">
                  <GovMap
                    id="crop-map" height={300} data={rows} fillOpacity={0.5}
                    fill={(d) => (d.indices?.ndvi == null ? null
                      : ramp(RAMPS.ndvi, norm(Number(d.indices.ndvi), 0.2, 0.8)))}
                    tip={(d) => `<b>${d.name}</b><br>NDVI ${dash(d.indices?.ndvi)}`
                      + `<br>Reported ${dash(d.actual?.yield_t_ha, (v) => f1(v, dec))} t/ha`}
                    legend={<MapLegendGradient title="NDVI" stops={RAMPS.ndvi} lo="0.20" hi="0.80"
                                               note="Grey = no imagery" />}
                  />
                  <Provenance>
                    Shading is canopy greenness, not cultivated area — the portal has no crop-area
                    layer, so a dark district is a healthy crop, not necessarily a large one.
                  </Provenance>
                </Card>
              </div>

              <Card title="Districts" sub={`${title(cropRow?.name)} · ${seasonRow?.label}`}>
                {top.length === 0 ? (
                  <Empty what="No reported yields for this crop and season." why="" />
                ) : (
                  <TableWrap>
                    <table>
                      <thead>
                        <tr>
                          <th>District</th>
                          <th className="r-">Reported (t/ha)</th>
                          <th className="r-">NDVI</th>
                          <th>Condition</th>
                          <th className="r-">Model (t/ha)</th>
                          <th>Provenance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {top.map((r) => {
                          const v = r.indices?.ndvi == null ? null : Number(r.indices.ndvi)
                          return (
                            <tr key={r.district_id}>
                              <td><b>{r.name}</b></td>
                              <td className="mono r-">{f1(r.actual.yield_t_ha, dec)}</td>
                              <td className="mono r-">{dash(v)}</td>
                              <td>
                                {v == null ? <Chip tone="n">No imagery</Chip>
                                  : v >= 0.6 ? <Chip>Good</Chip>
                                    : v >= 0.35 ? <Chip tone="a">Fair</Chip>
                                      : <Chip tone="r">Sparse</Chip>}
                              </td>
                              <td className="mono r-">
                                {dash(r.prediction?.predicted_yield, (x) => f1(x, dec))}
                              </td>
                              <td title={r.actual.confidence || ''}>
                                <span className="sub">{r.actual.source}</span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </TableWrap>
                )}
              </Card>
            </>
          )
        }}
      </Panel>
    </>
  )
}

function CropSeasonTrend({ h, seasons, dec, crop }) {
  const { labels, actual, modelled, n } = useMemo(() => {
    const byS = new Map(seasons.map((s) => [s.id, []]))
    h.actuals.forEach((a) => byS.get(a.season_id)?.push(Number(a.yield_t_ha)))
    const byP = new Map(seasons.map((s) => [s.id, []]))
    h.preds.forEach((p) => byP.get(p.season_id)?.push(Number(p.predicted_yield)))
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
    return {
      labels: seasons.map((s) => s.label.slice(2)),
      actual: seasons.map((s) => avg(byS.get(s.id))),
      modelled: seasons.map((s) => avg(byP.get(s.id))),
      n: seasons.map((s) => byS.get(s.id).length),
    }
  }, [h, seasons])

  return (
    <>
      <Line
        labels={labels} h={190} dec={dec}
        series={[
          { c: cropColor(crop), v: actual, area: 1, name: 'Reported' },
          { c: '#9aa79f', v: modelled, dash: 1, w: 1.6, name: 'Model' },
        ]}
        alt="Reported and modelled yield by season"
      />
      <div className="leg">
        <span><i style={{ background: cropColor(crop) }} />Reported mean</span>
        <span><i style={{ background: '#9aa79f' }} />Model mean</span>
        <span>{Math.min(...n.filter(Boolean))}–{Math.max(...n)} districts per season</span>
      </div>
      <Provenance>
        Each point is the unweighted mean across whichever districts reported that season, so
        the series moves partly with which districts reported. District counts are above.
      </Provenance>
    </>
  )
}
