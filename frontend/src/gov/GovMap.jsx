import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { OUTLINE_LATLNG, PUNJAB_BOUNDS, RIVERS } from './lib/geo'

/**
 * Leaflet choropleth over the district cells.
 *
 * Plain Leaflet in a useEffect rather than react-leaflet, even though
 * react-leaflet is already a dependency (the farmer portal's FarmMap uses it).
 * The reason is the data flow: every map here restyles 34 polygons from a
 * `fill(d)` function that changes whenever the crop, season or metric changes.
 * With react-leaflet that is 34 <Polygon> children whose props churn on every
 * selection; imperatively it is one setStyle pass. The design's own map was
 * written this way too, so porting it keeps the behaviour identical.
 *
 * The whole map is rebuilt when `data` or `fill` identity changes and torn down
 * on unmount -- Leaflet keeps DOM and event handlers outside React's tree, so a
 * missed remove() leaks the container and leaves a dead map behind on navigation.
 */
export default function GovMap({
  id, height = 400, data = [], fill, tip, onClick, selected,
  fillOpacity = 0.55, legend, badge, circles = [], points = [], allLabels = false,
}) {
  const host = useRef(null)
  const mapRef = useRef(null)
  const warnRef = useRef(null)

  useEffect(() => {
    if (!host.current) return
    const map = L.map(host.current, {
      zoomControl: false, attributionControl: false, scrollWheelZoom: false,
      minZoom: 6, maxZoom: 11, zoomSnap: 0.25,
    }).fitBounds(PUNJAB_BOUNDS, { padding: [6, 6] })
    mapRef.current = map

    L.control.zoom({ position: 'topright' }).addTo(map)
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map)

    const tiles = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 11, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }
    ).addTo(map)
    // Satellite tiles are a third-party service and do fail. Say so in place
    // rather than leaving the reader looking at bare polygons on a dark void
    // and wondering whether the data failed too.
    let warned = false
    tiles.on('tileerror', () => {
      if (!warned) { warned = true; warnRef.current?.classList.add('show') }
    })

    RIVERS.forEach(([name, pts]) =>
      L.polyline(pts.map((p) => [p[1], p[0]]),
        { color: '#7fb9e0', weight: 1.6, opacity: 0.75, interactive: false })
        .addTo(map).bindTooltip(name + ' (approx.)', { sticky: true })
    )

    // A row without geometry is skipped, not drawn. L.polygon(undefined) throws,
    // which takes the whole screen to the error boundary -- and a caller that
    // forgot districtCells() should lose its map, not its page.
    const drawable = data.filter((d) => Array.isArray(d.poly) && d.poly.length >= 3)
    if (drawable.length < data.length) {
      console.warn(`[gov map ${id}] ${data.length - drawable.length} district(s) had no `
        + 'geometry and were not drawn. Did the caller pass rows through districtCells()?')
    }

    drawable.forEach((d) => {
      const isSel = selected && selected === d.name
      const base = {
        color: isSel ? '#fff' : 'rgba(255,255,255,.7)',
        weight: isSel ? 2.5 : 0.8,
        // A district with no value for the current metric is drawn grey, not at
        // the bottom of the colour ramp. The ramp's low end means "low value";
        // grey means "no value", and conflating them turns missing data into a
        // province-wide alarm.
        fillColor: (fill && fill(d)) || '#8d9a92',
        fillOpacity,
      }
      const poly = L.polygon(d.poly, base).addTo(map)
      poly.bindTooltip(tip ? tip(d) : `<b>${d.name}</b>`, { sticky: true })
      poly.on('mouseover', () => { poly.setStyle({ weight: 2.2, color: '#fff' }); poly.bringToFront() })
      poly.on('mouseout', () => poly.setStyle({ weight: base.weight, color: base.color }))
      if (onClick) poly.on('click', () => onClick(d))
    })

    L.polygon(OUTLINE_LATLNG, { color: '#fff', weight: 2, fill: false, interactive: false }).addTo(map)

    drawable.forEach((d) => {
      if (d.label || allLabels) {
        L.marker([d.lat, d.lon], {
          icon: L.divIcon({ className: '', html: '', iconSize: [0, 0] }), interactive: false,
        }).addTo(map).bindTooltip(d.name, {
          permanent: true, direction: 'right', className: 'lab', offset: [2, 0],
        })
      }
    })

    circles.forEach((c) =>
      L.circle([c.lat, c.lng], {
        radius: c.r, color: c.c, weight: 1.5, fillColor: c.c, fillOpacity: 0.35,
      }).addTo(map).bindTooltip(c.tip, { sticky: true })
    )
    points.forEach((p) =>
      L.circleMarker([p.lat, p.lng], {
        radius: 5.5, color: '#fff', weight: 1.5, fillColor: p.c, fillOpacity: 1,
      }).addTo(map).bindTooltip(p.tip, { sticky: true })
    )

    // The container is sized by CSS, and Leaflet measures it on construction.
    // Inside a grid that has not settled yet that measurement is wrong and the
    // tiles tile at the wrong scale, so re-measure once after layout.
    const t = setTimeout(() => map.invalidateSize(), 60)

    return () => { clearTimeout(t); map.remove(); mapRef.current = null }
  }, [data, fill, tip, onClick, selected, fillOpacity, circles, points, allLabels])

  return (
    <div className="mapbox" style={{ height }}>
      <div ref={host} className="map" id={id} />
      {badge && <span className="mapbadge">{badge}</span>}
      {legend}
      <div ref={warnRef} className="tilewarn">
        Satellite basemap tiles could not load. District layers are unaffected.
      </div>
    </div>
  )
}
