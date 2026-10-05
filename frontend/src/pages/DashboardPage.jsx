import { useState } from 'react'
import { API, authHeader } from '../lib/api'
import { INDEX_META, MAX_YIELD, fmtDate, title } from '../lib/format'
import { useCountUp } from '../hooks/useFarmData'
import FarmMap from '../components/FarmMap'
import { Badge, Button, Card, CardHead, IndexBar, NotWired, Skeleton } from '../components/ui'
import { Caveats, PredictionGate, SuitabilityPanel } from '../components/panels'

/** The banner the design puts above everything when a critical alert is open. */
function CriticalBanner({ alert, feature_date, features, onNavigate }) {
  if (!alert) return null
  const critical = alert.severity === 'critical'
  return (
    <div className={'flex flex-wrap items-start gap-5 rounded-2xl border-l-4 p-5 ring-1 ' +
      (critical ? 'border-red-700 bg-red-50 ring-red-100'
        : 'border-wheat-400 bg-wheat-300/20 ring-wheat-300/50')}>
      <div className={'grid h-11 w-11 shrink-0 place-items-center rounded-xl ' +
        (critical ? 'bg-card text-red-700' : 'bg-card text-wheat-500')}>
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M12 3s6 6.5 6 10.5a6 6 0 1 1-12 0C6 9.5 12 3 12 3Z" strokeLinejoin="round" />
        </svg>
      </div>

      <div className="min-w-[16rem] flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className={'font-semibold ' + (critical ? 'text-red-700' : 'text-wheat-500')}>
            ● {title(alert.severity)} alert
          </span>
          <span className="font-semibold capitalize">{String(alert.type).replace(/_/g, ' ')}</span>
          <span className="text-muted">· detected {new Date(alert.triggered_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        </p>
        <p className="mt-1.5 font-display text-xl font-semibold">{alert.message}</p>

        <div className="mt-4 flex flex-wrap gap-x-10 gap-y-3 text-sm">
          {features?.ndwi != null && (
            <div>
              <p className="text-xs text-muted">NDWI</p>
              <p className="tnum font-semibold">{features.ndwi.toFixed(3)}</p>
            </div>
          )}
          {feature_date && (
            <div>
              <p className="text-xs text-muted">Satellite observation</p>
              <p className="font-semibold">{fmtDate(feature_date)}</p>
            </div>
          )}
          {/* No "recommended action" field exists on an alert. app/alerts.py
              writes the advice into the message itself ("…Check irrigation."),
              so inventing a column here, or hardcoding one keyed to the alert
              type, would only create a second source of wording to drift from
              the first. What is shown instead is what the row actually holds. */}
          <div>
            <p className="text-xs text-muted">Notification</p>
            <p className="font-semibold">{alert.emailed_at ? 'Emailed' : 'In app only'}</p>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2">
        <Button variant={critical ? 'danger' : 'wheat'} onClick={() => onNavigate('alerts')}>
          View details
        </Button>
        <Button variant="ghost" onClick={() => onNavigate('monitoring', 'health')}>
          Crop health
        </Button>
      </div>
    </div>
  )
}

/** Season-by-season district yields with the current prediction as the last bar. */
export function YieldHistoryChart({ trend, predicted, unit, district, compact = false }) {
  if (!trend?.length) {
    return (
      <NotWired
        what="No season history yet."
        why={`District yields for ${district} have not been loaded, so there is nothing to
              compare this prediction against. The chart appears on its own once
              district_yields holds rows.`}
      />
    )
  }
  const all = [...trend.map((t) => t.yield_t_ha), predicted].filter((v) => v != null)
  const top = Math.max(MAX_YIELD, ...all)
  const avg = trend.reduce((s, t) => s + t.yield_t_ha, 0) / trend.length
  const h = compact ? 100 : 150

  return (
    <div>
      <div className="relative flex items-end gap-2" style={{ height: h + 28 }}>
        {/* District average reference line */}
        <div className="absolute inset-x-0 border-t border-dashed border-wheat-400"
             style={{ bottom: 28 + (avg / top) * h }} aria-hidden="true" />
        {trend.map((t) => (
          <div key={t.season} className="flex flex-1 flex-col items-center justify-end gap-1">
            <span className="tnum text-[10px] text-muted">{t.yield_t_ha.toFixed(1)}</span>
            <div className="w-full rounded-t-md bg-leaf-300"
                 style={{ height: Math.max(4, (t.yield_t_ha / top) * h) }}
                 title={`${t.season}: ${t.yield_t_ha} ${unit}`} />
            <span className="text-[10px] text-muted">{t.season.replace('20', '')}</span>
          </div>
        ))}
        {predicted != null && (
          <div className="flex flex-1 flex-col items-center justify-end gap-1">
            <span className="tnum text-[10px] font-semibold">{predicted.toFixed(1)}</span>
            <div className="w-full rounded-t-md bg-leaf-700"
                 style={{ height: Math.max(4, (predicted / top) * h) }}
                 title={`Predicted: ${predicted} ${unit}`} />
            <span className="text-[10px] font-semibold">Now</span>
          </div>
        )}
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-leaf-700" /> Predicted
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t border-dashed border-wheat-400" />
          {district} average {avg.toFixed(2)} {unit}
        </span>
      </p>
    </div>
  )
}

export default function DashboardPage({ farm, data, onNavigate, onAddFarm }) {
  const { pred, err, suit, suitErr, fetching, refreshImagery } = data
  const [downloading, setDownloading] = useState(false)
  const yieldNow = useCountUp(pred?.predicted_yield)
  const ci = pred?.confidence_interval ?? [0, 0]

  async function downloadReport() {
    setDownloading(true)
    try {
      // Cannot be a plain <a href>: the endpoint needs an Authorization header,
      // which a link cannot carry. Fetch it, then hand the browser a blob.
      const r = await fetch(API + '/farms/' + farm.id + '/report', { headers: await authHeader() })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const url = URL.createObjectURL(await r.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `${farm.farmer_name}-yield-report.pdf`
      a.click()
      URL.revokeObjectURL(url)   // otherwise the blob leaks for the page's lifetime
    } catch (e) {
      alert('Report failed: ' + e.message)
    } finally {
      setDownloading(false)
    }
  }

  const alerts = pred?.alerts ?? []
  const critical = alerts.find((a) => a.severity === 'critical') ?? alerts[0]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{farm.farmer_name}</h1>
          <p className="mt-1 text-sm text-muted">
            {farm.district}
            {farm.area_hectares ? ` · ${farm.area_hectares} ha` : ''}
            {' · '}{title(farm.crop_type)}
            {farm.planting_date ? ` · sown ${fmtDate(farm.planting_date)}` : ' · current season'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="wheat">{title(farm.crop_type)}</Badge>
          <Badge>{title(farm.season)}</Badge>
          {pred && (
            <Badge tone={pred.model_status === 'validated' ? 'leaf' : 'wheat'}>
              Model: {pred.model_status}
            </Badge>
          )}
          <Button variant="ghost" onClick={downloadReport} disabled={!pred || downloading}>
            {downloading ? 'Generating…' : 'Download PDF'}
          </Button>
        </div>
      </div>

      <CriticalBanner alert={critical} feature_date={pred?.feature_date}
                      features={pred?.features} onNavigate={onNavigate} />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Yield hero */}
        <div className="relative overflow-hidden rounded-2xl border border-leaf-100 bg-linear-to-br from-leaf-50 via-white to-wheat-50 p-7 text-ink shadow-sm">
          <svg aria-hidden="true" viewBox="0 0 600 200" className="absolute inset-0 h-full w-full opacity-7">
            {Array.from({ length: 10 }, (_, i) => (
              <path key={i}
                    d={'M -20 ' + (20 + i * 22) + ' Q 300 ' + (-10 + i * 22) + ' 620 ' + (40 + i * 22)}
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

                <div className="mt-6 flex flex-wrap items-center gap-2">
                  {pred.vs_district_pct != null && (
                    <span className="rounded-lg bg-card px-3 py-1.5 text-sm ring-1 ring-leaf-100">
                      <span className="tnum font-semibold">
                        {pred.vs_district_pct > 0 ? '+' : ''}{pred.vs_district_pct}%
                      </span>
                      <span className="text-muted"> vs {farm.district} average</span>
                    </span>
                  )}
                  <span className="tnum text-xs text-muted">
                    {ci[0]}–{ci[1]} model spread
                  </span>
                </div>

                <p className="mt-5 text-xs text-muted">
                  {pred.model_used}{pred.feature_date && ' · imagery ' + pred.feature_date}
                </p>
              </>
            )}
          </div>
        </div>

        {/* Growth stage */}
        <Card>
          <CardHead title="Growth stage" />
          {pred?.growth ? (
            <>
              <p className="mt-3 font-display text-3xl font-semibold text-leaf-700">
                {pred.growth.stage}
              </p>
              <p className="tnum mt-1 text-sm text-muted">
                Day {pred.growth.days_since_sowing} · {pred.growth.progress_pct}% of season
              </p>
              <div className="mt-5 h-1.5 w-full rounded-full bg-leaf-100">
                <div className="h-1.5 rounded-full bg-leaf-600"
                     style={{ width: Math.min(100, pred.growth.progress_pct) + '%' }} />
              </div>
              {pred.growth.harvest_date && (
                <p className="mt-4 text-sm text-muted">
                  {pred.growth.season_state === 'complete' ? 'Season ended ' : 'Expected harvest '}
                  <span className="font-medium text-ink">{fmtDate(pred.growth.harvest_date)}</span>
                </p>
              )}
            </>
          ) : (
            <div className="mt-4 space-y-3"><Skeleton className="h-8 w-32" /><Skeleton className="h-3 w-40" /></div>
          )}
        </Card>

        {/* Active alerts */}
        <Card>
          <CardHead title="Active alerts" />
          <p className="mt-3 font-display text-3xl font-semibold">
            <span className={alerts.some((a) => a.severity === 'critical') ? 'text-red-700' : 'text-leaf-700'}>
              {alerts.length}
            </span>
            <span className="ml-2 text-base font-medium text-muted">
              {alerts.some((a) => a.severity === 'critical') ? 'Critical' : 'open'}
            </span>
          </p>
          <p className="mt-1 text-sm text-muted">
            {alerts.filter((a) => a.severity !== 'critical').length} warning(s) on this farm
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {alerts.slice(0, 3).map((a) => (
              <Badge key={a.id} tone={a.severity === 'critical' ? 'red' : 'wheat'}>
                {String(a.type).replace(/_/g, ' ')}
              </Badge>
            ))}
            {alerts.length === 0 && <Badge tone="leaf">Healthy</Badge>}
          </div>
          <button onClick={() => onNavigate('alerts')}
                  className="mt-4 text-sm font-medium text-leaf-700 hover:underline">
            View all alerts →
          </button>
        </Card>
      </div>

      <Caveats items={pred?.caveats} />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHead
            title="Yield prediction"
            right={<button onClick={() => onNavigate('yield')} className="text-leaf-700 hover:underline">
              View full prediction
            </button>}
          />
          {pred && (
            <p className="mt-3 flex flex-wrap items-baseline gap-3">
              <span className="tnum font-display text-3xl font-semibold">
                {pred.predicted_yield.toFixed(2)}
              </span>
              <span className="text-sm text-muted">{pred.unit}</span>
              {pred.trend_pct != null && (
                <span className="tnum text-sm font-medium text-leaf-700">
                  {pred.trend_pct > 0 ? '▲ +' : '▼ '}{pred.trend_pct}% season on season
                </span>
              )}
            </p>
          )}
          <div className="mt-5">
            <YieldHistoryChart trend={pred?.trend} predicted={pred?.predicted_yield}
                               unit={pred?.unit ?? 't/ha'} district={farm.district} />
          </div>
        </Card>

        <div className="lg:col-span-2">
          <SuitabilityPanel data={suit} loading={!suit && !suitErr} error={suitErr} limit={5} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card pad="p-0" className="overflow-hidden">
          <div className="flex items-baseline justify-between px-6 pb-3 pt-6">
            <h3 className="font-display text-lg font-semibold">Latest satellite image</h3>
            <button onClick={() => onNavigate('field', 'map')}
                    className="text-xs text-leaf-700 hover:underline">Open map</button>
          </div>
          <FarmMap farms={farm} height="h-64" />
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 py-4 text-xs text-muted">
            <span>{farm.district} · {Number(farm.gps_lat).toFixed(4)}, {Number(farm.gps_lng).toFixed(4)}</span>
            <span>Boundary: {farm.area_hectares ?? 1} ha</span>
          </div>
        </Card>

        <Card>
          <CardHead
            title="Field intelligence"
            right={<button onClick={() => onNavigate('field', 'indices')} className="text-leaf-700 hover:underline">
              Details
            </button>}
          />
          <div className="mt-5 space-y-4">
            {pred?.features
              ? Object.keys(INDEX_META).map((k) => (
                <IndexBar key={k} name={k} value={pred.features[k]} showHint={false} />
              ))
              : err
                // Without this branch the skeletons pulse forever on a failed
                // request, which reads as "still loading" when it has already
                // given up. An error state must look different from a wait.
                ? <p className="text-sm text-muted">
                    Unavailable — the prediction request failed, so there are no indices to show.
                  </p>
                : Object.keys(INDEX_META).map((k) => (
                  <div key={k} className="space-y-1.5">
                    <Skeleton className="h-3 w-16" /><Skeleton className="h-1.5 w-full" />
                  </div>
                ))}
          </div>
        </Card>

        <Card>
          <CardHead title="Quick actions" />
          <div className="mt-5 grid grid-cols-2 gap-3">
            {[
              ['Crop health', 'monitoring', 'health'],
              ['Download report', null, null],
              ['Compare seasons', 'yield', null],
              ['Add farm', null, null],
            ].map(([label, page, tab]) => (
              <button
                key={label}
                onClick={() => {
                  if (label === 'Download report') return downloadReport()
                  if (label === 'Add farm') return onAddFarm()
                  onNavigate(page, tab)
                }}
                className="rounded-xl border border-leaf-200 px-4 py-4 text-left text-sm font-medium
                           transition hover:bg-leaf-50"
              >
                {label}
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
