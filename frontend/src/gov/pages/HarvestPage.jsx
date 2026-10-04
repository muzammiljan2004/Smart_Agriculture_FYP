import GovMap from '../GovMap'
import { Donut, HRows, LegendDots } from '../lib/charts'
import { RAMPS, cropColor, fmt, norm, ramp, title } from '../lib/fmt'
import {
  Card, Empty, Kpi, MapLegendGradient, PageHead, Panel, Provenance, TableWrap,
} from '../lib/ui'
import { districtCells } from '../lib/geo'
import { fetchHarvestProgress } from '../lib/queries'
import { useQuery } from '../lib/useQuery'

/**
 * Screen 8 — harvest monitoring.
 *
 * gov_harvest_progress IS EMPTY. Unlike crop area, the detector for this
 * EXISTS -- app/harvest.py finds the post-peak NDVI decline that marks a cut
 * field -- but it is unvalidated: the project needs 20-30 confirmed harvest dates
 * to score it against, and that is still the binding constraint. Running it across
 * every district and publishing the output as a provincial statistic would turn an
 * untested heuristic into a government figure, which is a worse failure than an
 * empty screen.
 *
 * So the layout is built and the detector is named, with what it would take to
 * turn it on. Screen 11 is where those confirmations come from.
 */
export default function HarvestPage({ dims, season, seasonRow, crop, cropRow, go }) {
  const q = useQuery(() => fetchHarvestProgress({ seasonId: season }), [season],
                     { enabled: Boolean(season) })

  return (
    <>
      <PageHead title="Harvest monitoring"
                sub={`Harvested and remaining area · ${seasonRow?.label ?? ''}`} />

      <Panel
        q={q}
        skeleton={260}
        empty={
          <>
            <Empty what="No harvest progress has been recorded.">
              This screen tracks harvested against remaining area per district. Two things could
              fill it and neither has:
              <br /><br />
              <b style={{ display: 'inline' }}>Officer returns.</b> District staff reporting
              progress through the field survey screen. None have been submitted for this season.
              <br /><br />
              <b style={{ display: 'inline' }}>The satellite harvest detector.</b> It exists
              (app/harvest.py, the post-peak NDVI decline on a field's own curve) and runs per
              farm on the farmer side — but it has never been validated, because scoring it needs
              20–30 confirmed real harvest dates and those have not been collected. Running an
              unvalidated detector province-wide and publishing the result as an official harvest
              figure is the one thing this portal should not do.
            </Empty>

            <div className="grid g4" style={{ marginTop: 12 }}>
              <Kpi label="Harvested" value="—" sub="No returns or detector output" />
              <Kpi label="Harvested area" value="—" sub="" />
              <Kpi label="Remaining area" value="—" sub="Needs crop area, also unavailable" />
              <Kpi label="Estimated completion" value="—" sub="Needs a progress series" />
            </div>

            <div className="grid g2" style={{ marginTop: 12 }}>
              <Card title="Collect the ground truth" sub="What unblocks this screen">
                <div className="list-row">
                  <div className="grow">
                    <b>Confirmed harvest dates</b>
                    <p>
                      20–30 real dates across districts and crops, enough to score the detector's
                      error. Submitted as “harvest progress” or “yield cut” surveys.
                    </p>
                  </div>
                  <button className="btn sm" onClick={() => go('survey')}>Open Field Survey</button>
                </div>
                <div className="list-row">
                  <div className="grow">
                    <b>Planted area per district</b>
                    <p>
                      “Remaining area” is planted minus harvested, so it needs the crop-area
                      layer that screen 5 is also waiting on.
                    </p>
                  </div>
                  <button className="btn sm" onClick={() => go('area')}>Open Crop Area</button>
                </div>
                <Provenance>
                  Until the detector is scored, the farmer-side harvest signal is shown to
                  individual growers as an indication and is not aggregated into a statistic here.
                </Provenance>
              </Card>

              <Card title={`${title(cropRow?.name ?? '')} harvest window`} sub="From the crop registry">
                <Empty what="Timing only, not progress.">
                  The crop registry gives the expected harvest window for {title(cropRow?.name)} —
                  that is a calendar fact, not an observation of this season. It is deliberately
                  not rendered as a progress bar, because a calendar is not a measurement of what
                  has actually been cut.
                </Empty>
              </Card>
            </div>
          </>
        }
      >
        {(rows) => {
          const forCrop = rows.filter((r) => r.crop_id === crop)
          const byDistrict = new Map(forCrop.map((r) => [r.district_id, r]))
          // districtCells attaches `poly`, which GovMap needs to draw anything.
          const withCells = districtCells(dims.districts.map((d) => {
            const h = byDistrict.get(d.id)
            const total = h ? Number(h.harvested_area_ha) + Number(h.remaining_area_ha) : null
            return {
              ...d,
              harvest: h || null,
              pct: total ? (Number(h.harvested_area_ha) / total) * 100 : null,
            }
          }))
          const done = forCrop.reduce((a, r) => a + Number(r.harvested_area_ha || 0), 0)
          const left = forCrop.reduce((a, r) => a + Number(r.remaining_area_ha || 0), 0)
          const pct = done + left > 0 ? (done / (done + left)) * 100 : null

          return (
            <>
              <div className="grid g4">
                <Kpi label="Harvested" value={pct == null ? '—' : Math.round(pct) + '%'}
                     sub="Of planted area" />
                <Kpi label="Harvested area" value={fmt(done) + ' ha'} sub="" />
                <Kpi label="Remaining area" value={fmt(left) + ' ha'} sub="" />
                <Kpi label="Districts reporting" value={forCrop.length}
                     sub={`of ${dims.districts.length}`} />
              </div>

              <div className="grid g32">
                <Card title="Harvest progress by district" sub={title(cropRow?.name)}>
                  <GovMap
                    id="harvest-map" height={400}
                    data={withCells}
                    fill={(d) => (d.pct == null ? null : ramp(RAMPS.harvest, norm(d.pct, 0, 100)))}
                    tip={(d) => `<b>${d.name}</b><br>`
                      + (d.pct == null ? 'no return' : `${Math.round(d.pct)}% harvested`)}
                    legend={<MapLegendGradient title="Harvested" stops={RAMPS.harvest}
                                               lo="0%" hi="100%" note="Grey = no return" />}
                  />
                </Card>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Card title="Harvested vs remaining">
                    {pct == null ? <Empty what="No totals." why="" /> : (
                      <div className="row" style={{ gap: 20, alignItems: 'center', justifyContent: 'center' }}>
                        <Donut parts={[{ v: done, c: 'var(--g500)' }, { v: left, c: '#d9a441' }]}
                               size={150} center={Math.round(pct) + '%'} sub="harvested" />
                        <LegendDots items={[['Harvested', 'var(--g500)'], ['Remaining', '#d9a441']]} />
                      </div>
                    )}
                  </Card>

                  <Card title="Progress by crop" sub="Where returns exist">
                    <HRows
                      rows={dims.crops.map((c) => {
                        const rs = rows.filter((r) => r.crop_id === c.id)
                        const d = rs.reduce((a, r) => a + Number(r.harvested_area_ha || 0), 0)
                        const l = rs.reduce((a, r) => a + Number(r.remaining_area_ha || 0), 0)
                        const p = d + l > 0 ? (d / (d + l)) * 100 : null
                        return {
                          l: title(c.name), v: p, max: 100,
                          t: p == null ? '—' : Math.round(p) + '%', c: cropColor(c.name),
                        }
                      })}
                    />
                  </Card>
                </div>
              </div>

              <Card title="Districts" sub="Furthest behind first">
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>District</th><th className="r-">Harvested</th>
                        <th className="r-">Remaining (ha)</th><th>Last updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {withCells.filter((d) => d.harvest)
                        .sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0))
                        .map((d) => (
                          <tr key={d.id}>
                            <td><b>{d.name}</b></td>
                            <td className="mono r-">{d.pct == null ? '—' : Math.round(d.pct) + '%'}</td>
                            <td className="mono r-">{fmt(d.harvest.remaining_area_ha)}</td>
                            <td className="sub">{d.harvest.last_updated?.slice(0, 10) ?? '—'}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Card>
            </>
          )
        }}
      </Panel>
    </>
  )
}
