import { Bars, HRows, Line } from '../lib/charts'
import { cropColor, dash, f1, title, yieldDec } from '../lib/fmt'
import {
  Button, Card, Empty, Kpi, PageHead, Panel, Provenance, TableWrap,
} from '../lib/ui'
import { fetchCropHistory } from '../lib/queries'
import { useQuery } from '../lib/useQuery'
import { downloadCsv } from '../lib/csv'

/**
 * Screen 6 — production and yield statistics, exportable.
 *
 * PRODUCTION (tonnes) IS NOT SHOWN, and that is the one thing the design has and
 * this does not. Production is area x yield; the area factor does not exist (see
 * screen 5), so every tonnage figure on this screen would be yield multiplied by
 * a number nobody has measured. Yield and the reported series behind it are real
 * and are what the screen reports.
 */
export default function StatsPage({ dims, crop, cropRow }) {
  const q = useQuery(() => fetchCropHistory({ cropId: crop }), [crop], { enabled: Boolean(crop) })

  return (
    <>
      <PageHead title="Production & yield statistics"
                sub={`Reported yield across seasons · ${title(cropRow?.name ?? '')}`} />

      <Panel q={q} skeleton={300}
             empty={<Empty what="No statistics loaded for this crop." why="Choose another crop." />}>
        {(h) => {
          const seasons = dims.seasons
          const districtName = new Map(dims.districts.map((d) => [d.id, d.name]))
          const seasonLabel = new Map(seasons.map((s) => [s.id, s.label]))

          const perSeason = seasons.map((s) => {
            const vals = h.actuals.filter((a) => a.season_id === s.id).map((a) => Number(a.yield_t_ha))
            const preds = h.preds.filter((p) => p.season_id === s.id).map((p) => Number(p.predicted_yield))
            const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
            return {
              id: s.id, label: s.label, n: vals.length,
              reported: avg(vals), modelled: avg(preds),
              min: vals.length ? Math.min(...vals) : null,
              max: vals.length ? Math.max(...vals) : null,
            }
          })
          const withData = perSeason.filter((p) => p.reported != null)
          if (!withData.length) {
            return <Empty what={`No reported yields for ${title(cropRow?.name)}.`} why="" />
          }
          const latest = withData[withData.length - 1]
          const dec = yieldDec(latest.reported)
          const prior = withData.slice(0, -1)
          const priorMean = prior.length
            ? prior.reduce((a, p) => a + p.reported, 0) / prior.length : null
          const change = priorMean ? ((latest.reported / priorMean) - 1) * 100 : null

          const byDistrict = [...new Set(h.actuals.map((a) => a.district_id))]
            .map((did) => {
              const rows = h.actuals.filter((a) => a.district_id === did)
              const latestRow = rows.find((r) => r.season_id === latest.id)
              return {
                name: districtName.get(did) ?? '—',
                latest: latestRow ? Number(latestRow.yield_t_ha) : null,
                seasons: rows.length,
                mean: rows.reduce((a, r) => a + Number(r.yield_t_ha), 0) / rows.length,
              }
            })
            .sort((a, b) => (b.latest ?? -1) - (a.latest ?? -1))

          const exportRows = () =>
            h.actuals.map((a) => ({
              district: districtName.get(a.district_id) ?? '',
              season: seasonLabel.get(a.season_id) ?? '',
              crop: cropRow?.name ?? '',
              reported_yield_t_ha: a.yield_t_ha,
              model_yield_t_ha: h.preds.find(
                (p) => p.district_id === a.district_id && p.season_id === a.season_id
              )?.predicted_yield ?? '',
              model_basis: h.preds.find(
                (p) => p.district_id === a.district_id && p.season_id === a.season_id
              )?.evaluation ?? '',
            }))

          return (
            <>
              <div className="grid g4">
                <Kpi label={`Reported yield · ${latest.label}`}
                     value={f1(latest.reported, dec)} sub={`t/ha · ${latest.n} districts`} />
                <Kpi label="Range across districts"
                     value={`${f1(latest.min, dec)}–${f1(latest.max, dec)}`} sub="t/ha, latest season" />
                <Kpi label="Vs earlier-season mean"
                     value={change == null ? '—' : (change >= 0 ? '+' : '') + f1(change, 1) + '%'}
                     sub={`Against ${prior.length} prior seasons`} />
                <Kpi label="Production (tonnes)" value="—"
                     sub="Needs crop area; not available" />
              </div>

              <div className="grid g2">
                <Card title="Reported yield by season" sub={`${title(cropRow?.name)} · t/ha`}
                      right={
                        <Button size="sm"
                                onClick={() => downloadCsv(`${cropRow?.name}-yield-by-district-season.csv`, exportRows())}>
                          Export CSV
                        </Button>
                      }>
                  <Bars
                    data={perSeason.map((p) => ({ l: p.label.slice(2), v: p.reported }))}
                    hi={perSeason.findIndex((p) => p.id === latest.id)}
                    vals dec={dec} h={190} alt="Reported yield by season"
                  />
                  <Provenance>
                    Unweighted mean across reporting districts. A missing bar is a season with no
                    reported figure for this crop, not a zero.
                  </Provenance>
                </Card>

                <Card title="Reported against model" sub="Province mean per season">
                  <Line
                    labels={perSeason.map((p) => p.label.slice(2))}
                    h={190} dec={dec}
                    series={[
                      { c: cropColor(cropRow?.name), v: perSeason.map((p) => p.reported), area: 1, name: 'Reported' },
                      { c: '#9aa79f', v: perSeason.map((p) => p.modelled), dash: 1, w: 1.6, name: 'Model' },
                    ]}
                    alt="Reported and modelled yield by season"
                  />
                  <div className="leg">
                    <span><i style={{ background: cropColor(cropRow?.name) }} />Reported</span>
                    <span><i style={{ background: '#9aa79f' }} />Model</span>
                  </div>
                </Card>
              </div>

              <div className="grid g21">
                <Card title="Season table" sub={title(cropRow?.name)}>
                  <TableWrap>
                    <table>
                      <thead>
                        <tr>
                          <th>Season</th><th className="r-">Districts</th>
                          <th className="r-">Reported mean</th><th className="r-">Lowest</th>
                          <th className="r-">Highest</th><th className="r-">Model mean</th>
                          <th className="r-">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...perSeason].reverse().map((p, i, arr) => {
                          const prev = arr[i + 1]
                          const ch = prev?.reported && p.reported
                            ? ((p.reported / prev.reported) - 1) * 100 : null
                          return (
                            <tr key={p.id}>
                              <td><b>{p.label}</b></td>
                              <td className="mono r-">{p.n || '—'}</td>
                              <td className="mono r-">{dash(p.reported, (v) => f1(v, dec))}</td>
                              <td className="mono r-">{dash(p.min, (v) => f1(v, dec))}</td>
                              <td className="mono r-">{dash(p.max, (v) => f1(v, dec))}</td>
                              <td className="mono r-">{dash(p.modelled, (v) => f1(v, dec))}</td>
                              <td className="mono r-"
                                  style={{ color: ch == null ? undefined : ch < 0 ? 'var(--red)' : 'var(--g700)' }}>
                                {ch == null ? '–' : (ch >= 0 ? '+' : '') + f1(ch, 1) + '%'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </TableWrap>
                </Card>

                <Card title="Districts" sub={`Latest season · ${latest.label}`}>
                  <div style={{ maxHeight: 340, overflow: 'auto' }}>
                    <HRows
                      rows={byDistrict.map((d) => ({
                        l: d.name, v: d.latest,
                        t: d.latest == null ? '—' : f1(d.latest, dec),
                        c: cropColor(cropRow?.name),
                      }))}
                      max={Math.max(...byDistrict.map((d) => d.latest ?? 0)) * 1.05}
                    />
                  </div>
                  <Provenance>
                    {byDistrict.filter((d) => d.latest == null).length} district(s) have history
                    for this crop but no figure in {latest.label}; they show a dash.
                  </Provenance>
                </Card>
              </div>
            </>
          )
        }}
      </Panel>
    </>
  )
}
