import { useEffect, useMemo, useRef, useState } from 'react'
import { Circle, MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { radiusOf } from './FarmMap'
import { inPunjab, nearestDistrict, round5 } from '../lib/fieldloc'

/* Picking a field without typing coordinates.
 *
 * WHY THIS EXISTS. Registration asked for latitude and longitude as two number
 * boxes. "31.4663" is not a thing a farmer knows about their own land, and a
 * digit typed wrong by one place puts the field 11 km away -- silently, because
 * every value in range is a valid coordinate. The failure is invisible: the farm
 * saves, the imagery comes back, and it describes somebody else's land.
 *
 * Three ways in, cheapest first:
 *   1. the phone's GPS, one tap, which is the common case -- a farmer standing
 *      in or near the field;
 *   2. the satellite map, where you recognise your own plot by its shape and
 *      its neighbours and tap it;
 *   3. the numbers, kept for anyone who has them from a survey or a GPS unit.
 *
 * (3) stays reachable rather than being deleted: it is the only keyboard-only
 * path, a map drag cannot be done without a pointer, and precision from a real
 * survey should not have to be re-tapped by hand.
 *
 * Everything here is already in the project -- react-leaflet, the two tile
 * layers and radiusOf come from FarmMap, and the geolocation API is the
 * browser's. No new dependency.
 */

/** Keeps the map following the pin when it moves from outside the map --
 *  the district <select>, the GPS button, or a typed coordinate. */
function Recentre({ lat, lng, trigger }) {
  const map = useMap()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    map.setView([lat, lng], Math.max(map.getZoom(), 15), { animate: true })
    // `trigger` changes only on those outside moves, so dragging the marker
    // does not yank the view back under the farmer's finger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger])
  return null
}

function ClickToPlace({ onPick }) {
  useMapEvents({ click: (e) => onPick(round5(e.latlng.lat), round5(e.latlng.lng)) })
  return null
}

export default function LocationPicker({ lat, lng, district, districts, area, onChange, onDistrictHint }) {
  const [geoState, setGeoState] = useState('idle')   // idle | locating | error
  const [geoErr, setGeoErr] = useState(null)
  const [accuracy, setAccuracy] = useState(null)
  const [manual, setManual] = useState(false)
  const [moves, setMoves] = useState(0)

  const nLat = Number(lat), nLng = Number(lng)
  const valid = Number.isFinite(nLat) && Number.isFinite(nLng)

  // Bumped only by moves that did NOT come from dragging the marker, so the map
  // recentres on a district change or a GPS fix and stays put during a drag.
  const recentre = () => setMoves((m) => m + 1)

  const hint = useMemo(() => {
    if (!valid) return null
    const near = nearestDistrict(districts, nLat, nLng)
    return near && near.name !== district ? near : null
  }, [nLat, nLng, district, districts, valid])

  function pick(newLat, newLng, { recenter = false } = {}) {
    onChange(String(newLat), String(newLng))
    if (recenter) recentre()
  }

  function locate() {
    setGeoErr(null)
    if (!navigator.geolocation) {
      setGeoState('error')
      return setGeoErr('This browser cannot read a location. Tap your field on the map instead.')
    }
    setGeoState('locating')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy: acc } = pos.coords
        setAccuracy(Math.round(acc))
        setGeoState('idle')
        pick(round5(latitude), round5(longitude), { recenter: true })
      },
      (e) => {
        setGeoState('error')
        // Each case has a different fix, so each gets its own sentence rather
        // than one "could not get location".
        setGeoErr(
          e.code === e.PERMISSION_DENIED
            ? 'Location permission was refused. Allow it in your browser settings, or just tap your field on the map below.'
            : e.code === e.POSITION_UNAVAILABLE
              ? 'Your device could not get a fix — this often fails indoors. Try again outside, or tap your field on the map.'
              : e.code === e.TIMEOUT
                ? 'Getting a location took too long. Try again, or tap your field on the map.'
                : 'Could not read your location. Tap your field on the map instead.'
        )
      },
      // High accuracy because a field boundary is metres, not the ~1 km a
      // network-based fix gives. The long timeout is the cost of a real GPS fix.
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    )
  }

  return (
    <div className="mt-5">
      <p className="text-sm font-medium">Where is your field?</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button" onClick={locate} disabled={geoState === 'locating'}
          className="inline-flex items-center gap-2 rounded-xl bg-leaf-700 px-4 py-2.5 text-sm
                     font-medium text-white transition hover:bg-leaf-800 disabled:opacity-60"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
            <circle cx="12" cy="12" r="8" />
          </svg>
          {geoState === 'locating' ? 'Finding you…' : 'Use my current location'}
        </button>
        <span className="text-xs text-muted">
          or tap your field on the map
        </span>
      </div>

      {geoErr && (
        <p role="alert" className="mt-2 rounded-xl bg-wheat-300/25 px-4 py-2.5 text-xs leading-relaxed
                                   text-wheat-500 ring-1 ring-wheat-300/50">
          {geoErr}
        </p>
      )}

      {accuracy != null && geoState === 'idle' && !geoErr && (
        <p className="mt-2 text-xs text-muted">
          Located to about {accuracy} m.{' '}
          {accuracy > 100
            ? 'That is a rough fix — drag the pin onto your field to correct it.'
            : 'Drag the pin if it is not exactly on your field.'}
        </p>
      )}

      {valid && (
        <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-leaf-100">
          <MapContainer center={[nLat, nLng]} zoom={15} scrollWheelZoom={false}
                        className="h-[18rem] w-full">
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              attribution="Imagery &copy; Esri"
              maxZoom={18}
            />
            <ClickToPlace onPick={(a, b) => pick(a, b)} />
            <Recentre lat={nLat} lng={nLng} trigger={moves} />
            {/* The circle is the area the pipeline actually reduces over, drawn
                from the same radiusOf the map and app/field.py use. Showing it
                here means the farmer sizes the area field against what it does
                rather than against a number with no consequence on screen. */}
            <Circle
              center={[nLat, nLng]} radius={radiusOf(area)}
              pathOptions={{ color: '#d9a441', weight: 2, fillColor: '#d9a441', fillOpacity: 0.12 }}
            />
            <Marker
              position={[nLat, nLng]} draggable
              eventHandlers={{
                dragend: (e) => {
                  const p = e.target.getLatLng()
                  pick(round5(p.lat), round5(p.lng))
                },
              }}
            />
          </MapContainer>
        </div>
      )}

      <p className="mt-2 text-xs text-muted">
        Drag the pin to your field. The yellow circle is the area we read from the
        satellite — it grows with the area you enter below.
      </p>

      {!inPunjab(nLat, nLng) && valid && (
        <p className="mt-2 rounded-xl bg-wheat-300/25 px-4 py-2.5 text-xs leading-relaxed
                      text-wheat-500 ring-1 ring-wheat-300/50">
          This pin is outside Punjab. Soil and suitability are only loaded for the
          34 Punjab districts, so those will be unavailable for this farm.
        </p>
      )}

      {hint && hint.d > 25000 && (
        <p className="mt-2 rounded-xl bg-wheat-300/25 px-4 py-2.5 text-xs leading-relaxed
                      text-wheat-500 ring-1 ring-wheat-300/50">
          This pin is nearest <strong className="font-semibold">{hint.name}</strong>, but the
          district above says {district}.{' '}
          <button type="button" className="underline underline-offset-2"
                  onClick={() => onDistrictHint?.(hint.name)}>
            Change it to {hint.name}
          </button>
          , or leave it if you know better — this compares distance to district centres,
          not real boundaries.
        </p>
      )}

      {/* Kept, not deleted: the only keyboard-reachable path, and the right one
          for a coordinate that came from a survey. Collapsed because for most
          farmers it is the hardest of the three. */}
      <details className="mt-3" open={manual} onToggle={(e) => setManual(e.currentTarget.open)}>
        <summary className="cursor-pointer text-xs font-medium text-leaf-800">
          Enter coordinates by hand
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-4">
          <label className="block text-sm font-medium">
            Latitude
            <input
              type="number" step="any" required min={-90} max={90}
              value={lat} onChange={(e) => pick(e.target.value, lng, { recenter: false })}
              className="tnum mt-1.5 w-full rounded-xl border border-leaf-100 bg-card px-4 py-3
                         text-ink outline-none transition focus:border-leaf-400 focus:ring-4 focus:ring-leaf-400/15"
            />
          </label>
          <label className="block text-sm font-medium">
            Longitude
            <input
              type="number" step="any" required min={-180} max={180}
              value={lng} onChange={(e) => pick(lat, e.target.value, { recenter: false })}
              className="tnum mt-1.5 w-full rounded-xl border border-leaf-100 bg-card px-4 py-3
                         text-ink outline-none transition focus:border-leaf-400 focus:ring-4 focus:ring-leaf-400/15"
            />
          </label>
        </div>
        <button type="button" onClick={recentre}
                className="mt-2 text-xs text-leaf-800 underline underline-offset-2">
          Show these on the map
        </button>
      </details>
    </div>
  )
}
