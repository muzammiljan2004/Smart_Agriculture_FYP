import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
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

export default function Dashboard({ farm }) {
  const [pred, setPred] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    setPred(null)
    setErr(null)

    // Prediction goes through FastAPI, not Supabase: it needs GEE features and
    // the pickled forest, neither of which lives in Postgres.
    fetch(`${API}/farms/${farm.id}/predict`)
      .then(async (r) => {
        const body = await r.json()
        if (!r.ok) throw new Error(body.detail ?? `HTTP ${r.status}`)
        return body
      })
      .then((d) => alive && setPred(d))
      .catch((e) => alive && setErr(e.message))

    return () => { alive = false }   // stale response must not overwrite newer state
  }, [farm.id])

  const pos = [farm.gps_lat, farm.gps_lng]

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="bg-white rounded-lg shadow p-5">
        <h2 className="text-lg font-semibold">{farm.farmer_name}</h2>
        <p className="text-sm text-gray-500">
          {farm.crop_type} · {farm.district} · {farm.gps_lat.toFixed(4)}, {farm.gps_lng.toFixed(4)}
        </p>

        <div className="mt-4 border-t pt-4">
          {!pred && !err && <p className="text-gray-500">Predicting…</p>}

          {err && (
            <div className="text-sm">
              <p className="text-red-600 font-medium">Could not predict</p>
              <p className="text-gray-600 mt-1">{err}</p>
            </div>
          )}

          {pred && (
            <>
              <p className="text-sm text-gray-500">Predicted yield</p>
              <p className="text-3xl font-semibold text-green-800">
                {pred.predicted_yield} <span className="text-lg font-normal">{pred.unit}</span>
              </p>
              <p className="text-sm text-gray-500 mt-1">
                Range {pred.confidence_interval[0]}–{pred.confidence_interval[1]} {pred.unit} · {pred.model_used}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <MapContainer center={pos} zoom={13} className="h-80 w-full">
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
          <Marker position={pos}>
            <Popup>{farm.farmer_name} — {farm.crop_type}</Popup>
          </Marker>
        </MapContainer>
      </div>
    </div>
  )
}
