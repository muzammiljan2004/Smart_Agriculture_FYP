import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Circle, LayersControl } from 'react-leaflet'
import L from 'leaflet'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import { supabase } from './supabase'

// Leaflet builds its default marker's <img src> by string-concatenating paths
// relative to the CSS file. Vite hashes and moves assets at build time, so
// those paths 404 and every marker renders invisible. Importing the images
// lets Vite rewrite them to the real hashed URLs.
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
})

const API = import.meta.env.VITE_ML_API_URL
const MAX_YIELD = 6 // t/ha - the ceiling the model is clipped to, so bars share a scale

const INDEX_META = {
  ndvi: ['NDVI', 'Canopy greenness - the main yield driver'],
  evi: ['EVI', 'Greenness, corrected for atmosphere'],
  ndwi: ['NDWI', 'Canopy water content'],
  savi: ['SAVI', 'Greenness, corrected for bare soil'],
  nbr: ['NBR', 'Burn index - near-zero influence on wheat'],
}

const authHeader = async () => {
  const { data } = await supabase.auth.getSession()
  return { Authorization: 'Bearer ' + data.session?.access_token }
}

/** Counts from 0 to `to` once, on mount and whenever `to` changes. */
function useCountUp(to, ms = 900) {
  const [n, setN] = useState(0)
  const raf = useRef()
  useEffect(() => {
    if (to == null) return
    const t0 = performance.now()
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms)
      setN(to * (1 - Math.pow(1 - p, 3))) // ease-out cubic
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [to, ms])
  return n
}

function IndexBar({ name, value }) {
  const [label, hint] = INDEX_META[name] ?? [name, '']
  // Indices live in [-1, 1]; map onto the bar so a negative value reads as
  // left-of-centre rather than silently clamping to empty.
  const pct = ((value + 1) / 2) * 100
  return (
    <div className="group">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold tracking-wide text-muted">{label}</span>
        <span className="tnum text-sm font-semibold">{value.toFixed(3)}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full rounded-full bg-leaf-100">
        <div
          className="h-1.5 rounded-full bg-leaf-500 transition-[width] duration-700"
          style={{ width: Math.max(2, Math.min(100, pct)) + '%' }}
        />
      </div>
      <p className="mt-1 text-[11px] leading-tight text-muted opacity-0 transition group-hover:opacity-100">
        {hint}
      </p>
    </div>
  )
}

/** Phenological stage track. Everything comes from the API's growth object. */
function GrowthTracker({ g }) {
  const stages = g.stages ?? []
  const idx = g.stage_index ?? -1

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-leaf-100">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-semibold">Growth stage</h3>
        <span className="tnum text-xs text-muted">
          day {g.days_since_sowing} · {g.progress_pct}% of season
        </span>
      </div>

      <p className="mt-3">
        <span className="font-display text-2xl font-semibold text-leaf-700">{g.stage}</span>
        {g.next_stage && (
          <span className="ml-2 text-sm text-muted">
            → {g.next_stage} in ~{g.days_to_next_stage} days
          </span>
        )}
      </p>

      {/* Stage track. Passed stages fill; the current one is marked. */}
      <ol className="mt-5 flex gap-1">
        {stages.map((s, i) => (
          <li key={s} className="flex-1">
            <div
              className={
                'h-1.5 rounded-full transition ' +
                (i < idx ? 'bg-leaf-400' : i === idx ? 'bg-leaf-700' : 'bg-leaf-100')
              }
            />
            <p
              className={
                'mt-1.5 text-[10px] leading-tight ' +
                (i === idx ? 'font-semibold text-leaf-700' : 'text-muted')
              }
            >
              {s}
            </p>
          </li>
        ))}
      </ol>

      <p className="mt-4 text-xs text-muted">
        Sown {g.planting_date}
        {g.planting_date_estimated && (
          <span className="text-wheat-500">
            {' '}
            — estimated from the season, not entered by the farmer
          </span>
        )}
        . Calendar-based estimate; not confirmed against satellite imagery.
      </p>
    </div>
  )
}

function Alerts({ items }) {
  if (!items?.length) {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-leaf-100">
        <h3 className="font-display text-lg font-semibold">Alerts</h3>
        <p className="mt-2 text-sm text-muted">No active alerts for this farm.</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-leaf-100">
      <h3 className="font-display text-lg font-semibold">
        Alerts <span className="text-sm font-normal text-muted">({items.length} active)</span>
      </h3>
      <ul className="mt-4 space-y-3">
        {items.map((a) => {
          const critical = a.severity === 'critical'
          return (
            <li
              key={a.id}
              className={
                'rounded-xl px-4 py-3 ring-1 ' +
                (critical ? 'bg-red-50 ring-red-100' : 'bg-wheat-300/20 ring-wheat-300/50')
              }
            >
              <p
                className={
                  'text-xs font-semibold uppercase tracking-wide ' +
                  (critical ? 'text-red-700' : 'text-wheat-500')
                }
              >
                {a.type.replace('_', ' ')} · {a.severity}
              </p>
              <p className="mt-1 text-sm">{a.message}</p>
              <p className="mt-1 text-[11px] text-muted">
                {new Date(a.triggered_at).toLocaleString()}
                {a.emailed_at ? ' · emailed' : ' · not emailed'}
              </p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default function Dashboard({ farm }) {
  const [pred, setPred] = useState(null)
  const [err, setErr] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const yieldNow = useCountUp(pred?.predicted_yield)

  useEffect(() => {
    let alive = true
    setPred(null)
    setErr(null)

    // Prediction goes through FastAPI, not Supabase: it needs GEE features and
    // the pickled forest, neither of which lives in Postgres.
    //
    // The access token must ride along. The API runs on the service_role key,
    // which bypasses RLS, so it cannot tell who is calling unless we say --
    // and it returns 403 for a farm the token does not own.
    authHeader()
      .then((headers) => fetch(API + '/farms/' + farm.id + '/predict', { headers }))
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body.detail ?? 'HTTP ' + r.status)
        return body
      })
      .then((d) => alive && setPred(d))
      .catch((e) => {
        if (!alive) return
        // "Failed to fetch" is the browser's blanket TypeError for a
        // network-level failure (connection refused, CORS, mixed content).
        // It carries no status code and tells the user nothing, so name the
        // most likely cause and the address that was actually tried.
        setErr(
          e.message === 'Failed to fetch'
            ? `Cannot reach the prediction service at ${API}. Is it running? (cd ml-service && uvicorn app.main:app --reload)`
            : e.message
        )
      })

    return () => { alive = false }   // stale response must not overwrite newer state
  }, [farm.id])

  async function downloadReport() {
    setDownloading(true)
    try {
      // Cannot be a plain <a href>: the endpoint needs an Authorization header,
      // which a link cannot carry. Fetch it, then hand the browser a blob.
      const r = await fetch(API + '/farms/' + farm.id + '/report', { headers: await authHeader() })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${farm.farmer_name}-yield-report.pdf`
      a.click()
      URL.revokeObjectURL(url)   // otherwise the blob leaks for the page's lifetime
    } catch (e) {
      setErr('Report failed: ' + e.message)
    } finally {
      setDownloading(false)
    }
  }

  const pos = [farm.gps_lat, farm.gps_lng]
  const ci = pred?.confidence_interval

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Farm identity */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-3xl font-semibold">{farm.farmer_name}</h2>
          <p className="mt-1 tnum text-sm text-muted">
            {farm.district} · {farm.gps_lat.toFixed(4)}, {farm.gps_lng.toFixed(4)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-wheat-300/40 px-3 py-1 text-xs font-medium capitalize text-wheat-500">
            {farm.crop_type}
          </span>
          <span className="rounded-full bg-leaf-100 px-3 py-1 text-xs font-medium capitalize text-leaf-700">
            {farm.season}
          </span>
          {pred && (
            <span
              className={
                'rounded-full px-3 py-1 text-xs font-medium ' +
                (pred.model_status === 'validated'
                  ? 'bg-leaf-100 text-leaf-700'
                  : 'bg-wheat-300/40 text-wheat-500')
              }
              title="Set from the real state of the training data, not hardcoded"
            >
              model: {pred.model_status}
            </span>
          )}
          <button
            onClick={downloadReport}
            disabled={!pred || downloading}
            className="rounded-lg border border-leaf-200 px-3 py-1.5 text-xs font-medium text-leaf-700
                       transition hover:bg-leaf-100 disabled:opacity-50"
          >
            {downloading ? 'Generating…' : 'Download PDF'}
          </button>
        </div>
      </div>

      {/* Yield hero */}
      <div className="relative overflow-hidden rounded-2xl bg-leaf-900 p-7 text-leaf-50 shadow-sm">
        <svg aria-hidden="true" viewBox="0 0 600 200" className="absolute inset-0 h-full w-full opacity-[0.12]">
          {Array.from({ length: 10 }, (_, i) => (
            <path
              key={i}
              d={'M -20 ' + (20 + i * 22) + ' Q 300 ' + (-10 + i * 22) + ' 620 ' + (40 + i * 22)}
              stroke="#d7e9dd"
              strokeWidth="1.1"
              fill="none"
            />
          ))}
        </svg>

        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-widest text-leaf-300">Predicted yield</p>

          {!pred && !err && (
            <div className="mt-3 animate-pulse space-y-3">
              <div className="h-14 w-52 rounded-lg bg-leaf-800" />
              <div className="h-3 w-72 rounded bg-leaf-800" />
            </div>
          )}

          {err && (
            <div className="mt-3 max-w-2xl">
              <p className="font-display text-2xl font-semibold text-wheat-300">No prediction yet</p>
              <p className="mt-2 text-sm text-leaf-200">{err}</p>
            </div>
          )}

          {pred && (
            <>
              <p className="mt-2 flex items-baseline gap-2">
                <span className="tnum font-display text-6xl font-semibold leading-none">
                  {yieldNow.toFixed(2)}
                </span>
                <span className="text-xl text-leaf-300">{pred.unit}</span>
              </p>

              {/* Confidence range on a fixed 0-6 t/ha scale, so the bar's width
                  means something across farms instead of rescaling per result. */}
              <div className="mt-5 max-w-md">
                <div className="relative h-2 rounded-full bg-leaf-800">
                  <div
                    className="absolute h-2 rounded-full bg-leaf-400/70"
                    style={{
                      left: (ci[0] / MAX_YIELD) * 100 + '%',
                      width: ((ci[1] - ci[0]) / MAX_YIELD) * 100 + '%',
                    }}
                  />
                  {/* District average marker, only when we actually know it. */}
                  {pred.district_average != null && (
                    <div
                      className="absolute -top-2 h-6 w-0.5 bg-leaf-200"
                      style={{ left: (pred.district_average / MAX_YIELD) * 100 + '%' }}
                      title={'District average ' + pred.district_average + ' ' + pred.unit}
                    />
                  )}
                  <div
                    className="absolute -top-1 h-4 w-1 rounded-full bg-wheat-400"
                    style={{ left: (pred.predicted_yield / MAX_YIELD) * 100 + '%' }}
                  />
                </div>
                <p className="mt-2 tnum text-xs text-leaf-300">
                  {ci[0]}–{ci[1]} {pred.unit} · model spread
                </p>
              </div>

              {/* Comparison + trend. Each hides itself when its data is absent,
                  rather than rendering a zero that would read as a real value. */}
              <div className="mt-6 flex flex-wrap gap-x-10 gap-y-4">
                {pred.district_average != null && (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-leaf-300">
                      vs {farm.district} average
                    </p>
                    <p className="tnum mt-1 text-lg font-semibold">
                      {pred.vs_district_pct > 0 ? '+' : ''}
                      {pred.vs_district_pct}%
                      <span className="ml-2 text-sm font-normal text-leaf-300">
                        ({pred.district_average} {pred.unit})
                      </span>
                    </p>
                  </div>
                )}

                {pred.trend_pct != null && (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-leaf-300">Season on season</p>
                    <p className="tnum mt-1 text-lg font-semibold">
                      {pred.trend_pct > 0 ? '▲ +' : '▼ '}
                      {pred.trend_pct}%
                      <span className="ml-2 text-sm font-normal text-leaf-300">
                        over {pred.trend?.length} seasons
                      </span>
                    </p>
                  </div>
                )}
              </div>

              {/* Sparkline of district yields by season. */}
              {pred.trend?.length > 1 && (
                <div className="mt-5 flex items-end gap-1" aria-hidden="true">
                  {pred.trend.map((t) => (
                    <div key={t.season} className="flex flex-1 flex-col items-center gap-1">
                      <div
                        className="w-full rounded-t bg-leaf-400/60"
                        style={{ height: Math.max(4, (t.yield_t_ha / MAX_YIELD) * 56) + 'px' }}
                        title={t.season + ': ' + t.yield_t_ha + ' ' + pred.unit}
                      />
                      <span className="text-[9px] text-leaf-300">{t.season}</span>
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-5 text-xs text-leaf-300/80">
                {pred.model_used}
                {pred.feature_date && ' · imagery ' + pred.feature_date}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Caveats. Generated by the API from the real data state, so they
          disappear on their own once real training data and PBS yields land. */}
      {pred?.caveats?.length > 0 && (
        <div className="rounded-2xl bg-wheat-300/15 p-5 ring-1 ring-wheat-300/50">
          <p className="text-xs font-semibold uppercase tracking-wide text-wheat-500">
            Read this before quoting the number
          </p>
          <ul className="mt-2 space-y-1.5">
            {pred.caveats.map((c) => (
              <li key={c} className="flex gap-2 text-sm text-ink/80">
                <span className="text-wheat-500">•</span>
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      {pred?.growth && <GrowthTracker g={pred.growth} />}

      <Alerts items={pred?.alerts} />

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Indices */}
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-leaf-100 lg:col-span-2">
          <h3 className="font-display text-lg font-semibold">Spectral indices</h3>
          <p className="mt-1 text-xs text-muted">Sentinel-2, cloud-masked median composite</p>

          <div className="mt-5 space-y-4">
            {pred?.features ? (
              Object.keys(INDEX_META).map((k) => (
                <IndexBar key={k} name={k} value={pred.features[k]} />
              ))
            ) : err ? (
              // Without this branch the skeletons pulse forever on a failed
              // request, which reads as "still loading" when it has already
              // given up. An error state must look different from a wait.
              <p className="text-sm text-muted">
                Unavailable — the prediction request failed, so there are no indices to show.
              </p>
            ) : (
              Object.keys(INDEX_META).map((k) => (
                <div key={k} className="animate-pulse space-y-1.5">
                  <div className="h-3 w-16 rounded bg-leaf-100" />
                  <div className="h-1.5 w-full rounded-full bg-leaf-100" />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Map */}
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-leaf-100 lg:col-span-3">
          <MapContainer center={pos} zoom={14} scrollWheelZoom={false} className="h-[26rem] w-full">
            <LayersControl position="topright">
              <LayersControl.BaseLayer checked name="Satellite">
                <TileLayer
                  url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                  attribution="Imagery &copy; Esri"
                  maxZoom={18}
                />
              </LayersControl.BaseLayer>
              <LayersControl.BaseLayer name="Street">
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution="&copy; OpenStreetMap contributors"
                />
              </LayersControl.BaseLayer>
            </LayersControl>

            {/* 500 m ring: the plot footprint we'd sample once per-farm geometry
                replaces the district-wide bounding box. */}
            <Circle
              center={pos}
              radius={500}
              pathOptions={{ color: '#ddb45c', weight: 2, fillColor: '#ddb45c', fillOpacity: 0.12 }}
            />
            <Marker position={pos}>
              <Popup>
                {farm.farmer_name} — {farm.crop_type}
              </Popup>
            </Marker>
          </MapContainer>
        </div>
      </div>
    </div>
  )
}
