import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Circle, LayersControl } from 'react-leaflet'
import L from 'leaflet'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

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

export default function Dashboard({ farm }) {
  const [pred, setPred] = useState(null)
  const [err, setErr] = useState(null)
  const yieldNow = useCountUp(pred?.predicted_yield)

  useEffect(() => {
    let alive = true
    setPred(null)
    setErr(null)

    // Prediction goes through FastAPI, not Supabase: it needs GEE features and
    // the pickled forest, neither of which lives in Postgres.
    fetch(API + '/farms/' + farm.id + '/predict')
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body.detail ?? 'HTTP ' + r.status)
        return body
      })
      .then((d) => alive && setPred(d))
      .catch((e) => alive && setErr(e.message))

    return () => { alive = false }   // stale response must not overwrite newer state
  }, [farm.id])

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
        <div className="flex gap-2">
          <span className="rounded-full bg-wheat-300/40 px-3 py-1 text-xs font-medium capitalize text-wheat-500">
            {farm.crop_type}
          </span>
          <span className="rounded-full bg-leaf-100 px-3 py-1 text-xs font-medium capitalize text-leaf-700">
            {farm.season}
          </span>
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
                  <div
                    className="absolute -top-1 h-4 w-1 rounded-full bg-wheat-400"
                    style={{ left: (pred.predicted_yield / MAX_YIELD) * 100 + '%' }}
                  />
                </div>
                <p className="mt-2 tnum text-xs text-leaf-300">
                  {ci[0]}–{ci[1]} {pred.unit} · model spread
                </p>
              </div>

              <p className="mt-5 text-xs text-leaf-300/80">
                {pred.model_used}
                {pred.feature_date && ' · imagery ' + pred.feature_date}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Indices */}
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-leaf-100 lg:col-span-2">
          <h3 className="font-display text-lg font-semibold">Spectral indices</h3>
          <p className="mt-1 text-xs text-muted">Sentinel-2, cloud-masked median composite</p>

          <div className="mt-5 space-y-4">
            {pred?.features
              ? Object.keys(INDEX_META).map((k) => <IndexBar key={k} name={k} value={pred.features[k]} />)
              : Object.keys(INDEX_META).map((k) => (
                  <div key={k} className="animate-pulse space-y-1.5">
                    <div className="h-3 w-16 rounded bg-leaf-100" />
                    <div className="h-1.5 w-full rounded-full bg-leaf-100" />
                  </div>
                ))}
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
