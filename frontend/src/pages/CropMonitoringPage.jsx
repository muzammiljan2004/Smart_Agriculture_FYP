import { fmtDate, title } from '../lib/format'
import NdviChart from '../components/NdviChart'
import { Badge, Card, CardHead, NotWired, PageHead, Skeleton } from '../components/ui'
import { GrowthTracker, PredictionGate, SuitabilityPanel } from '../components/panels'

const TABS = [
  ['growth', 'Growth Stage'],
  ['health', 'Crop Health'],
  ['suitability', 'Crop Suitability'],
]

/** NDVI over the season, drawn from the stored field time series.
 *
 * ONLY THIS FARM'S LINE. The design shows a district average alongside it, and
 * that series does not exist: /timeseries reduces one field's own geometry, and
 * nothing in the API returns a per-date district mean. Drawing a second line
 * would mean inventing it, so the chart carries one line and says so.
 */
function HealthTrend({ series, error, sownDate }) {
  if (error) {
    return <Card><CardHead title="Health trend since sowing" />
      <p className="mt-3 text-sm text-red-700">{error}</p></Card>
  }
  const pts = (series?.series ?? []).filter((r) => r.ndvi != null)
  if (!series) {
    return <Card><CardHead title="Health trend since sowing" />
      <div className="mt-6"><Skeleton className="h-40 w-full" /></div></Card>
  }
  if (pts.length < 2) {
    return (
      <Card>
        <CardHead title="Health trend since sowing" />
        <div className="mt-4">
          <NotWired what="Not enough observations."
                    why="At least two cloud-free Sentinel-2 passes are needed to draw a curve." />
        </div>
      </Card>
    )
  }

  // "cloud-free" was wrong in the old header: the field fetch admits scenes up
  // to 60% cloud and relies on the per-pixel mask, so some of these dates saw
  // only part of the field. The count says observations, and the chart marks
  // which ones were thin.
  const px = pts.map((p) => p.valid_px || 0).sort((a, b) => a - b)
  const medianPx = px[Math.floor(px.length / 2)] || 0
  const thin = pts.filter((p) => medianPx > 0 && (p.valid_px || 0) < medianPx * 0.5).length

  return (
    <Card>
      <CardHead title="Health trend since sowing"
                right={`${pts.length} observations`} />
      <div className="mt-4">
        <NdviChart points={pts} sownDate={sownDate} />
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-leaf-700" /> This field's NDVI
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-wheat-500 bg-white" />
          Most of the field cloud-masked
          {thin > 0 && <span className="tnum"> ({thin})</span>}
        </span>
        <span>{fmtDate(pts[0].date)} → {fmtDate(pts[pts.length - 1].date)}</span>
        <span>Hover for the exact reading</span>
      </p>
      <p className="mt-2 text-[11px] text-muted">
        One line only. A district average per date is not produced by the API — the time
        series endpoint reduces this field's own geometry — so none is drawn rather than invented.
      </p>
    </Card>
  )
}

/** Crop health read off the indices and the open alerts. */
function CropHealth({ pred, err, fetching, onFetch, crop }) {
  if (!pred) {
    return (
      <Card>
        <CardHead title="Crop health" />
        <div className="mt-4">
          {err || fetching
            ? <PredictionGate err={err} fetching={fetching} onFetch={onFetch} crop={crop} />
            : <Skeleton className="h-24 w-full" />}
        </div>
      </Card>
    )
  }

  const f = pred.features ?? {}
  const ndvi = f.ndvi ?? 0
  // The same bands app/field.py uses to describe a canopy: below 0.25 is bare
  // or near-bare ground, 0.6 and up is a closed canopy.
  const status = ndvi >= 0.6 ? ['Good', 'text-leaf-700'] : ndvi >= 0.35 ? ['Fair', 'text-wheat-500'] : ['Sparse', 'text-red-700']
  const water = f.ndwi == null ? null : f.ndwi < 0 ? ['High', 'red'] : f.ndwi < 0.15 ? ['Moderate', 'wheat'] : ['Low', 'leaf']
  const alerts = pred.alerts ?? []

  return (
    <Card>
      <CardHead title="Crop health" right={pred.feature_date ? `observed ${fmtDate(pred.feature_date)}` : null} />
      <div className="mt-5 grid gap-6 sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="relative grid h-32 w-32 place-items-center">
          <svg viewBox="0 0 36 36" className="absolute h-32 w-32 -rotate-90">
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#d7e9dd" strokeWidth="3.4" />
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#2f7d57" strokeWidth="3.4"
                    strokeDasharray={`${Math.max(2, Math.min(100, ndvi * 100))} 100`} strokeLinecap="round" />
          </svg>
          <span className={'font-display text-xl font-semibold ' + status[1]}>{status[0]}</span>
        </div>

        <dl className="min-w-0">
          <div className="flex items-baseline justify-between border-b border-leaf-100 py-2.5">
            <dt className="text-sm text-muted">Health status</dt>
            <dd className="text-sm font-semibold">{status[0]}</dd>
          </div>
          <div className="flex items-baseline justify-between border-b border-leaf-100 py-2.5">
            <dt className="text-sm text-muted">Vegetation condition</dt>
            <dd className="tnum text-sm font-semibold">
              {status[0]} (NDVI {ndvi.toFixed(3)})
            </dd>
          </div>
          {water && (
            <div className="flex items-baseline justify-between py-2.5">
              <dt className="text-sm text-muted">Water stress</dt>
              <dd><Badge tone={water[1]}>{water[0]}</Badge></dd>
            </div>
          )}
        </dl>
      </div>

      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-muted">Recent observations</p>
      {alerts.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No alerts open on this field.</p>
      ) : (
        <ul className="mt-2">
          {alerts.map((a) => (
            <li key={a.id} className="flex items-center gap-3 border-b border-leaf-100 py-3 last:border-0">
              <span className="w-14 shrink-0 text-xs text-muted">
                {new Date(a.triggered_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </span>
              <span className="flex-1 text-sm">{a.message}</span>
              <Badge tone={a.severity === 'critical' ? 'red' : 'wheat'}>{title(a.severity)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export default function CropMonitoringPage({ farm, data, tab = 'growth', onTab }) {
  const { pred, err, suit, suitErr, series, seriesErr, fetching, refreshImagery } = data

  return (
    <div className="space-y-5">
      <PageHead
        title="Crop monitoring"
        sub={`${farm.farmer_name} · ${title(farm.crop_type)} ${title(farm.season)}${
          farm.planting_date ? ` · sown ${fmtDate(farm.planting_date)}` : ''}`}
      />

      <div className="flex gap-1 border-b border-leaf-100">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => onTab(id)}
                  className={'border-b-2 px-4 py-2.5 text-sm transition ' +
                    (tab === id ? 'border-leaf-700 font-semibold text-leaf-800'
                      : 'border-transparent text-muted hover:text-ink')}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'growth' && (
        <>
          {pred?.growth
            ? <GrowthTracker g={pred.growth} />
            : <Card><CardHead title="Growth stage" />
                <div className="mt-4">
                  {err || fetching
                    ? <PredictionGate err={err} fetching={fetching} onFetch={refreshImagery} crop={farm.crop_type} />
                    : <Skeleton className="h-24 w-full" />}
                </div>
              </Card>}
          <HealthTrend series={series} error={seriesErr} sownDate={farm.planting_date} />
        </>
      )}

      {tab === 'health' && (
        <>
          <CropHealth pred={pred} err={err} fetching={fetching}
                      onFetch={refreshImagery} crop={farm.crop_type} />
          <HealthTrend series={series} error={seriesErr} sownDate={farm.planting_date} />
        </>
      )}

      {tab === 'suitability' && (
        <SuitabilityPanel data={suit} loading={!suit && !suitErr} error={suitErr} />
      )}
    </div>
  )
}
