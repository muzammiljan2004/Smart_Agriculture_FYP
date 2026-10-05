import { useMemo, useState } from 'react'
import GovMap from '../GovMap'
import { HRows, Line } from '../lib/charts'
import { RAMPS, dash, f1, mean, norm, ramp, title } from '../lib/fmt'
import {
  Card, Chip, Empty, MapLegendGradient, PageHead, Panel, Provenance, Tabs,
} from '../lib/ui'
import { fetchCropHistory } from '../lib/queries'
import { useFacts } from '../lib/useFacts'
import { useQuery } from '../lib/useQuery'

/**
 * Screen 4 — spectral indices by district.
 *
 * The five indices are REAL COLUMNS on gov_satellite_indices, not transforms of
 * NDVI. The design derived EVI, NDWI, SAVI and NBR from NDVI with a fitted
 * multiplier (`fn: n => n*.72+.03`) because it had only one synthetic series to
 * work from; the pipeline computes all five independently in Google Earth Engine,
 * so each is read from its own column. The formulas below are documentation, not
 * the calculation.
 *
 * The design's composite selector ("latest 5-day", "previous") is also gone: the
 * stored observation is one season-long median composite per district-crop, not a
 * rolling 5-day series, so there are no composites to step between. The season
 * selector in the header is the real equivalent and is what this screen uses.
 */
const INDICES = {
  ndvi: {
    label: 'NDVI', ramp: RAMPS.ndvi, lo: 0.2, hi: 0.8,
    formula: '(NIR − Red) / (NIR + Red)',
    about: 'Canopy greenness and vigour. The index the yield model leans on most.',
  },
  evi: {
    label: 'EVI', ramp: RAMPS.ndvi, lo: 0.1, hi: 0.6,
    formula: '2.5 × (NIR − Red) / (NIR + 6·Red − 7.5·Blue + 1)',
    about: 'Enhanced vegetation index. Saturates less than NDVI over a dense canopy.',
  },
  ndwi: {
    label: 'NDWI', ramp: [...RAMPS.water].reverse(), lo: -0.2, hi: 0.3,
    formula: '(Green − NIR) / (Green + NIR)',
    about: 'Canopy and surface water. Falling NDWI on a standing crop points at irrigation gaps.',
  },
  savi: {
    label: 'SAVI', ramp: RAMPS.ndvi, lo: 0.1, hi: 0.6,
    formula: '1.5 × (NIR − Red) / (NIR + Red + 0.5)',
    about: 'Soil-adjusted. More reliable than NDVI early in a season, over partial cover.',
  },
  nbr: {
    label: 'NBR', ramp: RAMPS.ndvi, lo: 0.0, hi: 0.5,
    formula: '(NIR − SWIR2) / (NIR + SWIR2)',
    about: 'Normalised burn ratio. Residue burning and burn scars.',
  },
}

export default function SatellitePage({ dims, crop, season, cropRow, seasonRow }) {
  const facts = useFacts({ dims, crop, season })
  const history = useQuery(() => fetchCropHistory({ cropId: crop }), [crop], { enabled: Boolean(crop) })
  const [key, setKey] = useState('ndvi')
  const ix = INDICES[key]

  return (
    <>
      <PageHead title="Satellite monitoring"
                sub={`Sentinel-2 L2A seasonal composites · ${title(cropRow?.name ?? '')} · ${seasonRow?.label ?? ''}`} />

      <Tabs items={Object.entries(INDICES).map(([k, v]) => [k, v.label])}
            value={key} onChange={setKey} />

      <Panel q={facts} skeleton={400}
             empty={<Empty what="No imagery loaded for this crop and season."
                           why="Each row is a median composite over the crop's observation window; a season with no usable scenes has no row." />}>
        {(rows) => {
          const withIx = rows.filter((r) => r.indices?.[key] != null)
          const vals = withIx.map((r) => Number(r.indices[key])).sort((a, b) => a - b)
          const avg = mean(withIx.map((r) => r.indices), key)
          const pct = (p) => (vals.length ? vals[Math.min(vals.length - 1,
            Math.max(0, Math.floor((p / 100) * vals.length)))] : null)

          return (
            <>
              <div className="grid g32">
                <Card title={`${ix.label} by district`} sub={ix.about}>
                  <GovMap
                    id="sat-map" height={460} data={rows} fillOpacity={0.62}
                    fill={(d) => (d.indices?.[key] == null ? null
                      : ramp(ix.ramp, norm(Number(d.indices[key]), ix.lo, ix.hi)))}
                    tip={(d) => `<b>${d.name}</b><br>${ix.label} ${dash(d.indices?.[key])}`
                      + (d.indices?.date ? `<br>composite centred ${d.indices.date}` : '')}
                    legend={<MapLegendGradient title={ix.label} stops={ix.ramp}
                                               lo={f1(ix.lo, 2)} hi={f1(ix.hi, 2)}
                                               note="Grey = no composite" />}
                    badge={`${withIx.length} of ${rows.length} districts`}
                  />
                </Card>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Card title="Statistics" sub={`${withIx.length} districts with a composite`}>
                    {withIx.length === 0 ? (
                      <Empty what="Nothing to summarise." why="" />
                    ) : (
                      <div className="grid g2" style={{ margin: 0 }}>
                        {[
                          ['Mean', dash(avg.value)],
                          ['Median', dash(pct(50))],
                          ['10th percentile', dash(pct(10))],
                          ['90th percentile', dash(pct(90))],
                        ].map(([l, v]) => (
                          <div key={l}>
                            <div className="lbl">{l}</div>
                            <div style={{ font: '700 22px var(--display)' }}>{v}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <Provenance>
                      Unweighted across districts. A production-weighted mean would need crop
                      area per district, which is not loaded.
                    </Provenance>
                  </Card>

                  <Card title="Index definition">
                    <p style={{ marginBottom: 8 }}>{ix.about}</p>
                    <div className="chip n" style={{
                      fontFamily: 'ui-monospace,Menlo,monospace', whiteSpace: 'normal',
                    }}>
                      {ix.formula}
                    </div>
                    <Provenance>
                      Computed in Google Earth Engine over the district's cropland for this
                      crop's observation window, then stored per district-crop-season. Each of
                      the five is computed from the bands independently — none is derived from
                      another.
                    </Provenance>
                  </Card>

                  <Card title="Lowest-scoring districts" sub={ix.label}>
                    {withIx.length === 0 ? <Empty what="No values." why="" /> : (
                      <HRows
                        rows={[...withIx]
                          .sort((a, b) => Number(a.indices[key]) - Number(b.indices[key]))
                          .slice(0, 7)
                          .map((r) => ({
                            l: r.name,
                            v: norm(Number(r.indices[key]), ix.lo - 0.1, ix.hi),
                            max: 1,
                            t: f1(Number(r.indices[key]), 2),
                          }))}
                      />
                    )}
                  </Card>
                </div>
              </div>

              <div className="grid g2">
                <Card title={`${ix.label} across seasons`} sub={`${title(cropRow?.name)} · province mean`}>
                  <Panel q={history} skeleton={190}
                         empty={<Empty what="No index history for this crop." why="" />}>
                    {(h) => <IndexTrend h={h} seasons={dims.seasons} field={key} label={ix.label} />}
                  </Panel>
                </Card>

                <Card title="What is stored" sub="One composite per district, crop and season">
                  <div className="list-row">
                    <div className="grow">
                      <b>Seasonal median composite</b>
                      <p>
                        Every Sentinel-2 L2A scene inside the crop's observation window is
                        cloud-masked and reduced to a per-pixel median, then averaged over the
                        district. One value per index.
                      </p>
                    </div>
                    <Chip>Stored</Chip>
                  </div>
                  <div className="list-row">
                    <div className="grow">
                      <b>Within-season time series</b>
                      <p>
                        A date-by-date curve at district grain is not stored. The experimental
                        temporal work under experimental/temporal_features/ fetched one and did
                        not reach production — LOSO validation left five of eleven crops
                        negative, so it was not promoted.
                      </p>
                    </div>
                    <Chip tone="n">Not stored</Chip>
                  </div>
                  <div className="list-row">
                    <div className="grow">
                      <b>Radar backscatter (VV/VH)</b>
                      <p>
                        Sentinel-1 is collected per FARM on the farmer side, not per district.
                        Flood detection would need it at this grain.
                      </p>
                    </div>
                    <Chip tone="n">Not at this grain</Chip>
                  </div>
                </Card>
              </div>
            </>
          )
        }}
      </Panel>
    </>
  )
}

function IndexTrend({ h, seasons, field, label }) {
  const { labels, series, counts } = useMemo(() => {
    const by = new Map(seasons.map((s) => [s.id, []]))
    h.indices.forEach((r) => {
      if (r[field] != null) by.get(r.season_id)?.push(Number(r[field]))
    })
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
    return {
      labels: seasons.map((s) => s.label.slice(2)),
      series: seasons.map((s) => avg(by.get(s.id))),
      counts: seasons.map((s) => by.get(s.id).length),
    }
  }, [h, seasons, field])

  if (!series.some((v) => v != null)) {
    return <Empty what={`No ${label} values across seasons.`} why="" />
  }

  return (
    <>
      <Line labels={labels} h={190} dec={2}
            series={[{ c: 'var(--g700)', v: series, area: 1, name: label }]}
            alt={`${label} by season`} />
      <Provenance>
        Mean across the {Math.min(...counts.filter(Boolean))}–{Math.max(...counts)} districts with
        a composite in each season. A gap in the line is a season with no stored composite, not a
        reading of zero.
      </Provenance>
    </>
  )
}
