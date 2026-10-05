import { useState } from 'react'
import { API, authHeader } from '../lib/api'
import { MAX_YIELD, fmtDate, title } from '../lib/format'
import { useCountUp } from '../hooks/useFarmData'
import { Badge, Button, Card, CardHead, Meter, NotWired, PageHead, Row, Skeleton } from '../components/ui'
import { Caveats, PredictionGate } from '../components/panels'
import { YieldHistoryChart } from './DashboardPage'

/** Comparison rows. Each hides itself when its data is absent rather than
 *  rendering a zero, which would read as "the average is 0 t/ha". */
function Comparison({ pred, district }) {
  const rows = []
  if (pred?.predicted_yield != null) rows.push(['This season (predicted)', pred.predicted_yield, true])
  const t = pred?.trend ?? []
  if (t.length) rows.push([`Last season ${t[t.length - 1].season}`, t[t.length - 1].yield_t_ha])
  if (t.length >= 3) {
    const last3 = t.slice(-3)
    rows.push(['3-season average', last3.reduce((s, r) => s + r.yield_t_ha, 0) / last3.length])
  }
  if (t.length >= 2) {
    rows.push([`${t.length}-season average`, t.reduce((s, r) => s + r.yield_t_ha, 0) / t.length])
  }
  if (pred?.district_average != null) rows.push([`${district} district`, pred.district_average])

  if (rows.length <= 1) {
    return (
      <Card>
        <CardHead title="Current vs historical average" right="t/ha" />
        <div className="mt-4">
          <NotWired
            what="No history to compare against."
            why={`District yields for ${district} have not been loaded. Every row here is derived
                  from district_yields, so they appear together once that table holds rows.`}
          />
        </div>
      </Card>
    )
  }
  const top = Math.max(MAX_YIELD, ...rows.map(([, v]) => v))

  return (
    <Card>
      <CardHead title="Current vs historical average" right="t/ha" />
      <div className="mt-4 space-y-4">
        {rows.map(([label, v, now]) => (
          <div key={label}>
            <div className="flex items-baseline justify-between">
              <span className="text-sm">{label}</span>
              <span className="tnum text-sm font-semibold">{v.toFixed(2)}</span>
            </div>
            <div className="mt-1.5">
              <Meter value={v} max={top} tone={now ? 'bg-leaf-700' : 'bg-leaf-200'} />
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** The measured inputs behind the number.
 *
 * ONLY THE SATELLITE INDICES. The design also shows rainfall and heat-day
 * counts; those are computed inside model_extras() for the wider model and are
 * NOT returned by /predict, so there is nothing to read them from here. Adding
 * them would be an API change, not a frontend one.
 */
function Drivers({ pred }) {
  if (!pred?.features) return null
  const f = pred.features
  const cards = [
    ['Canopy greenness (NDVI)', f.ndvi, 'Main yield driver in this model'],
    ['Canopy water (NDWI)', f.ndwi, 'Negative reads as water stress'],
    ['Enhanced vegetation (EVI)', f.evi, 'Greenness, atmosphere-corrected'],
    ['Soil-adjusted (SAVI)', f.savi, 'Greenness, bare-soil-corrected'],
  ]
  return (
    <Card>
      <CardHead title="What drives this prediction"
                right={pred.feature_date ? `observed ${fmtDate(pred.feature_date)}` : 'model features'} />
      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, v, hint]) => (
          <div key={label} className="rounded-xl border border-leaf-100 p-4">
            <p className="text-xs text-muted">{label}</p>
            <p className="tnum mt-1 font-display text-2xl font-semibold">{v?.toFixed(3) ?? '—'}</p>
            <p className="mt-1 text-xs text-muted">{hint}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11px] text-muted">
        Rainfall and heat-day counts are not shown: they are computed for the wider model
        inside the service and are not returned by the prediction endpoint, so there is
        nothing here to read them from.
      </p>
    </Card>
  )
}

export default function YieldPredictionPage({ farm, data }) {
  const { pred, err, fetching, refreshImagery } = data
  const [downloading, setDownloading] = useState(false)
  const yieldNow = useCountUp(pred?.predicted_yield)
  const ci = pred?.confidence_interval ?? [0, 0]

  async function downloadReport() {
    setDownloading(true)
    try {
      const r = await fetch(API + '/farms/' + farm.id + '/report', { headers: await authHeader() })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const url = URL.createObjectURL(await r.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `${farm.farmer_name}-yield-report.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('Report failed: ' + e.message)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHead
        title="Yield prediction"
        sub={`${farm.farmer_name} · ${title(farm.crop_type)} ${title(farm.season)}${
          pred ? ` · ${pred.model_used}` : ''}`}
      >
        <Button variant="ghost" onClick={downloadReport} disabled={!pred || downloading}>
          {downloading ? 'Generating…' : 'Download PDF'}
        </Button>
      </PageHead>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="relative overflow-hidden rounded-2xl border border-leaf-100 bg-linear-to-br from-leaf-50 via-white to-wheat-50 p-7 text-ink shadow-sm">
          <svg aria-hidden="true" viewBox="0 0 600 200" className="absolute inset-0 h-full w-full opacity-7">
            {Array.from({ length: 10 }, (_, i) => (
              <path key={i} d={'M -20 ' + (20 + i * 22) + ' Q 300 ' + (-10 + i * 22) + ' 620 ' + (40 + i * 22)}
                    stroke="#1a7f4b" strokeWidth="1.1" fill="none" />
            ))}
          </svg>
          <div className="relative">
            <p className="text-xs font-semibold uppercase tracking-widest text-leaf-700">Predicted yield</p>

            {!pred && !err && !fetching && (
              <div className="mt-3 animate-pulse space-y-3">
                <div className="h-14 w-40 rounded-lg bg-leaf-100" />
                <div className="h-3 w-56 rounded bg-leaf-100" />
              </div>
            )}

            {(err || fetching) && (
              <div className="mt-3">
                <PredictionGate err={err} fetching={fetching} onFetch={refreshImagery}
                                crop={farm.crop_type} />
              </div>
            )}

            {pred && (
              <>
                <p className="mt-3 flex items-baseline gap-2">
                  <span className="tnum font-display text-6xl font-semibold leading-none">
                    {yieldNow.toFixed(2)}
                  </span>
                  <span className="text-xl text-muted">{pred.unit}</span>
                </p>

                {/* Confidence range on a fixed 0-6 t/ha scale, so the bar's width
                    means something across farms instead of rescaling per result. */}
                <div className="mt-6 max-w-md">
                  <div className="relative h-2 rounded-full bg-leaf-100">
                    <div className="absolute h-2 rounded-full bg-leaf-300"
                         style={{ left: (ci[0] / MAX_YIELD) * 100 + '%',
                                  width: ((ci[1] - ci[0]) / MAX_YIELD) * 100 + '%' }} />
                    {pred.district_average != null && (
                      <div className="absolute -top-2 h-6 w-0.5 bg-leaf-700"
                           style={{ left: (pred.district_average / MAX_YIELD) * 100 + '%' }}
                           title={'District average ' + pred.district_average + ' ' + pred.unit} />
                    )}
                    <div className="absolute -top-1 h-4 w-1 rounded-full bg-wheat-400"
                         style={{ left: (pred.predicted_yield / MAX_YIELD) * 100 + '%' }} />
                  </div>
                  <p className="tnum mt-2 text-xs text-muted">
                    {ci[0]}–{ci[1]} {pred.unit} · model spread
                  </p>
                </div>

                <div className="mt-7 flex flex-wrap gap-x-12 gap-y-4">
                  {pred.district_average != null && (
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted">
                        vs {farm.district} average
                      </p>
                      <p className="tnum mt-1 text-2xl font-semibold">
                        {pred.vs_district_pct > 0 ? '+' : ''}{pred.vs_district_pct}%
                        <span className="ml-2 text-sm font-normal text-muted">
                          ({pred.district_average} {pred.unit})
                        </span>
                      </p>
                    </div>
                  )}
                  {pred.trend_pct != null && (
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted">Season on season</p>
                      <p className="tnum mt-1 text-2xl font-semibold">
                        {pred.trend_pct > 0 ? '▲ +' : '▼ '}{pred.trend_pct}%
                        <span className="ml-2 text-sm font-normal text-muted">
                          over {pred.trend?.length} seasons
                        </span>
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <Card>
          <CardHead title="Model information" />
          <div className="mt-3">
            {pred ? (
              <>
                <Row label="Model" value={pred.model_used} />
                <Row label="Prediction confidence"
                     value={<Badge tone={pred.model_status === 'validated' ? 'leaf' : 'wheat'}>
                       {title(pred.model_status)}
                     </Badge>} />
                <Row label="Model spread"
                     value={`±${((ci[1] - ci[0]) / 2).toFixed(2)} ${pred.unit}`} />
                <Row label="Last imagery date"
                     value={pred.feature_date ? fmtDate(pred.feature_date) : '—'} />
                <Row label="Crop" value={title(pred.crop_type)} />
                <Row label="District comparison"
                     value={pred.district_average != null
                       ? `${pred.district_average} ${pred.unit}` : 'not loaded'} />
              </>
            ) : (
              <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-4 w-full" />)}</div>
            )}
          </div>
        </Card>
      </div>

      <Caveats items={pred?.caveats} />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHead title="Historical yield" right="t/ha" />
          <div className="mt-5">
            <YieldHistoryChart trend={pred?.trend} predicted={pred?.predicted_yield}
                               unit={pred?.unit ?? 't/ha'} district={farm.district} />
          </div>
        </Card>
        <div className="lg:col-span-2">
          <Comparison pred={pred} district={farm.district} />
        </div>
      </div>

      <Drivers pred={pred} />
    </div>
  )
}
