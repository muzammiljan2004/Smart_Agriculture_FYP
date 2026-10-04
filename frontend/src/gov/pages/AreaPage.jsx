import { Stacked, LegendDots } from '../lib/charts'
import { cropColor, fmt, title } from '../lib/fmt'
import { Card, Empty, Kpi, PageHead, Panel, Provenance, Stages, TableWrap } from '../lib/ui'
import { fetchAreaEstimates } from '../lib/queries'
import { useQuery } from '../lib/useQuery'

/**
 * Screen 5 — crop area estimation.
 *
 * gov_crop_area_estimates IS EMPTY, and this screen's job is to say why rather
 * than to look busy. The design showed a stacked area chart, a provincial split
 * donut, a 91% classification accuracy and "1,840 survey points used". Every one
 * of those needs a crop-type classification raster, and the pipeline has never
 * produced one: the training set is district-crop-season rows of spectral
 * composites and reported yields, which carry no area at all.
 *
 * The full layout is rendered and wired. The moment the pipeline writes rows, the
 * charts below fill in with no change here -- which is also the honest way to
 * show a policymaker what this screen WILL be, without printing a number today
 * that nothing supports.
 */
export default function AreaPage({ dims, season, seasonRow }) {
  const q = useQuery(() => fetchAreaEstimates({ seasonId: season }), [season],
                     { enabled: Boolean(season) })

  const cropName = new Map(dims.crops.map((c) => [c.id, c.name]))
  const districtName = new Map(dims.districts.map((d) => [d.id, d.name]))

  return (
    <>
      <PageHead title="Crop area estimation"
                sub={`Satellite-derived cultivated area · ${seasonRow?.label ?? ''}`} />

      <Panel
        q={q}
        skeleton={260}
        empty={
          <>
            <Empty what="No crop-area estimates have been produced.">
              This screen reports cultivated hectares per crop and district, derived from a
              crop-type classification of the satellite time series. No classification has been
              run, so the table is empty and nothing here is estimated in its place.
              <br /><br />
              What it needs, in order: a labelled training set of crop-type polygons (field
              surveys collected on screen 11 are the intended source), a per-pixel classifier
              over the Sentinel-2 season stack, then a per-district area sum reconciled against
              the reported area series. Until the first of those exists, an area figure here
              would be a guess presented as a measurement.
            </Empty>

            <div className="grid g4" style={{ marginTop: 12 }}>
              <Kpi label="Total mapped area" value="—" sub="No classification run" />
              <Kpi label="Classification accuracy" value="—" sub="Nothing to validate" />
              <Kpi label="Survey points available" value="—" sub="See Field Survey" />
              <Kpi label="Change vs last season" value="—" sub="Needs two seasons of estimates" />
            </div>

            <Card title="Method, once wired" sub="The pipeline this screen will read"
                  className="" style={{ marginTop: 12 }}>
              <Stages
                stages={['Survey polygons', 'Classifier training', 'Per-pixel inference',
                         'District area sum', 'Reconciliation']}
                current={0}
              />
              <Provenance>
                Stage one is the live constraint: the classifier needs ground-truth crop-type
                polygons, which is what screen 11 collects. No stage after it can start first.
              </Provenance>
            </Card>
          </>
        }
      >
        {(rows) => {
          const byDistrict = new Map()
          rows.forEach((r) => {
            const list = byDistrict.get(r.district_id) ?? new Map()
            list.set(r.crop_id, r)
            byDistrict.set(r.district_id, list)
          })
          const crops = dims.crops
          const totalsByCrop = crops.map((c) =>
            rows.filter((r) => r.crop_id === c.id)
                .reduce((a, r) => a + Number(r.estimated_area_ha || 0), 0))
          const grand = totalsByCrop.reduce((a, b) => a + b, 0)

          const top = [...byDistrict.entries()]
            .map(([did, m]) => ({
              name: districtName.get(did) ?? '—',
              per: crops.map((c) => Number(m.get(c.id)?.estimated_area_ha || 0)),
            }))
            .sort((a, b) => b.per.reduce((x, y) => x + y, 0) - a.per.reduce((x, y) => x + y, 0))
            .slice(0, 12)

          return (
            <>
              <div className="grid g4">
                <Kpi label="Total mapped area" value={fmt(grand / 1000) + ' kha'}
                     sub={`${crops.length} crops`} />
                <Kpi label="Districts covered" value={byDistrict.size}
                     sub={`of ${dims.districts.length} in scope`} />
                <Kpi label="Rows loaded" value={rows.length} sub="district × crop" />
                <Kpi
                  label="Mean accuracy"
                  value={(() => {
                    const a = rows.map((r) => r.accuracy_pct).filter((v) => v != null)
                    return a.length ? Math.round(a.reduce((x, y) => x + Number(y), 0) / a.length) + '%' : '—'
                  })()}
                  sub="Where validated"
                />
              </div>

              <Card title="Crop area by district" sub="Top 12 districts, hectares">
                <Stacked
                  data={top.map((t) => ({ l: t.name, p: t.per }))}
                  colors={crops.map((c) => cropColor(c.name))}
                  h={250} alt="Stacked crop area by district"
                />
                <LegendDots items={crops.map((c) => [title(c.name), cropColor(c.name)])} />
              </Card>

              <Card title="Area table" sub="Hectares">
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>District</th>
                        {crops.map((c) => <th key={c.id} className="r-">{title(c.name)}</th>)}
                        <th className="r-">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top.map((t) => (
                        <tr key={t.name}>
                          <td><b>{t.name}</b></td>
                          {t.per.map((v, i) => (
                            <td key={i} className="mono r-">{v ? fmt(v) : '—'}</td>
                          ))}
                          <td className="mono r-"><b>{fmt(t.per.reduce((a, b) => a + b, 0))}</b></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
                <Provenance>
                  A dash is no estimate for that district-crop, not zero hectares.
                  {' '}{cropName.size ? '' : ''}
                </Provenance>
              </Card>
            </>
          )
        }}
      </Panel>
    </>
  )
}
