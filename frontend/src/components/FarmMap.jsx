import { Fragment } from 'react'
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

/** Radius in metres of a circle of `ha` hectares.
 *
 * The same figure app/field.py reduces over: r = sqrt(A * 10000 / pi), so a
 * 1 ha field is a 56 m radius. The old map drew a flat 500 m ring, which was
 * a placeholder from before per-farm geometry existed and overstated every
 * field by a wide margin. Drawing the real footprint means the boundary on
 * screen is the boundary the indices were sampled from.
 */
export const radiusOf = (ha) => Math.sqrt((Number(ha) || 1) * 10_000 / Math.PI)

/** One or many farms on a satellite basemap.
 *
 * `farms` is a list so this serves both the single-farm panels and the Farms
 * page overview without a second component.
 */
export default function FarmMap({
  farms, height = 'h-[26rem]', zoom = 14, showBoundary = true, className = '',
}) {
  const list = (Array.isArray(farms) ? farms : [farms]).filter(
    (f) => f && f.gps_lat != null && f.gps_lng != null
  )
  if (!list.length) {
    return (
      <div className={`flex ${height} items-center justify-center rounded-xl bg-leaf-50 text-sm text-muted`}>
        No farm location to show.
      </div>
    )
  }
  // Centre on the mean pin so a multi-farm map frames them all rather than
  // sitting on whichever happened to be first.
  const center = [
    list.reduce((s, f) => s + Number(f.gps_lat), 0) / list.length,
    list.reduce((s, f) => s + Number(f.gps_lng), 0) / list.length,
  ]

  return (
    <MapContainer center={center} zoom={list.length > 1 ? 9 : zoom}
                  scrollWheelZoom={false}
                  className={`${height} w-full ${className}`}>
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

      {/* Fragment, not a div: react-leaflet mounts children into the map's own
          DOM, so a wrapper element lands inside the tile pane and sits over the
          map as an invisible blocker. */}
      {list.map((f) => (
        <Fragment key={f.id}>
          {showBoundary && (
            <Circle
              center={[f.gps_lat, f.gps_lng]}
              radius={radiusOf(f.area_hectares)}
              pathOptions={{ color: '#d9a441', weight: 2, fillColor: '#d9a441', fillOpacity: 0.12 }}
            />
          )}
          <Marker position={[f.gps_lat, f.gps_lng]}>
            <Popup>
              <span className="font-semibold">{f.farmer_name}</span>
              <br />
              {f.district} · {f.crop_type}
              {f.area_hectares ? ` · ${f.area_hectares} ha` : ''}
            </Popup>
          </Marker>
        </Fragment>
      ))}
    </MapContainer>
  )
}
